import { Hono } from "hono";
import { z } from "zod";
import { eq, and, count, asc, sql, isNotNull, lte } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { facts, entities, resources } from "../../schema.js";
import { checkRefsExist } from "../shared/ref-check.js";
import { resolveEntityStableId } from "../shared/entity-resolution.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  dbError,
  zv,
} from "../shared/utils.js";
import { SyncFactsBatchSchema } from "../../api-types.js";
import { upsertThingsInTx } from "../shared/thing-sync.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 200;

// ---- Query schemas ----

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
    validEnd: f.validEnd,
    currency: f.currency,
    measure: f.measure,
    subject: f.subject,
    note: f.note,
    source: f.source,
    format: f.format,
    formatDivisor: f.formatDivisor,
    sourceQuote: f.sourceQuote,
    usdEquivalent: f.usdEquivalent,
    exchangeRate: f.exchangeRate,
    exchangeRateDate: f.exchangeRateDate,
    dollarYear: f.dollarYear,
    syncedAt: f.syncedAt,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  };
}

/**
 * Reconstruct a FactValue discriminated union from flat PG columns.
 */
function reconstructFactValue(row: typeof facts.$inferSelect) {
  switch (row.format) {
    case "number":
      return { type: "number" as const, value: row.numeric ?? 0 };
    case "text":
      return { type: "text" as const, value: row.value ?? "" };
    case "date":
      return { type: "date" as const, value: row.value ?? "" };
    case "boolean":
      return { type: "boolean" as const, value: row.value === "true" };
    case "ref":
      return { type: "ref" as const, value: row.value ?? "" };
    case "refs":
      return { type: "refs" as const, value: row.value ? row.value.split(", ") : [] };
    case "range":
      return { type: "range" as const, low: row.low ?? 0, high: row.high ?? 0 };
    case "min":
      return { type: "min" as const, value: row.numeric ?? 0 };
    case "json":
      return { type: "json" as const, value: row.value ? JSON.parse(row.value) : null };
    default:
      return { type: "text" as const, value: row.value ?? "" };
  }
}

/**
 * Convert a PG facts row into the KB Fact shape used by SerializedKB.
 * Omits `unit` (comes from Property) and `derivedFrom` (display-only, not stored in PG).
 */
function pgRowToFact(row: typeof facts.$inferSelect) {
  return {
    id: row.factId,
    subjectId: row.entityId,
    propertyId: row.measure ?? "",
    value: reconstructFactValue(row),
    ...(row.asOf != null && { asOf: row.asOf }),
    ...(row.validEnd != null && { validEnd: row.validEnd }),
    ...(row.source != null && { source: row.source }),
    ...(row.sourceQuote != null && { sourceQuote: row.sourceQuote }),
    ...(row.note != null && { notes: row.note }),
    ...(row.currency != null && { currency: row.currency }),
    ...(row.usdEquivalent != null && { usdEquivalent: row.usdEquivalent }),
    ...(row.exchangeRate != null && { exchangeRate: row.exchangeRate }),
    ...(row.exchangeRateDate != null && { exchangeRateDate: row.exchangeRateDate }),
    ...(row.dollarYear != null && { dollarYear: row.dollarYear }),
  };
}

// ---- Route definition (method-chained for Hono RPC type inference) ----

const factsApp = new Hono()

  // ---- GET /stats ----
  .get("/stats", async (c) => {
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
  })

  // ---- GET /stale ----
  .get("/stale", zv("query", StalenessQuery), async (c) => {
    const { olderThan, limit, offset } = c.req.valid("query");
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
  })

  // ---- GET /timeseries/:entityId ----
  .get("/timeseries/:entityId", zv("query", TimeseriesQuery), async (c) => {
    const rawId = c.req.param("entityId");

    const { measure, limit } = c.req.valid("query");
    const db = getDrizzleDb();

    // Resolve slug/wikiId/stableId to stableId (facts.entity_id stores stableIds)
    const entityId = await resolveEntityStableId(db, rawId) ?? rawId;

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
  })

  // ---- GET /by-entity/:entityId ----
  .get("/by-entity/:entityId", zv("query", ByEntityQuery), async (c) => {
    const rawId = c.req.param("entityId");

    const { limit, offset, measure } = c.req.valid("query");
    const db = getDrizzleDb();

    // Resolve slug/wikiId/stableId to stableId (facts.entity_id stores stableIds)
    const entityId = await resolveEntityStableId(db, rawId) ?? rawId;

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
  })

  // ---- GET /export ----
  // Returns all facts grouped by entityId, reconstructed into the KB Fact shape
  // (FactValue discriminated union). Used by build-data.mjs to read facts from
  // PG instead of YAML.
  .get("/export", async (c) => {
    const db = getDrizzleDb();

    const rows = await db.select().from(facts).orderBy(asc(facts.entityId), asc(facts.factId));

    const grouped: Record<string, object[]> = {};
    for (const row of rows) {
      const fact = pgRowToFact(row);
      if (!grouped[row.entityId]) grouped[row.entityId] = [];
      grouped[row.entityId].push(fact);
    }

    return c.json({ facts: grouped, total: rows.length });
  })

  // ---- POST /sync ----
  // Uses manual JSON parsing to preserve the "invalid_json" error code
  // for malformed request bodies.
  .post("/sync", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = SyncFactsBatchSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    let items = parsed.data.facts;
    const db = getDrizzleDb();

    // Validate entity references — skip facts whose entities don't exist in PG
    // rather than rejecting the entire batch. This allows syncing facts for
    // entities that ARE in PG while skipping those that haven't been synced yet.
    const entityIds = [...new Set(items.map((f) => f.entityId))];
    const missingEntities = await checkRefsExist(db, entities, entities.stableId, entityIds);
    if (missingEntities.length > 0) {
      const missingSet = new Set(missingEntities);
      const skipped = items.filter((f) => missingSet.has(f.entityId));
      items = items.filter((f) => !missingSet.has(f.entityId));
      console.warn(
        `[facts/sync] Skipping ${skipped.length} facts for ${missingEntities.length} missing entities: ${missingEntities.slice(0, 10).join(", ")}${missingEntities.length > 10 ? ` ... (+${missingEntities.length - 10} more)` : ""}`
      );
      if (items.length === 0) {
        return c.json({ upserted: 0, skipped: skipped.length });
      }
    }

    // Validate subject references (optional field, also points to entities).
    // Missing subjects are nulled out rather than rejecting the entire batch,
    // since sentinel values like "industry-average" are used in YAML but
    // aren't real entities in the DB.
    const subjectIds = [
      ...new Set(items.map((f) => f.subject).filter((s): s is string => s != null)),
    ];
    let missingSubjects: string[] = [];
    if (subjectIds.length > 0) {
      missingSubjects = await checkRefsExist(db, entities, entities.stableId, subjectIds);
      if (missingSubjects.length > 0) {
        console.warn(
          `Facts sync: nulling out ${missingSubjects.length} unresolved subject(s): ${missingSubjects.join(", ")}`
        );
        const missingSet = new Set(missingSubjects);
        for (const item of items) {
          if (item.subject && missingSet.has(item.subject)) {
            item.subject = null;
          }
        }
      }
    }

    let upserted = 0;

    try {
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
          validEnd: f.validEnd ?? null,
          currency: f.currency ?? null,
          measure: f.measure ?? null,
          subject: f.subject ?? null,
          note: f.note ?? null,
          source: f.source ?? null,
          format: f.format ?? null,
          formatDivisor: f.formatDivisor ?? null,
          sourceQuote: f.sourceQuote ?? null,
          usdEquivalent: f.usdEquivalent ?? null,
          exchangeRate: f.exchangeRate ?? null,
          exchangeRateDate: f.exchangeRateDate ?? null,
          dollarYear: f.dollarYear ?? null,
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
              validEnd: sql`excluded.valid_end`,
              currency: sql`excluded.currency`,
              measure: sql`excluded.measure`,
              subject: sql`excluded.subject`,
              note: sql`excluded.note`,
              source: sql`excluded.source`,
              format: sql`excluded.format`,
              formatDivisor: sql`excluded.format_divisor`,
              sourceQuote: sql`excluded.source_quote`,
              usdEquivalent: sql`excluded.usd_equivalent`,
              exchangeRate: sql`excluded.exchange_rate`,
              exchangeRateDate: sql`excluded.exchange_rate_date`,
              dollarYear: sql`excluded.dollar_year`,
              syncedAt: sql`now()`,
              updatedAt: sql`now()`,
            },
          });
        // Dual-write to things table
        const toFactThingKey = (entityId: string, factId: string) =>
          `${encodeURIComponent(entityId)}:${encodeURIComponent(factId)}`;

        await upsertThingsInTx(
          tx,
          items.map((f) => ({
            id: toFactThingKey(f.entityId, f.factId),
            thingType: "fact" as const,
            title: f.label || `${f.factId} for ${f.entityId}`,
            sourceTable: "facts",
            sourceId: toFactThingKey(f.entityId, f.factId),
            description: f.value
              ? `${f.label || f.factId}: ${f.value}`
              : f.numeric != null
                ? `${f.label || f.factId}: ${f.numeric}`
                : undefined,
          }))
        );

        upserted = allVals.length;
      });
    } catch (err) {
      return dbError(c, "facts sync", err, { factCount: items.length });
    }

    return c.json({ upserted });
  })

  // ---- GET /export ----
  // Returns all facts grouped by entity ID in a format approximating SerializedKB.facts.
  // Note: some Fact fields (derivedFrom, sourceQuote, usdEquivalent, etc.) are not
  // stored in PG and will be absent. See discussion #2950 for the PG-primary roadmap.
  .get("/export", async (c) => {
    const db = getDrizzleDb();

    // Select only columns used in the response (skip syncedAt, createdAt, updatedAt, id, label, formatDivisor)
    const allFacts = await db
      .select({
        entityId: facts.entityId,
        factId: facts.factId,
        value: facts.value,
        numeric: facts.numeric,
        low: facts.low,
        high: facts.high,
        asOf: facts.asOf,
        validEnd: facts.validEnd,
        currency: facts.currency,
        measure: facts.measure,
        source: facts.source,
        note: facts.note,
        format: facts.format,
      })
      .from(facts)
      .orderBy(asc(facts.entityId), asc(facts.asOf));

    // Group by entity ID
    const grouped: Record<string, Array<{
      id: string;
      subjectId: string;
      propertyId: string;
      value: { type: string; value: unknown; low?: number; high?: number };
      asOf: string | null;
      validEnd?: string | null;
      currency?: string | null;
      source: string | null;
      notes: string | null;
      measure?: string;
    }>> = {};

    for (const f of allFacts) {
      if (!grouped[f.entityId]) grouped[f.entityId] = [];

      // Reconstruct the Fact value shape from PG columns
      const inferredType = f.format ?? (f.numeric != null ? "number" : "text");
      const value: { type: string; value: unknown; low?: number; high?: number } = {
        type: inferredType,
        value: f.numeric != null ? f.numeric : f.value,
      };
      if (f.low != null) value.low = f.low;
      if (f.high != null) value.high = f.high;

      grouped[f.entityId].push({
        id: f.factId,
        subjectId: f.entityId,
        propertyId: f.measure ?? f.factId,
        value,
        asOf: f.asOf,
        ...(f.validEnd != null && { validEnd: f.validEnd }),
        ...(f.currency != null && { currency: f.currency }),
        source: f.source,
        notes: f.note,
        ...(f.measure && { measure: f.measure }),
      });
    }

    return c.json({
      facts: grouped,
      total: allFacts.length,
      entities: Object.keys(grouped).length,
    });
  });

// ---- Exports ----

/**
 * Facts route handler — mount at `/api/facts` in the main app.
 *
 * Also exports `FactsRoute` type for Hono RPC client type inference.
 * Clients import this type and use `hc<FactsRoute>(baseUrl)` to get
 * compile-time type-safe API calls with inferred request/response types.
 */
export const factsRoute = factsApp;
export type FactsRoute = typeof factsApp;
