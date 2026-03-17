import { Hono } from "hono";
import { z } from "zod";
import { eq, count, sql, desc } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDrizzleDb } from "../../db.js";
import { investments, entities } from "../../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  zv,
  parseRange,
} from "../shared/utils.js";
import { upsertThingsInTx } from "../shared/thing-sync.js";
import { validateEntityRefs } from "../shared/validate-entity-refs.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 200;

/** Matches stableIds: exactly 10 alphanumeric chars with at least one uppercase letter. */
const STABLE_ID_PATTERN = /^(?=.*[A-Z])[A-Za-z0-9]{10}$/;

// ---- Query schemas ----

const ByEntityQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const AllQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---- Sync schema ----

const SyncInvestmentItemSchema = z.object({
  id: z.string().length(10),
  companyId: z.string().min(1).max(200),
  investorId: z.string().min(1).max(200),
  roundName: z.string().max(500).nullable().optional(),
  date: z.string().max(20).nullable().optional(),
  amount: z.number().nullable().optional(),
  stakeAcquired: z.string().max(200).nullable().optional(),
  instrument: z.string().max(100).nullable().optional(),
  role: z.string().max(50).nullable().optional(),
  conditions: z.string().max(2000).nullable().optional(),
  source: z.string().max(2000).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});

const SyncInvestmentsBatchSchema = z.object({
  items: z.array(SyncInvestmentItemSchema).min(1).max(500),
});

// ---- Helpers ----

const investorEntity = alias(entities, "investor_entity");
const companyEntity = alias(entities, "company_entity");

/** Selection shape for investments + joined entity titles. */
const joinedSelect = {
  investments: investments,
  investorTitle: investorEntity.title,
  companyTitle: companyEntity.title,
};

interface JoinedRow {
  investments: typeof investments.$inferSelect;
  investorTitle: string | null;
  companyTitle: string | null;
}

function cleanId(id: string): string | null {
  if (STABLE_ID_PATTERN.test(id)) return null;
  return id;
}

function formatRow(r: JoinedRow) {
  const inv = r.investments;
  return {
    id: inv.id,
    companyId: inv.companyId,
    investorId: inv.investorId,
    roundName: inv.roundName,
    date: inv.date,
    amount: inv.amount != null ? Number(inv.amount) : null,
    amountLow: inv.amountLow != null ? Number(inv.amountLow) : null,
    amountHigh: inv.amountHigh != null ? Number(inv.amountHigh) : null,
    stakeAcquired: inv.stakeAcquired,
    stakeLow: inv.stakeLow != null ? Number(inv.stakeLow) : null,
    stakeHigh: inv.stakeHigh != null ? Number(inv.stakeHigh) : null,
    instrument: inv.instrument,
    role: inv.role,
    conditions: inv.conditions,
    source: inv.source,
    notes: inv.notes,
    investorEntityId: inv.investorEntityId,
    investorDisplayName: inv.investorDisplayName,
    companyEntityId: inv.companyEntityId,
    companyDisplayName: inv.companyDisplayName,
    // Resolved names — prefer entity title, then display name, then cleaned raw ID
    investorResolvedName: r.investorTitle ?? inv.investorDisplayName ?? cleanId(inv.investorId),
    companyResolvedName: r.companyTitle ?? inv.companyDisplayName ?? cleanId(inv.companyId),
    syncedAt: inv.syncedAt,
    createdAt: inv.createdAt,
    updatedAt: inv.updatedAt,
  };
}

// ---- Route definition (method-chained for Hono RPC type inference) ----

const investmentsApp = new Hono()

  // ---- GET /stats ----
  .get("/stats", async (c) => {
    const db = getDrizzleDb();

    const [statsRow] = await db
      .select({
        total: count(),
        totalAmount: sql<number>`coalesce(sum(${investments.amount}), 0)`,
        uniqueCompanies: sql<number>`count(distinct ${investments.companyId})`,
        uniqueInvestors: sql<number>`count(distinct ${investments.investorId})`,
      })
      .from(investments);

    return c.json({
      total: statsRow.total,
      totalAmount: Number(statsRow.totalAmount),
      uniqueCompanies: Number(statsRow.uniqueCompanies),
      uniqueInvestors: Number(statsRow.uniqueInvestors),
    });
  })

  // ---- GET /all ----
  .get("/all", zv("query", AllQuery), async (c) => {
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const rows = await db
      .select(joinedSelect)
      .from(investments)
      .leftJoin(investorEntity, eq(investments.investorEntityId, investorEntity.stableId))
      .leftJoin(companyEntity, eq(investments.companyEntityId, companyEntity.stableId))
      .orderBy(desc(investments.syncedAt), investments.id)
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(investments);
    const total = countResult[0].count;

    return c.json({
      investments: rows.map(formatRow),
      total,
      limit,
      offset,
    });
  })

  // ---- GET /by-entity/:entityId (investments in a company) ----
  .get("/by-entity/:entityId", zv("query", ByEntityQuery), async (c) => {
    const entityId = c.req.param("entityId");
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const rows = await db
      .select(joinedSelect)
      .from(investments)
      .leftJoin(investorEntity, eq(investments.investorEntityId, investorEntity.stableId))
      .leftJoin(companyEntity, eq(investments.companyEntityId, companyEntity.stableId))
      .where(eq(investments.companyId, entityId))
      .orderBy(desc(investments.syncedAt), investments.id)
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(investments)
      .where(eq(investments.companyId, entityId));
    const total = countResult[0].count;

    return c.json({
      entityId,
      investments: rows.map(formatRow),
      total,
      limit,
      offset,
    });
  })

  // ---- GET /by-investor/:investorId ----
  .get("/by-investor/:investorId", zv("query", ByEntityQuery), async (c) => {
    const investorId = c.req.param("investorId");
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const rows = await db
      .select(joinedSelect)
      .from(investments)
      .leftJoin(investorEntity, eq(investments.investorEntityId, investorEntity.stableId))
      .leftJoin(companyEntity, eq(investments.companyEntityId, companyEntity.stableId))
      .where(eq(investments.investorId, investorId))
      .orderBy(desc(investments.syncedAt), investments.id)
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(investments)
      .where(eq(investments.investorId, investorId));
    const total = countResult[0].count;

    return c.json({
      investorId,
      investments: rows.map(formatRow),
      total,
      limit,
      offset,
    });
  })

  // ---- POST /sync ----
  .post("/sync", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = SyncInvestmentsBatchSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { items } = parsed.data;
    const db = getDrizzleDb();

    // Validate entity FK references before inserting
    const refError = await validateEntityRefs(c, db, [
      { fieldName: "companyId", ids: items.map((i) => i.companyId) },
      { fieldName: "investorId", ids: items.map((i) => i.investorId) },
    ]);
    if (refError) return refError;

    let upserted = 0;

    await db.transaction(async (tx) => {
      const allVals = items.map((item) => {
        const amountRange = parseRange(item.amount);
        const stakeRange = parseRange(item.stakeAcquired);
        return {
          id: item.id,
          companyId: item.companyId,
          investorId: item.investorId,
          roundName: item.roundName ?? null,
          date: item.date ?? null,
          amount: item.amount != null ? String(item.amount) : null,
          amountLow: amountRange.low,
          amountHigh: amountRange.high,
          stakeAcquired: item.stakeAcquired ?? null,
          stakeLow: stakeRange.low,
          stakeHigh: stakeRange.high,
          instrument: item.instrument ?? null,
          role: item.role ?? null,
          conditions: item.conditions ?? null,
          source: item.source ?? null,
          notes: item.notes ?? null,
        };
      });

      await tx
        .insert(investments)
        .values(allVals)
        .onConflictDoUpdate({
          target: investments.id,
          set: {
            companyId: sql`excluded.company_id`,
            investorId: sql`excluded.investor_id`,
            roundName: sql`excluded.round_name`,
            date: sql`excluded.date`,
            amount: sql`excluded.amount`,
            amountLow: sql`excluded.amount_low`,
            amountHigh: sql`excluded.amount_high`,
            stakeAcquired: sql`excluded.stake_acquired`,
            stakeLow: sql`excluded.stake_low`,
            stakeHigh: sql`excluded.stake_high`,
            instrument: sql`excluded.instrument`,
            role: sql`excluded.role`,
            conditions: sql`excluded.conditions`,
            source: sql`excluded.source`,
            notes: sql`excluded.notes`,
            syncedAt: sql`now()`,
            updatedAt: sql`now()`,
          },
        });

      // Dual-write to things table
      await upsertThingsInTx(
        tx,
        items.map((i) => ({
          id: i.id,
          thingType: "investment" as const,
          title: `${i.investorId} → ${i.companyId}${i.roundName ? ` (${i.roundName})` : ""}`,
          sourceTable: "investments",
          sourceId: i.id,
          sourceUrl: i.source,
        }))
      );

      upserted = allVals.length;
    });

    return c.json({ upserted });
  });

// ---- Exports ----

export const investmentsRoute = investmentsApp;
export type InvestmentsRoute = typeof investmentsApp;
