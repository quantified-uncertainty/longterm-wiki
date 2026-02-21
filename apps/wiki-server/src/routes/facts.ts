import { Hono } from "hono";
import { z } from "zod";
import { eq, and, count, asc, sql, isNotNull, lte } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import { facts } from "../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
} from "./utils.js";
import {
  SyncFactSchema as SharedSyncFactSchema,
  SyncFactsBatchSchema,
} from "../api-types.js";

export const factsRoute = new Hono();

// ---- Constants ----

const MAX_PAGE_SIZE = 200;

// ---- Schemas (from shared api-types) ----

const SyncFactSchema = SharedSyncFactSchema;
const SyncBatchSchema = SyncFactsBatchSchema;

const ByEntityQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  measure: z.string().max(100).optional(),
});

const TimeseriesQuery = z.object({
  measure: z.string().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const StalenessQuery = z.object({
  olderThan: z.string().max(20).optional(), // e.g. "2025-01" — facts with asOf before this
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---- Helpers ----

function formatFact(f: typeof facts.$inferSelect) {
  return {
    id: f.id,
    entityId: f.entityId,
    factId: f.factId,
    label: f.label,
    value: f.value,
    numeric: f.numeric,
    low: f.low,
    high: f.high,
    asOf: f.asOf,
    measure: f.measure,
    subject: f.subject,
    note: f.note,
    source: f.source,
    sourceResource: f.sourceResource,
    format: f.format,
    formatDivisor: f.formatDivisor,
    syncedAt: f.syncedAt,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  };
}

// ---- GET /stats ----

factsRoute.get("/stats", async (c) => {
  const db = getDrizzleDb();

  const totalResult = await db.select({ count: count() }).from(facts);
  const total = totalResult[0].count;

  const entityCountResult = await db
    .select({
      count: sql<number>`count(distinct ${facts.entityId})`,
    })
    .from(facts);
  const uniqueEntities = Number(entityCountResult[0].count);

  const measureCountResult = await db
    .select({
      count: sql<number>`count(distinct ${facts.measure})`,
    })
    .from(facts)
    .where(isNotNull(facts.measure));
  const uniqueMeasures = Number(measureCountResult[0].count);

  return c.json({
    total,
    uniqueEntities,
    uniqueMeasures,
  });
});

// ---- GET /stale ----

factsRoute.get("/stale", async (c) => {
  const parsed = StalenessQuery.safeParse(c.req.query());
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { olderThan, limit, offset } = parsed.data;
  const db = getDrizzleDb();

  const conditions = [isNotNull(facts.asOf)];
  if (olderThan) {
    conditions.push(lte(facts.asOf, olderThan));
  }

  const whereClause = and(...conditions);

  const rows = await db
    .select({
      entityId: facts.entityId,
      factId: facts.factId,
      label: facts.label,
      asOf: facts.asOf,
      measure: facts.measure,
      value: facts.value,
      numeric: facts.numeric,
    })
    .from(facts)
    .where(whereClause)
    .orderBy(asc(facts.asOf))
    .limit(limit)
    .offset(offset);

  const countResult = await db
    .select({ count: count() })
    .from(facts)
    .where(whereClause);
  const total = countResult[0].count;

  return c.json({ facts: rows, total, limit, offset });
});

// ---- GET /timeseries/:entityId ----

factsRoute.get("/timeseries/:entityId", async (c) => {
  const entityId = c.req.param("entityId");
  if (!entityId) return validationError(c, "Entity ID is required");

  const parsed = TimeseriesQuery.safeParse(c.req.query());
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { measure, limit } = parsed.data;
  const db = getDrizzleDb();

  const rows = await db
    .select()
    .from(facts)
    .where(
      and(
        eq(facts.entityId, entityId),
        eq(facts.measure, measure),
        isNotNull(facts.asOf)
      )
    )
    .orderBy(asc(facts.asOf))
    .limit(limit);

  return c.json({
    entityId,
    measure,
    points: rows.map(formatFact),
    total: rows.length,
  });
});

// ---- GET /by-entity/:entityId ----

factsRoute.get("/by-entity/:entityId", async (c) => {
  const entityId = c.req.param("entityId");
  if (!entityId) return validationError(c, "Entity ID is required");

  const parsed = ByEntityQuery.safeParse(c.req.query());
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { limit, offset, measure } = parsed.data;
  const db = getDrizzleDb();

  const conditions = [eq(facts.entityId, entityId)];
  if (measure) conditions.push(eq(facts.measure, measure));

  const whereClause = and(...conditions);

  const rows = await db
    .select()
    .from(facts)
    .where(whereClause)
    .orderBy(asc(facts.factId))
    .limit(limit)
    .offset(offset);

  const countResult = await db
    .select({ count: count() })
    .from(facts)
    .where(whereClause);
  const total = countResult[0].count;

  return c.json({
    entityId,
    facts: rows.map(formatFact),
    total,
    limit,
    offset,
  });
});

// ---- POST /sync ----

factsRoute.post("/sync", async (c) => {
  const body = await parseJsonBody(c);
  if (!body) return invalidJsonError(c);

  const parsed = SyncBatchSchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { facts: items } = parsed.data;
  const db = getDrizzleDb();
  let upserted = 0;

  await db.transaction(async (tx) => {
    const allVals = items.map((f) => ({
      entityId: f.entityId,
      factId: f.factId,
      label: f.label ?? null,
      value: f.value ?? null,
      numeric: f.numeric ?? null,
      low: f.low ?? null,
      high: f.high ?? null,
      asOf: f.asOf ?? null,
      measure: f.measure ?? null,
      subject: f.subject ?? null,
      note: f.note ?? null,
      source: f.source ?? null,
      sourceResource: f.sourceResource ?? null,
      format: f.format ?? null,
      formatDivisor: f.formatDivisor ?? null,
    }));

    await tx
      .insert(facts)
      .values(allVals)
      .onConflictDoUpdate({
        target: [facts.entityId, facts.factId],
        set: {
          label: sql`excluded.label`,
          value: sql`excluded.value`,
          numeric: sql`excluded.numeric`,
          low: sql`excluded.low`,
          high: sql`excluded.high`,
          asOf: sql`excluded.as_of`,
          measure: sql`excluded.measure`,
          subject: sql`excluded.subject`,
          note: sql`excluded.note`,
          source: sql`excluded.source`,
          sourceResource: sql`excluded.source_resource`,
          format: sql`excluded.format`,
          formatDivisor: sql`excluded.format_divisor`,
          syncedAt: sql`now()`,
          updatedAt: sql`now()`,
        },
      });
    upserted = allVals.length;
  });

  return c.json({ upserted });
});
