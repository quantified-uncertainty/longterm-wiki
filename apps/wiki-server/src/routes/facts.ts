import { Hono } from "hono";
import { z } from "zod";
import { eq, and, count, asc, sql, isNotNull, lte } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import { facts, entities, resources } from "../schema.js";
import { checkRefsExist } from "./ref-check.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
} from "./utils.js";
import { SyncFactsBatchSchema } from "../api-types.js";
import {
  MAX_PAGE_SIZE,
  queryByEntity,
  queryTimeseries,
  queryStale,
  queryList,
  queryStats,
  syncFacts,
} from "../services/facts-queries.js";

export const factsRoute = new Hono();

// ---- Schemas (query-string validation) ----

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

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---- GET /stats ----

factsRoute.get("/stats", async (c) => {
  return c.json(await queryStats());
});

// ---- GET /list ----

factsRoute.get("/list", async (c) => {
  const parsed = ListQuery.safeParse(c.req.query());
  if (!parsed.success) return validationError(c, parsed.error.message);
  return c.json(await queryList(parsed.data));
});

// ---- GET /stale ----

factsRoute.get("/stale", async (c) => {
  const parsed = StalenessQuery.safeParse(c.req.query());
  if (!parsed.success) return validationError(c, parsed.error.message);
  return c.json(await queryStale(parsed.data));
});

// ---- GET /timeseries/:entityId ----

factsRoute.get("/timeseries/:entityId", async (c) => {
  const entityId = c.req.param("entityId");
  if (!entityId) return validationError(c, "Entity ID is required");

  const parsed = TimeseriesQuery.safeParse(c.req.query());
  if (!parsed.success) return validationError(c, parsed.error.message);

  return c.json(
    await queryTimeseries({
      entityId,
      measure: parsed.data.measure,
      limit: parsed.data.limit,
    })
  );
});

// ---- GET /by-entity/:entityId ----

factsRoute.get("/by-entity/:entityId", async (c) => {
  const entityId = c.req.param("entityId");
  if (!entityId) return validationError(c, "Entity ID is required");

  const parsed = ByEntityQuery.safeParse(c.req.query());
  if (!parsed.success) return validationError(c, parsed.error.message);

  return c.json(
    await queryByEntity({
      entityId,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
      measure: parsed.data.measure,
    })
  );
});

// ---- POST /sync ----

factsRoute.post("/sync", async (c) => {
  const body = await parseJsonBody(c);
  if (!body) return invalidJsonError(c);

  const parsed = SyncFactsBatchSchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { facts: items } = parsed.data;
  const db = getDrizzleDb();

  // Validate entity references
  const entityIds = [...new Set(items.map((f) => f.entityId))];
  const missingEntities = await checkRefsExist(db, entities, entities.id, entityIds);
  if (missingEntities.length > 0) {
    return validationError(
      c,
      `Referenced entities not found: ${missingEntities.join(", ")}`
    );
  }

  // Validate subject references (optional field, also points to entities)
  const subjectIds = [
    ...new Set(items.map((f) => f.subject).filter((s): s is string => s != null)),
  ];
  if (subjectIds.length > 0) {
    const missingSubjects = await checkRefsExist(db, entities, entities.id, subjectIds);
    if (missingSubjects.length > 0) {
      return validationError(
        c,
        `Referenced subject entities not found: ${missingSubjects.join(", ")}`
      );
    }
  }

  // Validate sourceResource references (optional field, points to resources)
  const resourceIds = [
    ...new Set(
      items.map((f) => f.sourceResource).filter((r): r is string => r != null)
    ),
  ];
  if (resourceIds.length > 0) {
    const missingResources = await checkRefsExist(
      db,
      resources,
      resources.id,
      resourceIds
    );
    if (missingResources.length > 0) {
      return validationError(
        c,
        `Referenced resources not found: ${missingResources.join(", ")}`
      );
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