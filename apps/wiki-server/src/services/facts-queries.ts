/**
 * Facts — Shared query helpers and constants
 *
 * Extracted from routes/facts.ts and orpc/facts-router.ts to eliminate
 * duplication. Both the REST and oRPC layers import from here.
 */

import { eq, and, count, asc, sql, isNotNull, lte } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import { facts } from "../schema.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_PAGE_SIZE = 200;

// ---------------------------------------------------------------------------
// Row formatting
// ---------------------------------------------------------------------------

export function formatFact(f: typeof facts.$inferSelect) {
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

/** Serialize Date fields to ISO strings for JSON transport. */
export function serializeFact(f: ReturnType<typeof formatFact>) {
  return {
    ...f,
    syncedAt:
      f.syncedAt instanceof Date ? f.syncedAt.toISOString() : String(f.syncedAt),
    createdAt:
      f.createdAt instanceof Date
        ? f.createdAt.toISOString()
        : String(f.createdAt),
    updatedAt:
      f.updatedAt instanceof Date
        ? f.updatedAt.toISOString()
        : String(f.updatedAt),
  };
}

// ---------------------------------------------------------------------------
// Query functions
// ---------------------------------------------------------------------------

export async function queryByEntity(params: {
  entityId: string;
  limit: number;
  offset: number;
  measure?: string;
}) {
  const { entityId, limit, offset, measure } = params;
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
}

export async function queryTimeseries(params: {
  entityId: string;
  measure: string;
  limit: number;
}) {
  const { entityId, measure, limit } = params;
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
}

export async function queryStale(params: {
  olderThan?: string;
  limit: number;
  offset: number;
}) {
  const { olderThan, limit, offset } = params;
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
}

export async function queryList(params: { limit: number; offset: number }) {
  const { limit, offset } = params;
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
}

export async function queryStats() {
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
}

export async function syncFacts(
  items: Array<{
    entityId: string;
    factId: string;
    label?: string | null;
    value?: string | null;
    numeric?: number | null;
    low?: number | null;
    high?: number | null;
    asOf?: string | null;
    measure?: string | null;
    subject?: string | null;
    note?: string | null;
    source?: string | null;
    sourceResource?: string | null;
    format?: string | null;
    formatDivisor?: number | null;
  }>
) {
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
}
