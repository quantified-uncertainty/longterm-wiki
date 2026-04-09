import { Hono } from "hono";
import { z } from "zod";
import { eq, and, sql } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { entityResources, resources } from "../../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
} from "../shared/utils.js";
import { upsertThingsInTx, resolveEntityTitles } from "../shared/thing-sync.js";
import { validateEntityRefs } from "../shared/validate-entity-refs.js";
import { deleteBatchHandler } from "../shared/delete-batch.js";

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

type SyncItem = z.infer<typeof SyncItemSchema>;

function toRow(item: SyncItem) {
  return {
    entityId: item.entityId,
    resourceId: item.resourceId,
    authoredByEntity: item.authoredByEntity,
    isSubject: item.isSubject,
    inferenceSource: item.inferenceSource ?? null,
  };
}

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

  // POST /api/entity-resources/sync — batch upsert with OR-merge on boolean flags
  .post("/sync", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = SyncBatchSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(
        c,
        parsed.error.issues.map((i) => i.message).join(", ")
      );
    }

    const { items } = parsed.data;
    const db = getDrizzleDb();

    const refError = await validateEntityRefs(c, db, [
      { fieldName: "entityId", ids: items.map((i) => i.entityId) },
    ]);
    if (refError) return refError;

    const upserted = await db.transaction(async (tx) => {
      // OR-merge: boolean flags accumulate across seed passes (e.g., publisher + wiki_citation).
      // inferenceSource uses COALESCE (first-writer-wins) — the initial source is preserved.
      const rows = await tx
        .insert(entityResources)
        .values(items.map(toRow))
        .onConflictDoUpdate({
          target: [entityResources.entityId, entityResources.resourceId],
          set: {
            authoredByEntity: sql`EXCLUDED.authored_by_entity OR entity_resources.authored_by_entity`,
            isSubject: sql`EXCLUDED.is_subject OR entity_resources.is_subject`,
            inferenceSource: sql`COALESCE(EXCLUDED.inference_source, entity_resources.inference_source)`,
          },
        })
        .returning({ id: entityResources.id, entityId: entityResources.entityId, resourceId: entityResources.resourceId, authoredByEntity: entityResources.authoredByEntity, isSubject: entityResources.isSubject });

      // Dual-write to things table for universal search/browse index
      if (rows.length > 0) {
        const resourceIds = [...new Set(rows.map((r) => r.resourceId))];
        const entityIds = [...new Set(rows.map((r) => r.entityId))];

        // Resolve resource titles and entity titles for search
        const resourceRows = await tx
          .select({ id: resources.id, title: resources.title, url: resources.url })
          .from(resources)
          .where(sql`${resources.id} IN (${sql.join(resourceIds.map(id => sql`${id}`), sql`, `)})`);
        const resourceTitleMap = new Map(resourceRows.map((r) => [r.id, r.title ?? r.url ?? r.id]));

        const entityTitleMap = await resolveEntityTitles(tx, entityIds);

        await upsertThingsInTx(
          tx,
          rows.map((r) => ({
            id: `er:${r.entityId}:${r.resourceId}`,
            thingType: "entity-resource",
            title: resourceTitleMap.get(r.resourceId) ?? r.resourceId,
            sourceTable: "entity_resources",
            sourceId: String(r.id),
            description: r.authoredByEntity ? "authored" : r.isSubject ? "about" : null,
            parentTitle: entityTitleMap.get(r.entityId) ?? r.entityId,
          }))
        );
      }

      return rows;
    });

    return c.json({ total: upserted.length });
  })

  // GET /api/entity-resources/export — all rows (for build pipeline)
  .get("/export", async (c) => {
    const db = getDrizzleDb();
    const rows = await db
      .select({
        entityId: entityResources.entityId,
        resourceId: entityResources.resourceId,
        authoredByEntity: entityResources.authoredByEntity,
        isSubject: entityResources.isSubject,
      })
      .from(entityResources);

    return c.json({ items: rows, total: rows.length });
  })

  .post("/delete-batch", deleteBatchHandler(entityResources, "entity_resources"));

export const entityResourcesRoute = entityResourcesApp;
export type EntityResourcesRoute = typeof entityResourcesApp;
