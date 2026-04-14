import { Hono } from "hono";
import { z } from "zod";
import { eq, and, inArray, sql } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { entityResources, resources } from "../../schema.js";
import { upsertThingsInTx, resolveEntityTitles } from "../shared/thing-sync.js";
import { registerComposer, composeThing } from "../shared/compose-thing.js";
import { deleteBatchHandler } from "../shared/delete-batch.js";
import { createSyncHandler } from "./sync-factory.js";

// ---- QUA-470 Phase 4b-B.1: entity-resource composer ----
//
// entity-resource was missing from VALID_THING_TYPES until QUA-433 added it.
// Title falls back to the resourceId when the resource title isn't found.
// description encodes the relationship type (authored / about / linked).
interface EntityResourceComposerRow {
  resourceId: string;
  entityId: string;
  authoredByEntity?: boolean;
  isSubject?: boolean;
}

// The composer needs both the resource title map AND the entity title map.
// We pass a single combined map at the call site (resourceId → title and
// entityId → title in the same Map). The keyspaces don't collide because
// resourceIds and entityIds use different prefixes.
registerComposer<EntityResourceComposerRow>("entity-resource", (row, titleMap) => ({
  title: titleMap.get(row.resourceId) ?? row.resourceId,
  // "linked" fallback keeps plain-link rows searchable. SyncItemSchema
  // defaults both booleans to false, so the plain-link path is the common
  // case; returning null would drop the relationship label entirely from
  // things.description.
  description: row.authoredByEntity
    ? "authored"
    : row.isSubject
      ? "about"
      : "linked",
  parentTitle: titleMap.get(row.entityId) ?? row.entityId,
}));

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
      // The entity-resource composer needs BOTH resource titles (from the
      // resources table) AND entity titles in one combined map, plus the
      // auto-generated row id for things.sourceId. The factory's toThing
      // only receives entity titles, so we do the things dual-write in a
      // postUpsert hook instead.
      postUpsert: async (tx, items) => {
        if (items.length === 0) return;

        const entityIds = [...new Set(items.map((i) => i.entityId))];
        const resourceIds = [...new Set(items.map((i) => i.resourceId))];

        // Re-fetch the rows we just upserted so we get the auto-generated
        // `id` (for things.sourceId) and the merged boolean flags (for the
        // composer's description).
        const rows = await tx
          .select({
            id: entityResources.id,
            entityId: entityResources.entityId,
            resourceId: entityResources.resourceId,
            authoredByEntity: entityResources.authoredByEntity,
            isSubject: entityResources.isSubject,
          })
          .from(entityResources)
          .where(
            and(
              inArray(entityResources.entityId, entityIds),
              inArray(entityResources.resourceId, resourceIds),
            ),
          );

        // Narrow to exactly the (entityId, resourceId) pairs we synced —
        // the IN..IN above is a superset when multiple entities share
        // resources within the same batch.
        const pairKeys = new Set(
          items.map((i) => `${i.entityId}\x00${i.resourceId}`),
        );
        const matched = rows.filter((r) =>
          pairKeys.has(`${r.entityId}\x00${r.resourceId}`),
        );
        if (matched.length === 0) return;

        // Resolve resource titles and entity titles into a single combined
        // map (resourceId → title + entityId → title). The composer uses
        // one lookup map; the keyspaces don't collide because resourceIds
        // and entityIds use different prefixes.
        const resourceRows = await tx
          .select({ id: resources.id, title: resources.title, url: resources.url })
          .from(resources)
          .where(inArray(resources.id, resourceIds));
        const entityTitleMap = await resolveEntityTitles(tx, entityIds);
        const combinedTitleMap = new Map<string, string>([
          ...resourceRows.map(
            (r) => [r.id, r.title ?? r.url ?? r.id] as [string, string],
          ),
          ...entityTitleMap.entries(),
        ]);

        await upsertThingsInTx(
          tx,
          matched.map((r) => {
            const composed = composeThing<EntityResourceComposerRow>(
              "entity-resource",
              r,
              combinedTitleMap,
            );
            return {
              id: `er:${r.entityId}:${r.resourceId}`,
              thingType: "entity-resource" as const,
              title: composed.title,
              description: composed.description,
              parentTitle: composed.parentTitle,
              sourceTable: "entity_resources",
              sourceId: String(r.id),
            };
          }),
        );
      },
    }),
  )

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
