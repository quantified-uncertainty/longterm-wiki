import { Hono, type Context } from "hono";
import { z } from "zod";
import { eq, or, and, count, asc, sql } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import { wikiPages } from "../schema.js";
import { search, rebuildSearchIndex } from "../search.js";

export const pagesRoute = new Hono();

// ---- Constants ----

const MAX_BATCH_SIZE = 100;
const MAX_PAGE_SIZE = 200;
const MAX_CONTENT_LENGTH = 500_000; // ~500KB per page

// ---- Schemas ----

const SearchQuery = z.object({
  q: z.string().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const PaginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  category: z.string().max(100).optional(),
  entityType: z.string().max(100).optional(),
});

const SyncPageSchema = z.object({
  id: z.string().min(1).max(300),
  numericId: z.string().max(20).nullable().optional(),
  title: z.string().min(1).max(500),
  description: z.string().max(5000).nullable().optional(),
  llmSummary: z.string().max(10000).nullable().optional(),
  category: z.string().max(100).nullable().optional(),
  subcategory: z.string().max(100).nullable().optional(),
  entityType: z.string().max(100).nullable().optional(),
  tags: z.string().max(5000).nullable().optional(),
  quality: z.number().int().min(0).max(100).nullable().optional(),
  readerImportance: z.number().int().min(0).max(100).nullable().optional(),
  hallucinationRiskLevel: z.string().max(50).nullable().optional(),
  hallucinationRiskScore: z.number().int().min(0).max(100).nullable().optional(),
  contentPlaintext: z.string().max(MAX_CONTENT_LENGTH).nullable().optional(),
  wordCount: z.number().int().min(0).nullable().optional(),
  lastUpdated: z.string().max(50).nullable().optional(),
  contentFormat: z.string().max(50).nullable().optional(),
});

const SyncBatchSchema = z.object({
  pages: z.array(SyncPageSchema).min(1).max(MAX_BATCH_SIZE),
});

// ---- Helpers ----

function parseJsonBody(c: Context) {
  return c.req.json().catch(() => null);
}

function validationError(c: Context, message: string) {
  return c.json({ error: "validation_error", message }, 400);
}

// ---- GET /search?q=...&limit=20 ----

pagesRoute.get("/search", async (c) => {
  const parsed = SearchQuery.safeParse(c.req.query());
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { q, limit } = parsed.data;
  const results = search(q, limit);

  return c.json({ results, query: q, total: results.length });
});

// ---- GET /:id ----

pagesRoute.get("/:id", async (c) => {
  const id = c.req.param("id");
  if (!id) return validationError(c, "Page ID is required");

  const db = getDrizzleDb();

  // Look up by slug or numeric ID
  const rows = await db
    .select()
    .from(wikiPages)
    .where(or(eq(wikiPages.id, id), eq(wikiPages.numericId, id)));

  if (rows.length === 0) {
    return c.json(
      { error: "not_found", message: `No page found for id: ${id}` },
      404
    );
  }

  const page = rows[0];
  return c.json({
    id: page.id,
    numericId: page.numericId,
    title: page.title,
    description: page.description,
    llmSummary: page.llmSummary,
    category: page.category,
    subcategory: page.subcategory,
    entityType: page.entityType,
    tags: page.tags,
    quality: page.quality,
    readerImportance: page.readerImportance,
    hallucinationRiskLevel: page.hallucinationRiskLevel,
    hallucinationRiskScore: page.hallucinationRiskScore,
    contentPlaintext: page.contentPlaintext,
    wordCount: page.wordCount,
    lastUpdated: page.lastUpdated,
    contentFormat: page.contentFormat,
    syncedAt: page.syncedAt,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
  });
});

// ---- GET / (paginated listing) ----

pagesRoute.get("/", async (c) => {
  const parsed = PaginationQuery.safeParse(c.req.query());
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { limit, offset, category, entityType } = parsed.data;
  const db = getDrizzleDb();

  // Build where conditions
  const conditions = [];
  if (category) conditions.push(eq(wikiPages.category, category));
  if (entityType) conditions.push(eq(wikiPages.entityType, entityType));

  const whereClause =
    conditions.length > 0
      ? conditions.length === 1
        ? conditions[0]
        : and(...conditions)
      : undefined;

  const rows = await db
    .select({
      id: wikiPages.id,
      numericId: wikiPages.numericId,
      title: wikiPages.title,
      description: wikiPages.description,
      category: wikiPages.category,
      subcategory: wikiPages.subcategory,
      entityType: wikiPages.entityType,
      quality: wikiPages.quality,
      readerImportance: wikiPages.readerImportance,
      wordCount: wikiPages.wordCount,
      lastUpdated: wikiPages.lastUpdated,
      contentFormat: wikiPages.contentFormat,
    })
    .from(wikiPages)
    .where(whereClause)
    .orderBy(asc(wikiPages.id))
    .limit(limit)
    .offset(offset);

  const countResult = await db
    .select({ count: count() })
    .from(wikiPages)
    .where(whereClause);
  const total = countResult[0].count;

  return c.json({ pages: rows, total, limit, offset });
});

// ---- POST /sync ----

pagesRoute.post("/sync", async (c) => {
  const body = await parseJsonBody(c);
  if (!body) {
    return c.json(
      { error: "invalid_json", message: "Request body must be valid JSON" },
      400
    );
  }

  const parsed = SyncBatchSchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { pages } = parsed.data;
  const db = getDrizzleDb();
  let upserted = 0;

  await db.transaction(async (tx) => {
    for (const page of pages) {
      const vals = {
        id: page.id,
        numericId: page.numericId ?? null,
        title: page.title,
        description: page.description ?? null,
        llmSummary: page.llmSummary ?? null,
        category: page.category ?? null,
        subcategory: page.subcategory ?? null,
        entityType: page.entityType ?? null,
        tags: page.tags ?? null,
        quality: page.quality ?? null,
        readerImportance: page.readerImportance ?? null,
        hallucinationRiskLevel: page.hallucinationRiskLevel ?? null,
        hallucinationRiskScore: page.hallucinationRiskScore ?? null,
        contentPlaintext: page.contentPlaintext ?? null,
        wordCount: page.wordCount ?? null,
        lastUpdated: page.lastUpdated ?? null,
        contentFormat: page.contentFormat ?? null,
      };

      await tx
        .insert(wikiPages)
        .values(vals)
        .onConflictDoUpdate({
          target: wikiPages.id,
          set: {
            ...vals,
            syncedAt: sql`now()`,
            updatedAt: sql`now()`,
          },
        });
      upserted++;
    }
  });

  // Rebuild search index after sync
  const indexed = await rebuildSearchIndex();

  return c.json({ upserted, totalIndexed: indexed });
});
