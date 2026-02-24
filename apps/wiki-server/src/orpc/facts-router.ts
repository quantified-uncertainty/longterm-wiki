/**
 * oRPC Router — Facts Module
 *
 * Implements the facts contract with database handlers.
 * Reuses the same Drizzle queries as the existing Hono REST routes.
 */

import { implement } from "@orpc/server";
import { eq, and, count, asc, sql, isNotNull, lte } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import { facts } from "../schema.js";
import { factsContract } from "./facts-contract.js";

// ---------------------------------------------------------------------------
// Helpers (shared with REST route)
// ---------------------------------------------------------------------------

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

function serializeFact(f: ReturnType<typeof formatFact>) {
  return {
    ...f,
    syncedAt: f.syncedAt instanceof Date ? f.syncedAt.toISOString() : String(f.syncedAt),
    createdAt: f.createdAt instanceof Date ? f.createdAt.toISOString() : String(f.createdAt),
    updatedAt: f.updatedAt instanceof Date ? f.updatedAt.toISOString() : String(f.updatedAt),
  };
}

// ---------------------------------------------------------------------------
// Implement contract
// ---------------------------------------------------------------------------

const os = implement(factsContract);

const byEntity = os.byEntity.handler(async ({ input }) => {
  const { entityId, limit, offset, measure } = input;
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

  return {
    entityId,
    facts: rows.map(formatFact).map(serializeFact),
    total,
    limit,
    offset,
  };
});

const timeseries = os.timeseries.handler(async ({ input }) => {
  const { entityId, measure, limit } = input;
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

  const formatted = rows.map(formatFact).map(serializeFact);
  return {
    entityId,
    measure,
    points: formatted,
    total: formatted.length,
  };
});

const stale = os.stale.handler(async ({ input }) => {
  const { olderThan, limit, offset } = input;
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

  return { facts: rows, total, limit, offset };
});

const list = os.list.handler(async ({ input }) => {
  const { limit, offset } = input;
  const db = getDrizzleDb();

  const rows = await db
    .select()
    .from(facts)
    .orderBy(asc(facts.entityId), asc(facts.factId))
    .limit(limit)
    .offset(offset);

  const countResult = await db.select({ count: count() }).from(facts);
  const total = countResult[0].count;

  return {
    facts: rows.map(formatFact).map(serializeFact),
    total,
    limit,
    offset,
  };
});

const statsHandler = os.stats.handler(async () => {
  const db = getDrizzleDb();

  const totalResult = await db.select({ count: count() }).from(facts);
  const total = totalResult[0].count;

  const entityCountResult = await db
    .select({ count: sql<number>`count(distinct ${facts.entityId})` })
    .from(facts);
  const uniqueEntities = Number(entityCountResult[0].count);

  const measureCountResult = await db
    .select({ count: sql<number>`count(distinct ${facts.measure})` })
    .from(facts)
    .where(isNotNull(facts.measure));
  const uniqueMeasures = Number(measureCountResult[0].count);

  return { total, uniqueEntities, uniqueMeasures };
});

const sync = os.sync.handler(async ({ input }) => {
  const { facts: items } = input;
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

  return { upserted };
});

// ---------------------------------------------------------------------------
// Assembled router
// ---------------------------------------------------------------------------

export const factsRouter = os.router({
  byEntity,
  timeseries,
  stale,
  list,
  stats: statsHandler,
  sync,
});

export type FactsRouter = typeof factsRouter;
