import { Hono } from "hono";
import { z } from "zod";
import { eq, count } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { entityAssessments } from "../../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  zv,
  clampedLimit,
} from "../shared/utils.js";
import {
  resolveEntityId,
  type ResolvedEntityVars,
} from "../shared/resolve-entity-middleware.js";
import {
  upsertThingsInTx,
  resolveEntityTitles,
} from "../shared/thing-sync.js";

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

const SyncBatchSchema = z.object({
  items: z.array(SyncItemSchema).min(1).max(500),
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

    const rows = await db
      .select()
      .from(entityAssessments)
      .orderBy(entityAssessments.entityId, entityAssessments.dimension)
      .limit(limit)
      .offset(offset);

    const [{ count: total }] = await db
      .select({ count: count() })
      .from(entityAssessments);

    return c.json({ assessments: rows, total, limit, offset });
  })

  .get(
    "/by-entity/:entityId",
    resolveEntityId(),
    zv("query", ByEntityQuery),
    async (c) => {
      const resolvedId = c.get("resolvedEntityId");
      const { limit, offset } = c.req.valid("query");
      const db = getDrizzleDb();

      const rows = await db
        .select()
        .from(entityAssessments)
        .where(eq(entityAssessments.entityId, resolvedId))
        .orderBy(entityAssessments.dimension)
        .limit(limit)
        .offset(offset);

      const [{ count: total }] = await db
        .select({ count: count() })
        .from(entityAssessments)
        .where(eq(entityAssessments.entityId, resolvedId));

      return c.json({
        entityId: resolvedId,
        assessments: rows,
        total,
        limit,
        offset,
      });
    }
  )

  .post("/sync", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = SyncBatchSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { items } = parsed.data;
    const db = getDrizzleDb();
    const now = new Date();
    let upserted = 0;

    await db.transaction(async (tx) => {
      const entityIds = [...new Set(items.map((i) => i.entityId))];
      const titleMap = await resolveEntityTitles(tx, entityIds);

      for (const item of items) {
        await tx
          .insert(entityAssessments)
          .values({
            id: item.id,
            entityId: item.entityId,
            dimension: item.dimension,
            rating: item.rating,
            evidence: item.evidence ?? null,
            assessor: item.assessor,
            assessedAt: item.assessedAt ?? null,
            source: item.source ?? null,
            notes: item.notes ?? null,
            syncedAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: entityAssessments.id,
            set: {
              entityId: item.entityId,
              dimension: item.dimension,
              rating: item.rating,
              evidence: item.evidence ?? null,
              assessor: item.assessor,
              assessedAt: item.assessedAt ?? null,
              source: item.source ?? null,
              notes: item.notes ?? null,
              syncedAt: now,
              updatedAt: now,
            },
          });
        upserted++;
      }

      const entityTitle = (id: string) => titleMap.get(id) ?? id;

      await upsertThingsInTx(
        tx,
        items.map((i) => ({
          id: i.id,
          thingType: "entity-assessment" as const,
          title: `${i.dimension}: ${i.rating}`,
          sourceTable: "entity_assessments",
          sourceId: i.id,
          parentThingId: i.entityId,
          parentTitle: entityTitle(i.entityId),
          sourceUrl: i.source ?? null,
          description: i.evidence ?? null,
        }))
      );
    });

    return c.json({ upserted });
  });

export const entityAssessmentsRoute = entityAssessmentsApp;
export type EntityAssessmentsRoute = typeof entityAssessmentsApp;
