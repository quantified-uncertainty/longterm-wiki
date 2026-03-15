import { Hono } from "hono";
import { z } from "zod";
import { buildPrefixTsquery } from "../search-utils.js";
import { logger } from "../logger.js";
import {
  eq,
  count,
  sql,
  desc,
  type SQL,
} from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { getDrizzleDb, getDb } from "../db.js";
import { resources, resourceCitations, wikiPages, citationContent } from "../schema.js";
import { checkRefsExist } from "./ref-check.js";
import type * as schema from "../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  notFoundError,
  firstOrThrow,
  dbError,
  paginationQuery,
} from "./utils.js";
import {
  UpsertResourceSchema as SharedUpsertResourceSchema,
  UpsertResourceBatchSchema,
  UpdateResourceFetchStatusSchema,
  type ResourceStatsResult,
} from "../api-types.js";
import { resolvePageIntId, resolvePageIntIds } from "./page-id-helpers.js";
import { upsertThingsInTx } from "./thing-sync.js";

// ---- Raw SQL row types ----

/** Row shape returned by the resource FTS search query. */
interface ResourceSearchRow {
  id: string;
  url: string;
  title: string | null;
  type: string | null;
  summary: string | null;
  review: string | null;
  abstract: string | null;
  key_points: string[] | null;
  publication_id: string | null;
  authors: string[] | null;
  published_date: string | null;
  tags: string[] | null;
  local_filename: string | null;
  credibility_override: number | null;
  fetched_at: string | null;
  content_hash: string | null;
  stable_id: string | null;
  fetch_status: string | null;
  last_fetched_at: string | null;
  archive_url: string | null;
  created_at: string;
  updated_at: string;
  rank: number;
}

/** Row shape returned by COUNT(*) aggregate queries via db.execute(). */
interface CountRow {
  c: string | number;
}

// ---- Constants ----

const MAX_PAGE_SIZE = 200;

// ---- URL normalization ----

/**
 * Generate common URL variants for fuzzy lookup.
 * Tries with/without www, with/without trailing slash.
 */
function urlVariants(url: string): string[] {
  const variants = new Set<string>();
  try {
    const parsed = new URL(url);
    const base = parsed.href.replace(/\/$/, "");
    variants.add(base);
    variants.add(base + "/");
    if (parsed.hostname.startsWith("www.")) {
      const noWww = base.replace("://www.", "://");
      variants.add(noWww);
      variants.add(noWww + "/");
    } else {
      const withWww = base.replace("://", "://www.");
      variants.add(withWww);
      variants.add(withWww + "/");
    }
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "urlVariants parse failed");
    variants.add(url);
  }
  return Array.from(variants);
}

// ---- Schemas (from shared api-types) ----

const UpsertResourceSchema = SharedUpsertResourceSchema;
const UpsertBatchSchema = UpsertResourceBatchSchema;

const SearchQuery = z.object({
  q: z.string().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const PaginationQuery = paginationQuery({ maxLimit: MAX_PAGE_SIZE }).extend({
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
    stableId: d.stableId ?? null,
    archiveUrl: d.archiveUrl ?? null,
  };
}

async function upsertResource(
  db: DbClient,
  d: ResourceInput,
  options?: { skipSearchVector?: boolean; intIdMap?: Map<string, number> }
) {
  const vals = resourceValues(d);

  // COALESCE(incoming, existing) for enrichable fields: a non-null incoming
  // value overwrites, but null incoming preserves existing data. This prevents
  // partial saves (bare resources, snapshot-loaded resources missing text fields)
  // from wiping richer data already in PG. See #2069 review discussion.
  const rows = await db
    .insert(resources)
    .values(vals)
    .onConflictDoUpdate({
      target: resources.id,
      set: {
        url: vals.url,
        title: sql`COALESCE(${vals.title}, ${resources.title})`,
        type: sql`COALESCE(${vals.type}, ${resources.type})`,
        summary: sql`COALESCE(${vals.summary}, ${resources.summary})`,
        review: sql`COALESCE(${vals.review}, ${resources.review})`,
        abstract: sql`COALESCE(${vals.abstract}, ${resources.abstract})`,
        keyPoints: sql`COALESCE(${vals.keyPoints}::jsonb, ${resources.keyPoints})`,
        publicationId: sql`COALESCE(${vals.publicationId}, ${resources.publicationId})`,
        authors: sql`COALESCE(${vals.authors}::jsonb, ${resources.authors})`,
        publishedDate: sql`COALESCE(${vals.publishedDate}, ${resources.publishedDate})`,
        tags: sql`COALESCE(${vals.tags}::jsonb, ${resources.tags})`,
        localFilename: sql`COALESCE(${vals.localFilename}, ${resources.localFilename})`,
        credibilityOverride: sql`COALESCE(${vals.credibilityOverride}, ${resources.credibilityOverride})`,
        fetchedAt: sql`COALESCE(${vals.fetchedAt}, ${resources.fetchedAt})`,
        contentHash: sql`COALESCE(${vals.contentHash}, ${resources.contentHash})`,
        // stableId is generate-once: preserve existing, only set if row didn't have one
        stableId: sql`COALESCE(${resources.stableId}, ${vals.stableId})`,
        archiveUrl: sql`COALESCE(${vals.archiveUrl}, ${resources.archiveUrl})`,
        updatedAt: sql`now()`,
      },
    })
    .returning({
      id: resources.id,
      url: resources.url,
      title: resources.title,
    });

  const result = firstOrThrow(rows, `resource upsert ${d.id}`);

  if (!options?.skipSearchVector) {
    // Update search_vector for this resource (single-row update)
    await db.execute(sql`
      UPDATE resources SET search_vector =
        setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(summary, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(abstract, '')), 'C') ||
        setweight(to_tsvector('english', coalesce(review, '')), 'D')
      WHERE id = ${d.id}
    `);
  }

  // Upsert citations (cited_by)
  if (d.citedBy && d.citedBy.length > 0) {
    // Delete existing citations for this resource, then re-insert
    await db
      .delete(resourceCitations)
      .where(eq(resourceCitations.resourceId, d.id));
    // Phase 4a: use pre-resolved map if provided (batch path), else resolve per-resource (single path)
    const citedByIntIdMap = options?.intIdMap ?? await resolvePageIntIds(db, d.citedBy);
    await db
      .insert(resourceCitations)
      .values(d.citedBy.map((pageId) => ({
        resourceId: d.id,
        pageId,
        pageIdInt: citedByIntIdMap.get(pageId) ?? null, // Phase 4a dual-write
      })))
      .onConflictDoNothing();
  }

  return result;
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
    stableId: r.stableId,
    fetchStatus: r.fetchStatus,
    lastFetchedAt: r.lastFetchedAt,
    archiveUrl: r.archiveUrl,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// ---- Route ----

const resourcesApp = new Hono()

  // ---- POST / (upsert single resource) ----

  .post("/", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = UpsertResourceSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const db = getDrizzleDb();

    // Validate citedBy page references (optional field)
    if (parsed.data.citedBy && parsed.data.citedBy.length > 0) {
      const missingPages = await checkRefsExist(db, wikiPages, wikiPages.id, parsed.data.citedBy);
      if (missingPages.length > 0) {
        return validationError(
          c,
          `Referenced pages not found in citedBy: ${missingPages.join(", ")}`
        );
      }
    }

    const result = await upsertResource(db, parsed.data);
    return c.json(result, 201);
  })

  // ---- POST /batch (upsert multiple resources) ----

  .post("/batch", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = UpsertBatchSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { items } = parsed.data;

    const db = getDrizzleDb();

    // Validate citedBy page references
    const allCitedBy = [
      ...new Set(items.flatMap((item) => item.citedBy ?? [])),
    ];
    if (allCitedBy.length > 0) {
      const missingPages = await checkRefsExist(db, wikiPages, wikiPages.id, allCitedBy);
      if (missingPages.length > 0) {
        return validationError(
          c,
          `Referenced pages not found in citedBy: ${missingPages.join(", ")}`
        );
      }
    }

    const results: Array<{ id: string; url: string }> = [];
    try {
      await db.transaction(async (tx) => {
        // Phase 4a: pre-resolve all citedBy page IDs in one batch query
        const allCitedByIds = [...new Set(items.flatMap((item) => item.citedBy ?? []))];
        const intIdMap = allCitedByIds.length > 0
          ? await resolvePageIntIds(tx, allCitedByIds)
          : new Map<string, number>();

        for (const item of items) {
          // Skip per-row search_vector update; handled in bulk below
          const result = await upsertResource(tx, item, {
            skipSearchVector: true,
            intIdMap,
          });
          results.push({ id: result.id, url: result.url });
        }

        // Bulk search_vector update for all upserted resources (one query)
        const idList = sql.join(
          results.map((r) => sql`${r.id}`),
          sql`, `
        );
        await tx.execute(sql`
          UPDATE resources SET search_vector =
            setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
            setweight(to_tsvector('english', coalesce(summary, '')), 'B') ||
            setweight(to_tsvector('english', coalesce(abstract, '')), 'C') ||
            setweight(to_tsvector('english', coalesce(review, '')), 'D')
          WHERE id IN (${idList})
        `);

        // Dual-write to things table
        await upsertThingsInTx(
          tx,
          items.map((r) => ({
            id: r.stableId || r.id,
            thingType: "resource" as const,
            title: r.title || r.url,
            sourceTable: "resources",
            sourceId: r.id,
            description: r.summary,
            sourceUrl: r.url,
          }))
        );
      });
    } catch (err) {
      return dbError(c, "resources batch upsert", err, { itemCount: items.length });
    }

    return c.json({ upserted: results.length, results }, 201);
  })

  // ---- GET /search?q=X (full-text search by title/summary/abstract/review) ----

  .get("/search", async (c) => {
    const parsed = SearchQuery.safeParse(c.req.query());
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { q, limit } = parsed.data;
    const rawDb = getDb();

    // Full-text search with prefix matching (same pattern as wiki_pages search)
    const prefixQuery = buildPrefixTsquery(q);

    const rows: ResourceSearchRow[] = prefixQuery
      ? await rawDb.unsafe<ResourceSearchRow[]>(
          `SELECT
          id, url, title, type, summary, review, abstract,
          key_points, publication_id, authors, published_date,
          tags, local_filename, credibility_override,
          fetched_at, content_hash, stable_id,
          fetch_status, last_fetched_at, archive_url,
          created_at, updated_at,
          ts_rank_cd(search_vector, to_tsquery('english', $1), 1) AS rank
        FROM resources
        WHERE search_vector @@ to_tsquery('english', $1)
        ORDER BY rank DESC
        LIMIT $2`,
          [prefixQuery, limit],
        )
      : [];

    return c.json({
      results: rows.map((r) => ({
        id: r.id,
        url: r.url,
        title: r.title,
        type: r.type,
        summary: r.summary,
        review: r.review,
        abstract: r.abstract,
        keyPoints: r.key_points,
        publicationId: r.publication_id,
        authors: r.authors,
        publishedDate: r.published_date,
        tags: r.tags,
        localFilename: r.local_filename,
        credibilityOverride: r.credibility_override,
        fetchedAt: r.fetched_at,
        contentHash: r.content_hash,
        stableId: r.stable_id,
        fetchStatus: r.fetch_status,
        lastFetchedAt: r.last_fetched_at,
        archiveUrl: r.archive_url,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
      count: rows.length,
      query: q,
    });
  })

  // ---- GET /stats ----

  .get("/stats", async (c) => {
    const db = getDrizzleDb();
    const rawDb = getDb();

    const [totalResult, citationCountResult, citedPagesResult, byType] =
      await Promise.all([
        db.select({ count: count() }).from(resources),
        db.select({ count: count() }).from(resourceCitations),
        db
          .select({
            count: sql<number>`count(distinct ${resourceCitations.pageId})`,
          })
          .from(resourceCitations),
        db
          .select({ type: resources.type, count: count() })
          .from(resources)
          .groupBy(resources.type)
          .orderBy(desc(count())),
      ]);

    const totalResources = totalResult[0].count;
    const totalCitations = citationCountResult[0].count;
    const citedPages = Number(citedPagesResult[0].count);

    // Extra stats: orphaned, metadata coverage, fetched count
    // Use raw postgres client for type-parameterized queries (avoids double-cast from db.execute())
    const [orphanedResult, withMetadataResult, fetchedResult] = await Promise.all(
      [
        rawDb<CountRow[]>`
        SELECT count(*) AS c FROM resources r
        LEFT JOIN resource_citations rc ON rc.resource_id = r.id
        WHERE rc.resource_id IS NULL
      `,
        rawDb<CountRow[]>`
        SELECT count(*) AS c FROM resources
        WHERE summary IS NOT NULL OR review IS NOT NULL OR key_points IS NOT NULL
      `,
        rawDb<CountRow[]>`
        SELECT count(*) AS c FROM resources WHERE fetched_at IS NOT NULL
      `,
      ]
    );

    const result: ResourceStatsResult = {
      totalResources,
      totalCitations,
      citedPages,
      byType: Object.fromEntries(
        byType.map((r) => [r.type ?? "unknown", r.count])
      ),
      orphanedCount: Number(orphanedResult[0]?.c ?? 0),
      withMetadata: Number(withMetadataResult[0]?.c ?? 0),
      fetched: Number(fetchedResult[0]?.c ?? 0),
    };

    return c.json(result);
  })

  // ---- GET /by-page/:pageId (resources cited by a page) ----

  .get("/by-page/:pageId", async (c) => {
    const pageId = c.req.param("pageId");
    const db = getDrizzleDb();

    // Phase 4b: resolve slug to integer and query by page_id_int
    const intId = await resolvePageIntId(db, pageId);
    if (intId === null) return c.json({ resources: [] });

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
      .where(eq(resourceCitations.pageIdInt, intId));

    return c.json({ resources: rows });
  })

  // ---- GET /lookup?url=X (lookup by URL, with normalization) ----

  .get("/lookup", async (c) => {
    const url = c.req.query("url");
    if (!url) return validationError(c, "url query parameter is required");

    const db = getDrizzleDb();

    // Try exact match first
    let rows = await db
      .select()
      .from(resources)
      .where(eq(resources.url, url))
      .limit(1);

    // If not found, try normalized variants (www/no-www, trailing slash)
    if (rows.length === 0) {
      const variants = urlVariants(url);
      if (variants.length > 1) {
        const variantList = sql.join(
          variants.map((v) => sql`${v}`),
          sql`, `
        );
        rows = await db
          .select()
          .from(resources)
          .where(sql`${resources.url} IN (${variantList})`)
          .limit(1);
      }
    }

    if (rows.length === 0) {
      return notFoundError(c, `No resource found for URL: ${url}`);
    }

    return c.json(formatResource(rows[0]));
  })

  // ---- GET /all (paginated listing) ----

  .get("/all", async (c) => {
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
  })

  // ---- GET /:id/content (resource + linked fetched content) ----

  .get("/:id/content", async (c) => {
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

    const resource = rows[0];

    // Look up fetched content by exact URL match
    const contentRows = await db
      .select({
        url: citationContent.url,
        fetchedAt: citationContent.fetchedAt,
        httpStatus: citationContent.httpStatus,
        contentType: citationContent.contentType,
        pageTitle: citationContent.pageTitle,
        fullTextPreview: citationContent.fullTextPreview,
        contentLength: citationContent.contentLength,
        contentHash: citationContent.contentHash,
      })
      .from(citationContent)
      .where(eq(citationContent.url, resource.url))
      .limit(1);

    return c.json({
      ...formatResource(resource),
      content: contentRows.length > 0 ? contentRows[0] : null,
    });
  })

  // ---- GET /citations/all (bulk citation index: resourceId → pageIds) ----

  .get("/citations/all", async (c) => {
    const db = getDrizzleDb();
    const rows = await db
      .select({
        resourceId: resourceCitations.resourceId,
        pageId: resourceCitations.pageId,
      })
      .from(resourceCitations);

    // Group by resourceId
    const index: Record<string, string[]> = {};
    for (const row of rows) {
      if (!index[row.resourceId]) index[row.resourceId] = [];
      index[row.resourceId].push(row.pageId);
    }

    return c.json({ citations: index, count: rows.length });
  })

  // ---- PATCH /:id/fetch-status (update fetch status from source-fetcher) ----

  .patch("/:id/fetch-status", async (c) => {
    const id = c.req.param("id");
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = UpdateResourceFetchStatusSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const db = getDrizzleDb();

    const { fetchStatus, lastFetchedAt, fetchedTitle } = parsed.data;

    const updateSet: Record<string, unknown> = {
      fetchStatus,
      lastFetchedAt: new Date(lastFetchedAt),
      updatedAt: sql`now()`,
    };

    // Optionally update title if provided and resource has no title yet
    if (fetchedTitle) {
      updateSet.title = sql`COALESCE(${resources.title}, ${fetchedTitle})`;
    }

    const updated = await db
      .update(resources)
      .set(updateSet)
      .where(eq(resources.id, id))
      .returning({ id: resources.id });

    if (updated.length === 0) {
      return notFoundError(c, `Resource not found: ${id}`);
    }

    logger.info({ resourceId: id, fetchStatus, lastFetchedAt }, "Updated resource fetch status");

    return c.json({ ok: true, id, fetchStatus, lastFetchedAt });
  })

  // ---- GET /:id (get by ID) ----

  .get("/:id", async (c) => {
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

export const resourcesRoute = resourcesApp;
export type ResourcesRoute = typeof resourcesApp;
