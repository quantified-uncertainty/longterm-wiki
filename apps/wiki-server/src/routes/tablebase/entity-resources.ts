import { Hono } from "hono";
import { z } from "zod";
import { eq, and, inArray, sql } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { entityResources } from "../../schema.js";
import { upsertThingsInTx } from "../shared/thing-sync.js";
import { deleteBatchHandler } from "../shared/delete-batch.js";
import { applyTruncation } from "../shared/utils.js";
import { createSyncHandler } from "./sync-factory.js";

const SyncItemSchema = z.object({
  entityId: z.string().min(1).max(200),
  resourceId: z.string().min(1).max(200),
  authoredByEntity: z.boolean().optional().default(false),
  isSubject: z.boolean().optional().default(false),
  inferenceSource: z.string().min(1).max(200).nullable().optional(),
});

const SyncBatchSchema = z.object({
  items: z.array(SyncItemSchema).min(1).max(1000),
});

const entityResourcesApp = new Hono()

  // GET /api/entity-resources?entityId=<stableId>[&authoredByEntity=true][&isSubject=true]
  .get("/", async (c) => {
    const entityId = c.req.query("entityId");
    if (!entityId) {
      return c.json({ error: "entityId query parameter is required" }, 400);
    }

    const db = getDrizzleDb();
    const conditions = [eq(entityResources.entityId, entityId)];

    const authoredParam = c.req.query("authoredByEntity");
    if (authoredParam === "true") {
      conditions.push(eq(entityResources.authoredByEntity, true));
    } else if (authoredParam === "false") {
      conditions.push(eq(entityResources.authoredByEntity, false));
    }

    const subjectParam = c.req.query("isSubject");
    if (subjectParam === "true") {
      conditions.push(eq(entityResources.isSubject, true));
    } else if (subjectParam === "false") {
      conditions.push(eq(entityResources.isSubject, false));
    }

    const rows = await db
      .select()
      .from(entityResources)
      .where(and(...conditions))
      .limit(500);

    return c.json({ items: rows, total: rows.length });
  })

  // POST /api/entity-resources/sync — batch upsert with OR-merge on boolean flags.
  // Uses sync-factory with a postUpsert hook for the resource-title-aware
  // things dual-write (factory's toThing only resolves entity titles).
  .post(
    "/sync",
    createSyncHandler({
      name: "entity-resources",
      table: entityResources,
      batchSchema: SyncBatchSchema,
      entityRefs: ["entityId"],
      conflictTarget: [entityResources.entityId, entityResources.resourceId],
      // OR-merge: boolean flags accumulate across seed passes (e.g.,
      // publisher + wiki_citation). inferenceSource uses COALESCE
      // (first-writer-wins) — the initial source is preserved.
      conflictSet: {
        authoredByEntity: sql`EXCLUDED.authored_by_entity OR entity_resources.authored_by_entity`,
        isSubject: sql`EXCLUDED.is_subject OR entity_resources.is_subject`,
        inferenceSource: sql`COALESCE(EXCLUDED.inference_source, entity_resources.inference_source)`,
      },
      toRow: (item) => ({
        entityId: item.entityId,
        resourceId: item.resourceId,
        authoredByEntity: item.authoredByEntity,
        isSubject: item.isSubject,
        inferenceSource: item.inferenceSource ?? null,
      }),
      // QUA-507: pointer-only things dual-write. Re-fetch the upserted rows
      // so we get the auto-generated `id` (for things.sourceId).
      postUpsert: async (tx, items) => {
        if (items.length === 0) return;

        const entityIds = [...new Set(items.map((i) => i.entityId))];
        const resourceIds = [...new Set(items.map((i) => i.resourceId))];

        const rows = await tx
          .select({
            id: entityResources.id,
            entityId: entityResources.entityId,
            resourceId: entityResources.resourceId,
          })
          .from(entityResources)
          .where(
            and(
              inArray(entityResources.entityId, entityIds),
              inArray(entityResources.resourceId, resourceIds),
            ),
          );

        // Narrow to exactly the (entityId, resourceId) pairs we synced.
        const pairKeys = new Set(
          items.map((i) => `${i.entityId}\x00${i.resourceId}`),
        );
        const matched = rows.filter((r) =>
          pairKeys.has(`${r.entityId}\x00${r.resourceId}`),
        );
        if (matched.length === 0) return;

        await upsertThingsInTx(
          tx,
          matched.map((r) => ({
            id: `er:${r.entityId}:${r.resourceId}`,
            thingType: "entity-resource" as const,
            parentThingId: r.entityId,
            sourceTable: "entity_resources",
            sourceId: String(r.id),
          })),
        );
      },
    }),
  )

  // GET /api/entity-resources/export — all rows (for build pipeline)
  // Capped to prevent unbounded scans on a growing table (QUA-623). Uses a
  // +1 sentinel so `truncated` is false when the row count exactly equals
  // the cap (vs. genuinely spilling past it). The build pipeline reads ~all
  // rows; raise EXPORT_LIMIT if prod exceeds it and add cursor pagination
  // before then.
  .get("/export", async (c) => {
    const EXPORT_LIMIT = 200_000;
    const db = getDrizzleDb();
    const rows = await db
      .select({
        entityId: entityResources.entityId,
        resourceId: entityResources.resourceId,
        authoredByEntity: entityResources.authoredByEntity,
        isSubject: entityResources.isSubject,
      })
      .from(entityResources)
      .limit(EXPORT_LIMIT + 1);
    const { items, truncated } = applyTruncation(rows, EXPORT_LIMIT);

    return c.json({
      items,
      total: items.length,
      truncated,
      limit: EXPORT_LIMIT,
    });
  })

  .post("/delete-batch", deleteBatchHandler(entityResources, "entity_resources"));

export const entityResourcesRoute = entityResourcesApp;
export type EntityResourcesRoute = typeof entityResourcesApp;
