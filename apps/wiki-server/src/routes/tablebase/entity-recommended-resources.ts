import { Hono } from "hono";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { getDrizzleDb } from "../../db.js";
import { entityRecommendedResources } from "../../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
} from "../shared/utils.js";

const SyncItemSchema = z.object({
  entityId: z.string().min(1).max(200),
  resourceId: z.string().max(200).nullable().optional(),
  title: z.string().min(1).max(1000),
  url: z.string().max(2000).nullable().optional(),
  authors: z.string().max(2000).nullable().optional(),
  publishedDate: z.string().max(20).nullable().optional(),
  category: z.string().max(100).nullable().optional(),
  topics: z.array(z.string()).nullable().optional(),
  importance: z.number().int().min(1).max(5).nullable().optional(),
  isSeminal: z.boolean().optional().default(false),
  sortOrder: z.number().int().optional().default(0),
  notes: z.string().max(10000).nullable().optional(),
});

const SyncBatchSchema = z.object({
  items: z.array(SyncItemSchema).min(1).max(500),
});

type SyncItem = z.infer<typeof SyncItemSchema>;

function toRow(item: SyncItem) {
  return {
    entityId: item.entityId,
    resourceId: item.resourceId ?? null,
    title: item.title,
    url: item.url ?? null,
    authors: item.authors ?? null,
    publishedDate: item.publishedDate ?? null,
    category: item.category ?? null,
    topics: item.topics ?? null,
    importance: item.importance ?? null,
    isSeminal: item.isSeminal,
    sortOrder: item.sortOrder,
    notes: item.notes ?? null,
  };
}

const entityRecommendedResourcesApp = new Hono()

  // GET /api/entity-recommended-resources?entityId=<stableId>
  .get("/", async (c) => {
    const entityId = c.req.query("entityId");
    if (!entityId) {
      return c.json({ error: "entityId query parameter is required" }, 400);
    }

    const db = getDrizzleDb();
    const rows = await db
      .select()
      .from(entityRecommendedResources)
      .where(eq(entityRecommendedResources.entityId, entityId))
      .orderBy(entityRecommendedResources.sortOrder);

    return c.json({ items: rows, total: rows.length });
  })

  // POST /api/entity-recommended-resources/sync — batch upsert
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

    // Partition by URL presence: items with URLs can use bulk upsert,
    // items without URLs need plain insert (partial unique index doesn't cover NULLs)
    const withUrl = items.filter((i) => i.url);
    const withoutUrl = items.filter((i) => !i.url);

    const upserted = await db.transaction(async (tx) => {
      const ids: number[] = [];

      if (withUrl.length > 0) {
        const rows = await tx
          .insert(entityRecommendedResources)
          .values(withUrl.map(toRow))
          .onConflictDoUpdate({
            target: [entityRecommendedResources.entityId, entityRecommendedResources.url],
            set: {
              title: sql`EXCLUDED.title`,
              authors: sql`EXCLUDED.authors`,
              publishedDate: sql`EXCLUDED.published_date`,
              category: sql`EXCLUDED.category`,
              topics: sql`EXCLUDED.topics`,
              importance: sql`EXCLUDED.importance`,
              isSeminal: sql`EXCLUDED.is_seminal`,
              sortOrder: sql`EXCLUDED.sort_order`,
              notes: sql`EXCLUDED.notes`,
              resourceId: sql`EXCLUDED.resource_id`,
            },
          })
          .returning({ id: entityRecommendedResources.id });
        ids.push(...rows.map((r) => r.id));
      }

      if (withoutUrl.length > 0) {
        const rows = await tx
          .insert(entityRecommendedResources)
          .values(withoutUrl.map(toRow))
          .returning({ id: entityRecommendedResources.id });
        ids.push(...rows.map((r) => r.id));
      }

      return ids;
    });

    return c.json({ total: upserted.length });
  });

export const entityRecommendedResourcesRoute = entityRecommendedResourcesApp;
export type EntityRecommendedResourcesRoute = typeof entityRecommendedResourcesApp;
