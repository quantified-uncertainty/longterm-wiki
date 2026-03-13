import { Hono } from "hono";
import { z } from "zod";
import { eq, and, count, asc, sql, isNotNull, lte } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import { facts, entities, resources } from "../schema.js";
import { checkRefsExist } from "./ref-check.js";
import { resolveEntityStableId } from "./entity-resolution.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  zv,
} from "./utils.js";
import { SyncFactsBatchSchema } from "../api-types.js";

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
    measure: f.measure,
    subject: f.subject,
    note: f.note,
    source: f.source,
    format: f.format,
    formatDivisor: f.formatDivisor,
    syncedAt: f.syncedAt,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
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

    // Resolve slug/numericId/stableId to stableId (facts.entity_id stores stableIds)
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

    // Resolve slug/numericId/stableId to stableId (facts.entity_id stores stableIds)
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

  // ---- POST /sync ----
  // Uses manual JSON parsing to preserve the "invalid_json" error code
  // for malformed request bodies.
  .post("/sync", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = SyncFactsBatchSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { facts: items } = parsed.data;
    const db = getDrizzleDb();

    // Validate entity references (facts now use stable IDs, not slugs)
    const entityIds = [...new Set(items.map((f) => f.entityId))];
    const missingEntities = await checkRefsExist(db, entities, entities.stableId, entityIds);
    if (missingEntities.length > 0) {
      return validationError(
        c,
        `Referenced entities not found: ${missingEntities.join(", ")}`
      );
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
