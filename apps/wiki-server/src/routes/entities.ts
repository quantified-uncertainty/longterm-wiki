import { Hono } from "hono";
import { z } from "zod";
import { eq, and, count, asc, sql, ilike, or } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import { entities } from "../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  notFoundError,
} from "./utils.js";
import {
  SyncEntitySchema as SharedSyncEntitySchema,
  SyncEntitiesBatchSchema,
} from "../api-types.js";

export const entitiesRoute = new Hono();

// ---- Constants ----

const MAX_PAGE_SIZE = 200;

// ---- Schemas (from shared api-types) ----

const SyncEntitySchema = SharedSyncEntitySchema;
const SyncBatchSchema = SyncEntitiesBatchSchema;

const PaginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  entityType: z.string().max(100).optional(),
});

const SearchQuery = z.object({
  q: z.string().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// ---- Helpers ----

function escapeIlike(s: string): string {
  return s.replace(/[%_\\]/g, "\\$&");
}

function formatEntity(e: typeof entities.$inferSelect) {
  return {
    id: e.id,
    numericId: e.numericId,
    entityType: e.entityType,
    title: e.title,
    description: e.description,
    website: e.website,
    tags: e.tags,
    clusters: e.clusters,
    status: e.status,
    lastUpdated: e.lastUpdated,
    customFields: e.customFields,
    relatedEntries: e.relatedEntries,
    sources: e.sources,
    syncedAt: e.syncedAt,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

// ---- GET /search?q=...&limit=20 ----

entitiesRoute.get("/search", async (c) => {
  const parsed = SearchQuery.safeParse(c.req.query());
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { q, limit } = parsed.data;
  const db = getDrizzleDb();
  const pattern = `%${escapeIlike(q)}%`;

  const rows = await db
    .select()
    .from(entities)
    .where(
      or(
        ilike(entities.title, pattern),
        ilike(entities.id, pattern),
        ilike(entities.description, pattern)
      )
    )
    .orderBy(entities.id)
    .limit(limit);

  return c.json({
    results: rows.map(formatEntity),
    query: q,
    total: rows.length,
  });
});

// ---- GET /stats ----

entitiesRoute.get("/stats", async (c) => {
  const db = getDrizzleDb();

  const totalResult = await db.select({ count: count() }).from(entities);
  const total = totalResult[0].count;

  const byType = await db
    .select({
      entityType: entities.entityType,
      count: count(),
    })
    .from(entities)
    .groupBy(entities.entityType)
    .orderBy(sql`count(*) DESC`);

  return c.json({
    total,
    byType: Object.fromEntries(
      byType.map((r) => [r.entityType, r.count])
    ),
  });
});

// ---- GET /:id ----

entitiesRoute.get("/:id", async (c) => {
  const id = c.req.param("id");
  if (!id) return validationError(c, "Entity ID is required");

  const db = getDrizzleDb();

  // Look up by slug or numeric ID
  const rows = await db
    .select()
    .from(entities)
    .where(or(eq(entities.id, id), eq(entities.numericId, id)));

  if (rows.length === 0) {
    return notFoundError(c, `No entity found for id: ${id}`);
  }

  return c.json(formatEntity(rows[0]));
});

// ---- GET / (paginated listing) ----

entitiesRoute.get("/", async (c) => {
  const parsed = PaginationQuery.safeParse(c.req.query());
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { limit, offset, entityType } = parsed.data;
  const db = getDrizzleDb();

  const conditions = [];
  if (entityType) conditions.push(eq(entities.entityType, entityType));

  const whereClause =
    conditions.length > 0
      ? conditions.length === 1
        ? conditions[0]
        : and(...conditions)
      : undefined;

  const rows = await db
    .select({
      id: entities.id,
      numericId: entities.numericId,
      entityType: entities.entityType,
      title: entities.title,
      description: entities.description,
      website: entities.website,
      tags: entities.tags,
      status: entities.status,
      lastUpdated: entities.lastUpdated,
    })
    .from(entities)
    .where(whereClause)
    .orderBy(asc(entities.id))
    .limit(limit)
    .offset(offset);

  const countResult = await db
    .select({ count: count() })
    .from(entities)
    .where(whereClause);
  const total = countResult[0].count;

  return c.json({ entities: rows, total, limit, offset });
});

// ---- POST /sync ----

entitiesRoute.post("/sync", async (c) => {
  const body = await parseJsonBody(c);
  if (!body) return invalidJsonError(c);

  const parsed = SyncBatchSchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { entities: items } = parsed.data;
  const db = getDrizzleDb();
  let upserted = 0;

  await db.transaction(async (tx) => {
    const allVals = items.map((e) => ({
      id: e.id,
      numericId: e.numericId ?? null,
      entityType: e.entityType,
      title: e.title,
      description: e.description ?? null,
      website: e.website ?? null,
      tags: e.tags ?? null,
      clusters: e.clusters ?? null,
      status: e.status ?? null,
      lastUpdated: e.lastUpdated ?? null,
      customFields: e.customFields ?? null,
      relatedEntries: e.relatedEntries ?? null,
      sources: e.sources ?? null,
    }));

    await tx
      .insert(entities)
      .values(allVals)
      .onConflictDoUpdate({
        target: entities.id,
        set: {
          numericId: sql`excluded.numeric_id`,
          entityType: sql`excluded.entity_type`,
          title: sql`excluded.title`,
          description: sql`excluded.description`,
          website: sql`excluded.website`,
          tags: sql`excluded.tags`,
          clusters: sql`excluded.clusters`,
          status: sql`excluded.status`,
          lastUpdated: sql`excluded.last_updated`,
          customFields: sql`excluded.custom_fields`,
          relatedEntries: sql`excluded.related_entries`,
          sources: sql`excluded.sources`,
          syncedAt: sql`now()`,
          updatedAt: sql`now()`,
        },
      });
    upserted = allVals.length;
  });

  return c.json({ upserted });
});
