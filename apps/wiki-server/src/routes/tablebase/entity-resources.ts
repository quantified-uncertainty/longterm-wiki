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
import { registerComposer, composeThing } from "../shared/compose-thing.js";
import { validateEntityRefs } from "../shared/validate-entity-refs.js";
import { deleteBatchHandler } from "../shared/delete-batch.js";

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
  description: row.authoredByEntity ? "authored" : row.isSubject ? "about" : null,
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

        // Combined title map: resourceId → title AND entityId → title.
        // The composer's titleMap parameter is a single Map; we merge both
        // sources here so the composer can look up either kind of ref.
        const combinedTitleMap = new Map([
          ...resourceTitleMap.entries(),
          ...entityTitleMap.entries(),
        ]);

        await upsertThingsInTx(
          tx,
          rows.map((r) => {
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
          })
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
