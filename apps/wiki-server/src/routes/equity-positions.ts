import { Hono } from "hono";
import { z } from "zod";
import { eq, count, desc, sql } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import { equityPositions } from "../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  zv,
} from "./utils.js";
import { upsertThingsInTx } from "./thing-sync.js";

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

const SyncEquityPositionItemSchema = z.object({
  id: z.string().length(10),
  companyId: z.string().min(1).max(200),
  holderId: z.string().min(1).max(200),
  stake: z.string().max(200).nullable().optional(),
  source: z.string().max(2000).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  asOf: z.string().max(20).nullable().optional(),
  validEnd: z.string().max(20).nullable().optional(),
});

const SyncEquityPositionsBatchSchema = z.object({
  items: z.array(SyncEquityPositionItemSchema).min(1).max(500),
});

// ---- Helpers ----

function formatRow(r: typeof equityPositions.$inferSelect) {
  return {
    id: r.id,
    companyId: r.companyId,
    holderId: r.holderId,
    stake: r.stake,
    source: r.source,
    notes: r.notes,
    asOf: r.asOf,
    validEnd: r.validEnd,
    syncedAt: r.syncedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// ---- Route definition (method-chained for Hono RPC type inference) ----

const equityPositionsApp = new Hono()

  // ---- GET /stats ----
  .get("/stats", async (c) => {
    const db = getDrizzleDb();

    const [statsRow] = await db
      .select({
        total: count(),
        uniqueCompanies: sql<number>`count(distinct ${equityPositions.companyId})`,
        uniqueHolders: sql<number>`count(distinct ${equityPositions.holderId})`,
      })
      .from(equityPositions);

    return c.json({
      total: statsRow.total,
      uniqueCompanies: Number(statsRow.uniqueCompanies),
      uniqueHolders: Number(statsRow.uniqueHolders),
    });
  })

  // ---- GET /all ----
  .get("/all", zv("query", AllQuery), async (c) => {
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const rows = await db
      .select()
      .from(equityPositions)
      .orderBy(desc(equityPositions.syncedAt), equityPositions.id)
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(equityPositions);
    const total = countResult[0].count;

    return c.json({
      equityPositions: rows.map(formatRow),
      total,
      limit,
      offset,
    });
  })

  // ---- GET /by-entity/:entityId (positions in a company) ----
  .get("/by-entity/:entityId", zv("query", ByEntityQuery), async (c) => {
    const entityId = c.req.param("entityId");
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const rows = await db
      .select()
      .from(equityPositions)
      .where(eq(equityPositions.companyId, entityId))
      .orderBy(desc(equityPositions.syncedAt), equityPositions.id)
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(equityPositions)
      .where(eq(equityPositions.companyId, entityId));
    const total = countResult[0].count;

    return c.json({
      entityId,
      equityPositions: rows.map(formatRow),
      total,
      limit,
      offset,
    });
  })

  // ---- GET /by-holder/:holderId ----
  .get("/by-holder/:holderId", zv("query", ByEntityQuery), async (c) => {
    const holderId = c.req.param("holderId");
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const rows = await db
      .select()
      .from(equityPositions)
      .where(eq(equityPositions.holderId, holderId))
      .orderBy(desc(equityPositions.syncedAt), equityPositions.id)
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ count: count() })
      .from(equityPositions)
      .where(eq(equityPositions.holderId, holderId));
    const total = countResult[0].count;

    return c.json({
      holderId,
      equityPositions: rows.map(formatRow),
      total,
      limit,
      offset,
    });
  })

  // ---- POST /sync ----
  .post("/sync", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = SyncEquityPositionsBatchSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { items } = parsed.data;
    const db = getDrizzleDb();

    let upserted = 0;

    await db.transaction(async (tx) => {
      const allVals = items.map((item) => ({
        id: item.id,
        companyId: item.companyId,
        holderId: item.holderId,
        stake: item.stake ?? null,
        source: item.source ?? null,
        notes: item.notes ?? null,
        asOf: item.asOf ?? null,
        validEnd: item.validEnd ?? null,
      }));

      await tx
        .insert(equityPositions)
        .values(allVals)
        .onConflictDoUpdate({
          target: equityPositions.id,
          set: {
            companyId: sql`excluded.company_id`,
            holderId: sql`excluded.holder_id`,
            stake: sql`excluded.stake`,
            source: sql`excluded.source`,
            notes: sql`excluded.notes`,
            asOf: sql`excluded.as_of`,
            validEnd: sql`excluded.valid_end`,
            syncedAt: sql`now()`,
            updatedAt: sql`now()`,
          },
        });

      // Dual-write to things table
      await upsertThingsInTx(
        tx,
        items.map((ep) => ({
          id: ep.id,
          thingType: "equity-position" as const,
          title: `${ep.holderId} stake in ${ep.companyId}`,
          sourceTable: "equity_positions",
          sourceId: ep.id,
          sourceUrl: ep.source,
        }))
      );

      upserted = allVals.length;
    });

    return c.json({ upserted });
  });

// ---- Exports ----

export const equityPositionsRoute = equityPositionsApp;
export type EquityPositionsRoute = typeof equityPositionsApp;
