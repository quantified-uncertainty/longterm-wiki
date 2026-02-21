import { Hono } from "hono";
import { z } from "zod";
import {
  eq,
  count,
  sql,
  desc,
  or,
  ilike,
  type SQL,
} from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { getDrizzleDb } from "../db.js";
import { resources, resourceCitations } from "../schema.js";
import type * as schema from "../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  notFoundError,
  firstOrThrow,
} from "./utils.js";

export const resourcesRoute = new Hono();

// ---- Constants ----

const MAX_BATCH_SIZE = 200;
const MAX_PAGE_SIZE = 200;

// ---- Schemas ----

const UpsertResourceSchema = z.object({
  id: z.string().min(1).max(200),
  url: z.string().url().max(2000),
  title: z.string().max(1000).nullable().optional(),
  type: z.string().max(50).nullable().optional(),
  summary: z.string().max(50000).nullable().optional(),
  review: z.string().max(50000).nullable().optional(),
  abstract: z.string().max(50000).nullable().optional(),
  keyPoints: z.array(z.string().max(2000)).max(50).nullable().optional(),
  publicationId: z.string().max(200).nullable().optional(),
  authors: z.array(z.string().max(500)).max(100).nullable().optional(),
  publishedDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  tags: z.array(z.string().max(200)).max(50).nullable().optional(),
  localFilename: z.string().max(500).nullable().optional(),
  credibilityOverride: z.number().min(0).max(1).nullable().optional(),
  fetchedAt: z.string().datetime().nullable().optional(),
  contentHash: z.string().max(200).nullable().optional(),
  citedBy: z.array(z.string().min(1).max(200)).max(500).nullable().optional(),
});

const UpsertBatchSchema = z.object({
  items: z.array(UpsertResourceSchema).min(1).max(MAX_BATCH_SIZE),
});

const SearchQuery = z.object({
  q: z.string().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const PaginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  type: z.string().max(50).optional(),
});

// ---- Helpers ----

type DbClient = PostgresJsDatabase<typeof schema>;
type ResourceInput = z.infer<typeof UpsertResourceSchema>;

function resourceValues(d: ResourceInput) {
  return {
    id: d.id,
    url: d.url,
    title: d.title ?? null,
    type: d.type ?? null,
    summary: d.summary ?? null,
    review: d.review ?? null,
    abstract: d.abstract ?? null,
    keyPoints: d.keyPoints ?? null,
    publicationId: d.publicationId ?? null,
    authors: d.authors ?? null,
    publishedDate: d.publishedDate ?? null,
    tags: d.tags ?? null,
    localFilename: d.localFilename ?? null,
    credibilityOverride: d.credibilityOverride ?? null,
    fetchedAt: d.fetchedAt ? new Date(d.fetchedAt) : null,
    contentHash: d.contentHash ?? null,
  };
}

/** Escape ILIKE wildcard characters so user input is matched literally. */
function escapeIlike(s: string): string {
  return s.replace(/[%_\\]/g, "\\$&");
}

async function upsertResource(db: DbClient, d: ResourceInput) {
  const vals = resourceValues(d);

  const rows = await db
    .insert(resources)
    .values(vals)
    .onConflictDoUpdate({
      target: resources.id,
      set: {
        url: vals.url,
        title: vals.title,
        type: vals.type,
        summary: vals.summary,
        review: vals.review,
        abstract: vals.abstract,
        keyPoints: vals.keyPoints,
        publicationId: vals.publicationId,
        authors: vals.authors,
        publishedDate: vals.publishedDate,
        tags: vals.tags,
        localFilename: vals.localFilename,
        credibilityOverride: vals.credibilityOverride,
        fetchedAt: vals.fetchedAt,
        contentHash: vals.contentHash,
        updatedAt: sql`now()`,
      },
    })
    .returning({
      id: resources.id,
      url: resources.url,
      title: resources.title,
    });

  // Upsert citations (cited_by)
  if (d.citedBy && d.citedBy.length > 0) {
    // Delete existing citations for this resource, then re-insert
    await db
      .delete(resourceCitations)
      .where(eq(resourceCitations.resourceId, d.id));
    for (const pageId of d.citedBy) {
      await db
        .insert(resourceCitations)
        .values({ resourceId: d.id, pageId })
        .onConflictDoNothing();
    }
  }

  return firstOrThrow(rows, `resource upsert ${d.id}`);
}

function formatResource(r: typeof resources.$inferSelect) {
  return {
    id: r.id,
    url: r.url,
    title: r.title,
    type: r.type,
    summary: r.summary,
    review: r.review,
    abstract: r.abstract,
    keyPoints: r.keyPoints,
    publicationId: r.publicationId,
    authors: r.authors,
    publishedDate: r.publishedDate,
    tags: r.tags,
    localFilename: r.localFilename,
    credibilityOverride: r.credibilityOverride,
    fetchedAt: r.fetchedAt,
    contentHash: r.contentHash,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// ---- POST / (upsert single resource) ----

resourcesRoute.post("/", async (c) => {
  const body = await parseJsonBody(c);
  if (!body) return invalidJsonError(c);

  const parsed = UpsertResourceSchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.message);

  const db = getDrizzleDb();
  const result = await upsertResource(db, parsed.data);
  return c.json(result, 201);
});

// ---- POST /batch (upsert multiple resources) ----

resourcesRoute.post("/batch", async (c) => {
  const body = await parseJsonBody(c);
  if (!body) return invalidJsonError(c);

  const parsed = UpsertBatchSchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { items } = parsed.data;
  const results: Array<{ id: string; url: string }> = [];

  const db = getDrizzleDb();
  await db.transaction(async (tx) => {
    for (const item of items) {
      const result = await upsertResource(tx as unknown as DbClient, item);
      results.push({ id: result.id, url: result.url });
    }
  });

  return c.json({ inserted: results.length, results }, 201);
});

// ---- GET /search?q=X (search by title/summary) ----

resourcesRoute.get("/search", async (c) => {
  const parsed = SearchQuery.safeParse(c.req.query());
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { q, limit } = parsed.data;
  const db = getDrizzleDb();
  const pattern = `%${escapeIlike(q)}%`;

  const rows = await db
    .select()
    .from(resources)
    .where(or(ilike(resources.title, pattern), ilike(resources.summary, pattern)))
    .limit(limit);

  return c.json({
    results: rows.map(formatResource),
    count: rows.length,
  });
});

// ---- GET /stats ----

resourcesRoute.get("/stats", async (c) => {
  const db = getDrizzleDb();

  const totalResult = await db.select({ count: count() }).from(resources);
  const totalResources = totalResult[0].count;

  const citationCountResult = await db
    .select({ count: count() })
    .from(resourceCitations);
  const totalCitations = citationCountResult[0].count;

  const citedPagesResult = await db
    .select({
      count: sql<number>`count(distinct ${resourceCitations.pageId})`,
    })
    .from(resourceCitations);
  const citedPages = Number(citedPagesResult[0].count);

  const byType = await db
    .select({
      type: resources.type,
      count: count(),
    })
    .from(resources)
    .groupBy(resources.type)
    .orderBy(desc(count()));

  return c.json({
    totalResources,
    totalCitations,
    citedPages,
    byType: Object.fromEntries(
      byType.map((r) => [r.type ?? "unknown", r.count])
    ),
  });
});

// ---- GET /by-page/:pageId (resources cited by a page) ----

resourcesRoute.get("/by-page/:pageId", async (c) => {
  const pageId = c.req.param("pageId");
  const db = getDrizzleDb();

  const rows = await db
    .select({
      id: resources.id,
      url: resources.url,
      title: resources.title,
      type: resources.type,
      publicationId: resources.publicationId,
      authors: resources.authors,
      publishedDate: resources.publishedDate,
    })
    .from(resourceCitations)
    .innerJoin(resources, eq(resourceCitations.resourceId, resources.id))
    .where(eq(resourceCitations.pageId, pageId));

  return c.json({ resources: rows });
});

// ---- GET /lookup?url=X (lookup by URL) ----

resourcesRoute.get("/lookup", async (c) => {
  const url = c.req.query("url");
  if (!url) return validationError(c, "url query parameter is required");

  const db = getDrizzleDb();
  const rows = await db
    .select()
    .from(resources)
    .where(eq(resources.url, url))
    .limit(1);

  if (rows.length === 0) {
    return notFoundError(c, `No resource found for URL: ${url}`);
  }

  return c.json(formatResource(rows[0]));
});

// ---- GET /all (paginated listing) ----

resourcesRoute.get("/all", async (c) => {
  const parsed = PaginationQuery.safeParse(c.req.query());
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { limit, offset, type } = parsed.data;
  const db = getDrizzleDb();

  const conditions: SQL | undefined = type
    ? eq(resources.type, type)
    : undefined;

  const rows = await db
    .select()
    .from(resources)
    .where(conditions)
    .orderBy(resources.id)
    .limit(limit)
    .offset(offset);

  const countResult = await db
    .select({ count: count() })
    .from(resources)
    .where(conditions);
  const total = countResult[0].count;

  return c.json({
    resources: rows.map(formatResource),
    total,
    limit,
    offset,
  });
});

// ---- GET /:id (get by ID) ----

resourcesRoute.get("/:id", async (c) => {
  const id = c.req.param("id");
  const db = getDrizzleDb();

  const rows = await db
    .select()
    .from(resources)
    .where(eq(resources.id, id))
    .limit(1);

  if (rows.length === 0) {
    return notFoundError(c, `Resource not found: ${id}`);
  }

  // Also fetch citations
  const citations = await db
    .select({ pageId: resourceCitations.pageId })
    .from(resourceCitations)
    .where(eq(resourceCitations.resourceId, id));

  return c.json({
    ...formatResource(rows[0]),
    citedBy: citations.map((row) => row.pageId),
  });
});
