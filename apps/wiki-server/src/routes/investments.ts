import { Hono } from "hono";
import { z } from "zod";
import { eq, count, sql, desc } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import { investments } from "../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  zv,
} from "./utils.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 200;

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

function formatRow(r: typeof investments.$inferSelect) {
  return {
    id: r.id,
    companyId: r.companyId,
    investorId: r.investorId,
    roundName: r.roundName,
    date: r.date,
    amount: r.amount != null ? Number(r.amount) : null,
    stakeAcquired: r.stakeAcquired,
    instrument: r.instrument,
    role: r.role,
    conditions: r.conditions,
    source: r.source,
    notes: r.notes,
    syncedAt: r.syncedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
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
      .select()
      .from(investments)
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
      .select()
      .from(investments)
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
      .select()
      .from(investments)
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

    let upserted = 0;

    await db.transaction(async (tx) => {
      const allVals = items.map((item) => ({
        id: item.id,
        companyId: item.companyId,
        investorId: item.investorId,
        roundName: item.roundName ?? null,
        date: item.date ?? null,
        amount: item.amount != null ? String(item.amount) : null,
        stakeAcquired: item.stakeAcquired ?? null,
        instrument: item.instrument ?? null,
        role: item.role ?? null,
        conditions: item.conditions ?? null,
        source: item.source ?? null,
        notes: item.notes ?? null,
      }));

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
            stakeAcquired: sql`excluded.stake_acquired`,
            instrument: sql`excluded.instrument`,
            role: sql`excluded.role`,
            conditions: sql`excluded.conditions`,
            source: sql`excluded.source`,
            notes: sql`excluded.notes`,
            syncedAt: sql`now()`,
            updatedAt: sql`now()`,
          },
        });
      upserted = allVals.length;
    });

    return c.json({ upserted });
  });

// ---- Exports ----

export const investmentsRoute = investmentsApp;
export type InvestmentsRoute = typeof investmentsApp;
