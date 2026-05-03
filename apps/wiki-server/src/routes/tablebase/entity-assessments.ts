import { Hono } from "hono";
import { z } from "zod";
import { eq, count } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { entityAssessments } from "../../schema.js";
import {
  zv,
  clampedLimit,
} from "../shared/utils.js";
import {
  resolveEntityId,
  type ResolvedEntityVars,
} from "../shared/resolve-entity-middleware.js";
import { deleteBatchHandler } from "../shared/delete-batch.js";
import { paginatedQuery } from "../shared/paginated-query.js";
import { bulkQuery } from "../shared/bulk-query.js";
import { createSyncHandler } from "./sync-factory.js";

// ---- Constants ----

const MAX_PAGE_SIZE = 200;

const VALID_ASSESSORS = [
  "editorial",
  "llm",
  "community",
  "external",
] as const;

// ---- Schemas ----

const AllQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 200),
  offset: z.coerce.number().int().min(0).default(0),
});

const ByEntityQuery = z.object({
  limit: clampedLimit(MAX_PAGE_SIZE, 100),
  offset: z.coerce.number().int().min(0).default(0),
});

const SyncItemSchema = z.object({
  id: z.string().length(10),
  entityId: z.string().min(1).max(200),
  dimension: z.string().min(1).max(200),
  rating: z.string().min(1).max(1000),
  evidence: z.string().max(5000).nullable().optional(),
  assessor: z.enum(VALID_ASSESSORS).default("editorial"),
  assessedAt: z.string().max(10).nullable().optional(), // YYYY-MM-DD
  source: z.string().max(2000).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});

// ---- Route ----

const entityAssessmentsApp = new Hono<{ Variables: ResolvedEntityVars }>()

  .get("/stats", async (c) => {
    const db = getDrizzleDb();
    const [statsRow] = await db
      .select({ total: count() })
      .from(entityAssessments);
    return c.json({ total: statsRow.total });
  })

  .get("/all", zv("query", AllQuery), async (c) => {
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();
    const { rows: assessments, total } = await paginatedQuery({
      query: db.select().from(entityAssessments)
        .orderBy(entityAssessments.entityId, entityAssessments.dimension)
        .limit(limit).offset(offset),
      countQuery: db.select({ count: count() }).from(entityAssessments),
    });
    return c.json({ assessments, total, limit, offset });
  })

  // ---- GET /bulk ----
  // Returns every entity assessment in a single response. QUA-1040.
  .get("/bulk", async (c) => {
    const db = getDrizzleDb();
    const { rows: assessments, total } = await bulkQuery({
      query: db
        .select()
        .from(entityAssessments)
        .orderBy(entityAssessments.entityId, entityAssessments.dimension),
      routeName: "entity-assessments/bulk",
    });
    return c.json({ assessments, total });
  })

  .get(
    "/by-entity/:entityId",
    resolveEntityId(),
    zv("query", ByEntityQuery),
    async (c) => {
      const resolvedId = c.get("resolvedEntityId");
      const { limit, offset } = c.req.valid("query");
      const db = getDrizzleDb();
      const where = eq(entityAssessments.entityId, resolvedId);
      const { rows: assessments, total } = await paginatedQuery({
        query: db.select().from(entityAssessments).where(where)
          .orderBy(entityAssessments.dimension)
          .limit(limit).offset(offset),
        countQuery: db.select({ count: count() }).from(entityAssessments).where(where),
      });
      return c.json({ entityId: resolvedId, assessments, total, limit, offset });
    }
  )

  .post("/sync", createSyncHandler({
    name: "entity-assessments",
    table: entityAssessments,
    syncSchema: SyncItemSchema,
    entityRefs: ["entityId"],
    toThing: (item) => ({
      id: item.id,
      thingType: "entity-assessment" as const,
      sourceTable: "entity_assessments",
      sourceId: item.id,
      parentThingId: item.entityId,
      sourceUrl: item.source ?? null,
    }),
  }))

  .post("/delete-batch", deleteBatchHandler(entityAssessments, "entity_assessments"));

export const entityAssessmentsRoute = entityAssessmentsApp;
export type EntityAssessmentsRoute = typeof entityAssessmentsApp;
