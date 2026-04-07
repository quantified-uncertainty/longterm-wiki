import { Hono } from "hono";
import { z } from "zod";
import { eq, count, sql, desc } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDrizzleDb, getDb } from "../../db.js";
import { logger } from "../../logger.js";
import { investments, entities } from "../../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  zv,
  parseRange,
  noDuplicateIds,
  clampedLimit,
} from "../shared/utils.js";
import { upsertThingsInTx } from "../shared/thing-sync.js";
import { resolveEntityFKs } from "../shared/resolve-entity-fks.js";
import { validateEntityRefs } from "../shared/validate-entity-refs.js";
import { resolveEntityId, type ResolvedEntityVars } from "../shared/resolve-entity-middleware.js";
import { formatEntityRef } from "../shared/entity-ref.js";
import { InlineVerificationSchema } from "./verification-schema.js";
import { writeInlineVerdicts, logVerificationCoverage } from "./write-inline-verdicts.js";
import { validateClaimRefs, linkClaimsToRecords } from "../shared/validate-claims.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 200;

// ---- Query schemas ----

const ByEntityQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 100),
  offset: z.coerce.number().int().min(0).default(0),
});

const AllQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 200),
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
  sourceResourceId: z.string().max(200).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  verification: InlineVerificationSchema.optional(),
  claimIds: z.array(z.number().int().positive()).optional(),
});

const SyncInvestmentsBatchSchema = z.object({
  items: z
    .array(SyncInvestmentItemSchema)
    .min(1)
    .max(500)
    .refine(noDuplicateIds, { message: "Duplicate id values in items array" }),
});

// ---- Helpers ----

const investorEntity = alias(entities, "investor_entity");
const companyEntity = alias(entities, "company_entity");

/** Selection shape for investments + joined entity titles + slugs. */
const joinedSelect = {
  investments: investments,
  investorTitle: investorEntity.title,
  investorSlug: investorEntity.id,
  companyTitle: companyEntity.title,
  companySlug: companyEntity.id,
};

interface JoinedRow {
  investments: typeof investments.$inferSelect;
  investorTitle: string | null;
  investorSlug: string | null;
  companyTitle: string | null;
  companySlug: string | null;
}

function formatRow(r: JoinedRow) {
  const inv = r.investments;
  const investorRef = formatEntityRef(inv.investorEntityId, r.investorSlug, r.investorTitle, inv.investorDisplayName, inv.investorId);
  const companyRef = formatEntityRef(inv.companyEntityId, r.companySlug, r.companyTitle, inv.companyDisplayName, inv.companyId);
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
    sourceResourceId: inv.sourceResourceId,
    notes: inv.notes,
    // Structured entity refs
    investor: investorRef,
    company: companyRef,
    // Legacy flat fields (for backward compat)
    investorEntityId: inv.investorEntityId,
    investorDisplayName: inv.investorDisplayName,
    investorResolvedName: investorRef.name,
    companyEntityId: inv.companyEntityId,
    companyDisplayName: inv.companyDisplayName,
    companyResolvedName: companyRef.name,
    syncedAt: inv.syncedAt,
    createdAt: inv.createdAt,
    updatedAt: inv.updatedAt,
  };
}

// ---- Route definition (method-chained for Hono RPC type inference) ----

const investmentsApp = new Hono<{ Variables: ResolvedEntityVars }>()

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
  .get("/by-entity/:entityId", resolveEntityId(), zv("query", ByEntityQuery), async (c) => {
    const resolvedId = c.get("resolvedEntityId");
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();
    const rows = await db
      .select(joinedSelect)
      .from(investments)
      .leftJoin(investorEntity, eq(investments.investorEntityId, investorEntity.stableId))
      .leftJoin(companyEntity, eq(investments.companyEntityId, companyEntity.stableId))
      .where(eq(investments.companyId, resolvedId))
      .orderBy(desc(investments.syncedAt), investments.id)
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(investments)
      .where(eq(investments.companyId, resolvedId));
    const total = countResult[0].count;

    return c.json({
      entityId: resolvedId,
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

    // Check for natural key collisions within the batch itself.
    // Natural key: (companyId, investorId, roundName)
    const batchKeys = new Set<string>();
    for (const item of items) {
      const key = `${item.companyId}::${item.investorId}::${item.roundName ?? ""}`;
      if (batchKeys.has(key)) {
        return validationError(
          c,
          `Duplicate (companyId, investorId, roundName) in batch: ` +
          `companyId=${item.companyId}, investorId=${item.investorId}, ` +
          `roundName="${item.roundName ?? ""}". ` +
          `Each investment must be unique by company + investor + round.`
        );
      }
      batchKeys.add(key);
    }

    // Validate entity FK references before inserting
    const refError = await validateEntityRefs(c, db, [
      { fieldName: "companyId", ids: items.map((i) => i.companyId) },
      { fieldName: "investorId", ids: items.map((i) => i.investorId) },
    ]);
    if (refError) return refError;

    // Validate claim references
    const allClaimIds = items.flatMap((i) => i.claimIds ?? []);
    if (allClaimIds.length > 0) {
      const rawDb = getDb();
      const claimError = await validateClaimRefs(rawDb, allClaimIds);
      if (claimError) return validationError(c, claimError);
    }

    let upserted = 0;
    let verdictsResult = { written: 0 };

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
        sourceResourceId: item.sourceResourceId ?? null,
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
            sourceResourceId: sql`excluded.source_resource_id`,
            notes: sql`excluded.notes`,
            syncedAt: sql`now()`,
            updatedAt: sql`now()`,
          },
        });

      // Post-sync: resolve entity FKs for newly synced rows
      await resolveEntityFKs(tx, {
        tableName: "investments",
        fields: [
          { rawIdColumn: "company_id", entityIdColumn: "company_entity_id", displayNameColumn: "company_display_name", entityTypeFilter: "organization" },
          { rawIdColumn: "investor_id", entityIdColumn: "investor_entity_id", displayNameColumn: "investor_display_name" },
        ],
        scopeIds: items.map((i) => i.id),
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

      // Write inline verification verdicts atomically within the same transaction
      verdictsResult = await writeInlineVerdicts(
        tx,
        items.map((item) => ({
          recordType: "investment",
          recordId: item.id,
          entityId: item.companyId,
          sourceUrl: item.source ?? null,
          verification: item.verification ?? null,
        }))
      );

      upserted = allVals.length;
    });

    logVerificationCoverage("investments/sync", items.length, verdictsResult.written);

    // Link verified claims to records (best-effort — records already committed)
    let claimsLinked = 0;
    if (allClaimIds.length > 0) {
      try {
        const rawDb = getDb();
        const linkResult = await linkClaimsToRecords(rawDb, items.map((item) => ({
          recordId: item.id,
          recordType: "investments",
          claimIds: item.claimIds,
        })));
        claimsLinked = linkResult.linked;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.warn({ error: msg }, "claim linking failed (records already committed)");
      }
    }

    return c.json({ upserted, verdictsWritten: verdictsResult.written, claimsLinked });
  });

// ---- Exports ----

export const investmentsRoute = investmentsApp;
export type InvestmentsRoute = typeof investmentsApp;
