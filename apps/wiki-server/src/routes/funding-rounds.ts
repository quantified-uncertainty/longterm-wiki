import { Hono } from "hono";
import { z } from "zod";
import { eq, count, sql, desc } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import { fundingRounds } from "../schema.js";
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

const SyncFundingRoundItemSchema = z.object({
  id: z.string().length(10),
  companyId: z.string().min(1).max(200),
  name: z.string().min(1).max(500),
  date: z.string().max(20).nullable().optional(),
  raised: z.number().nullable().optional(),
  valuation: z.number().nullable().optional(),
  instrument: z.string().max(100).nullable().optional(),
  leadInvestor: z.string().max(500).nullable().optional(),
  source: z.string().max(2000).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});

const SyncFundingRoundsBatchSchema = z.object({
  items: z.array(SyncFundingRoundItemSchema).min(1).max(500),
});

// ---- Helpers ----

function formatRow(r: typeof fundingRounds.$inferSelect) {
  return {
    id: r.id,
    companyId: r.companyId,
    name: r.name,
    date: r.date,
    raised: r.raised != null ? Number(r.raised) : null,
    valuation: r.valuation != null ? Number(r.valuation) : null,
    instrument: r.instrument,
    leadInvestor: r.leadInvestor,
    source: r.source,
    notes: r.notes,
    syncedAt: r.syncedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// ---- Route definition (method-chained for Hono RPC type inference) ----

const fundingRoundsApp = new Hono()

  // ---- GET /stats ----
  .get("/stats", async (c) => {
    const db = getDrizzleDb();

    const [statsRow] = await db
      .select({
        total: count(),
        totalRaised: sql<number>`coalesce(sum(${fundingRounds.raised}), 0)`,
        uniqueCompanies: sql<number>`count(distinct ${fundingRounds.companyId})`,
      })
      .from(fundingRounds);

    return c.json({
      total: statsRow.total,
      totalRaised: Number(statsRow.totalRaised),
      uniqueCompanies: Number(statsRow.uniqueCompanies),
    });
  })

  // ---- GET /all ----
  .get("/all", zv("query", AllQuery), async (c) => {
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const rows = await db
      .select()
      .from(fundingRounds)
      .orderBy(desc(fundingRounds.syncedAt), fundingRounds.id)
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(fundingRounds);
    const total = countResult[0].count;

    return c.json({
      fundingRounds: rows.map(formatRow),
      total,
      limit,
      offset,
    });
  })

  // ---- GET /by-entity/:entityId ----
  .get("/by-entity/:entityId", zv("query", ByEntityQuery), async (c) => {
    const entityId = c.req.param("entityId");
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const rows = await db
      .select()
      .from(fundingRounds)
      .where(eq(fundingRounds.companyId, entityId))
      .orderBy(desc(fundingRounds.syncedAt), fundingRounds.id)
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(fundingRounds)
      .where(eq(fundingRounds.companyId, entityId));
    const total = countResult[0].count;

    return c.json({
      entityId,
      fundingRounds: rows.map(formatRow),
      total,
      limit,
      offset,
    });
  })

  // ---- POST /sync ----
  .post("/sync", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = SyncFundingRoundsBatchSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { items } = parsed.data;
    const db = getDrizzleDb();

    let upserted = 0;

    await db.transaction(async (tx) => {
      const allVals = items.map((item) => ({
        id: item.id,
        companyId: item.companyId,
        name: item.name,
        date: item.date ?? null,
        raised: item.raised != null ? String(item.raised) : null,
        valuation: item.valuation != null ? String(item.valuation) : null,
        instrument: item.instrument ?? null,
        leadInvestor: item.leadInvestor ?? null,
        source: item.source ?? null,
        notes: item.notes ?? null,
      }));

      await tx
        .insert(fundingRounds)
        .values(allVals)
        .onConflictDoUpdate({
          target: fundingRounds.id,
          set: {
            companyId: sql`excluded.company_id`,
            name: sql`excluded.name`,
            date: sql`excluded.date`,
            raised: sql`excluded.raised`,
            valuation: sql`excluded.valuation`,
            instrument: sql`excluded.instrument`,
            leadInvestor: sql`excluded.lead_investor`,
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

export const fundingRoundsRoute = fundingRoundsApp;
export type FundingRoundsRoute = typeof fundingRoundsApp;
