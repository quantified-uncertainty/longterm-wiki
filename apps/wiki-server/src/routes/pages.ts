import { Hono } from "hono";
import { z } from "zod";
import { eq, or, and, count, asc, sql } from "drizzle-orm";
import { getDrizzleDb, getDb } from "../db.js";
import { wikiPages, entityIds } from "../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  notFoundError,
  dbError,
  paginationQuery,
} from "./utils.js";
import {
  SyncPageSchema as SharedSyncPageSchema,
  SyncPagesBatchSchema,
} from "../api-types.js";
import {
  buildPrefixTsquery,
  TRIGRAM_SIMILARITY_THRESHOLD,
  TRIGRAM_FALLBACK_THRESHOLD,
  TS_HEADLINE_OPTIONS,
} from "../search-utils.js";

// ---- Raw SQL row types ----

/** Row shape returned by the FTS and trigram search queries. */
interface PageSearchRow {
  id: string;
  numeric_id: string | null;
  title: string;
  description: string | null;
  entity_type: string | null;
  category: string | null;
  reader_importance: number | null;
  quality: number | null;
  rank: number;
  snippet: string | null;
}

// ---- Constants ----

const MAX_PAGE_SIZE = 200;

// ---- Schemas (from shared api-types) ----

// Re-exported so external consumers (e.g. tests) can import them by name.
export const SyncPageSchema = SharedSyncPageSchema;
export const SyncBatchSchema = SyncPagesBatchSchema;

const SearchQuery = z.object({
  q: z.string().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const PaginationQuery = paginationQuery({ maxLimit: MAX_PAGE_SIZE }).extend({
  category: z.string().max(100).optional(),
  entityType: z.string().max(100).optional(),
});

const pagesApp = new Hono()
  // ---- GET /search?q=...&limit=20 ----
  .get("/search", async (c) => {
    const parsed = SearchQuery.safeParse(c.req.query());
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { q, limit } = parsed.data;
    const rawDb = getDb();

    // Phase 1: Prefix search with to_tsquery — supports search-as-you-type.
    // Each word gets a :* suffix for prefix matching, ANDed together.
    // Weighted ranking: title (A=1.0), description (B=0.4), llm_summary (C=0.2), tags+entityType (D=0.1).
    const prefixQuery = buildPrefixTsquery(q);

    let results: PageSearchRow[] = [];

    if (prefixQuery) {
      results = (await rawDb.unsafe(
        `SELECT
        id, numeric_id, title, description, entity_type, category,
        reader_importance, quality,
        ts_rank_cd(search_vector, to_tsquery('english', $1), 1) AS rank,
        ts_headline('english', coalesce(description, ''),
          to_tsquery('english', $1),
          '${TS_HEADLINE_OPTIONS}'
        ) AS snippet
      FROM wiki_pages
      WHERE search_vector @@ to_tsquery('english', $1)
        AND numeric_id IS NOT NULL
      ORDER BY rank DESC, reader_importance DESC NULLS LAST
      LIMIT $2`,
        [prefixQuery, limit],
      )) as unknown as PageSearchRow[];
    }

    // Phase 2: If FTS returned few results, fall back to pg_trgm similarity
    // for typo tolerance (e.g. "antrhopic" → "anthropic").
    if (results.length < TRIGRAM_FALLBACK_THRESHOLD) {
      const trigramResults = await rawDb.unsafe(
        `SELECT
        id, numeric_id, title, description, entity_type, category,
        reader_importance, quality,
        similarity(title, $1) AS rank,
        description AS snippet
      FROM wiki_pages
      WHERE word_count > 0
        AND numeric_id IS NOT NULL
        AND similarity(title, $1) > ${TRIGRAM_SIMILARITY_THRESHOLD}
        AND id NOT IN (SELECT unnest($3::text[]))
      ORDER BY similarity(title, $1) DESC, reader_importance DESC NULLS LAST
      LIMIT $2`,
        [q, limit - results.length, results.map((r) => r.id)],
      );
      results = [...results, ...(trigramResults as unknown as PageSearchRow[])];
    }

    return c.json({
      results: results.map((r) => ({
        id: r.id,
        numericId: r.numeric_id,
        title: r.title,
        description: r.description,
        entityType: r.entity_type,
        category: r.category,
        readerImportance: r.reader_importance,
        quality: r.quality,
        score: parseFloat(String(r.rank)),
        snippet: r.snippet || null,
      })),
      query: q,
      total: results.length,
    });
  })

  // ---- GET /:id ----

  .get("/:id", async (c) => {
    const id = c.req.param("id");
    if (!id) return validationError(c, "Page ID is required");

    const db = getDrizzleDb();

    // If the ID looks like a numeric entity ID (E42), resolve to slug via entityIds table.
    // The wiki_pages.numeric_id column is sparsely populated, so we use the authoritative
    // entityIds table for the mapping and fall back to wiki_pages.numeric_id for legacy data.
    let resolvedSlug: string | null = null;
    if (/^E\d+$/i.test(id)) {
      const numericValue = parseInt(id.slice(1), 10);
      const idRows = await db
        .select({ slug: entityIds.slug })
        .from(entityIds)
        .where(eq(entityIds.numericId, numericValue));
      if (idRows.length > 0) {
        resolvedSlug = idRows[0].slug;
      }
    }

    // Look up by resolved slug, original ID as slug, or legacy numericId column
    const lookupSlug = resolvedSlug || id;
    const rows = await db
      .select()
      .from(wikiPages)
      .where(or(eq(wikiPages.id, lookupSlug), eq(wikiPages.numericId, id)));

    if (rows.length === 0) {
      return notFoundError(c, `No page found for id: ${id}`);
    }

    const page = rows[0];
    // Use the canonical numeric ID from the entityIds resolution if available,
    // falling back to whatever is stored in wiki_pages
    const numericId = resolvedSlug ? id.toUpperCase() : page.numericId;
    return c.json({
      id: page.id,
      numericId,
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
  })

  // ---- GET / (paginated listing) ----

  .get("/", async (c) => {
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
  })

  // ---- DELETE /:id ----

  .delete("/:id", async (c) => {
    const id = c.req.param("id");
    if (!id) return validationError(c, "Page ID is required");

    const db = getDrizzleDb();

    const deleted = await db
      .delete(wikiPages)
      .where(eq(wikiPages.id, id))
      .returning({ id: wikiPages.id });

    if (deleted.length === 0) {
      return notFoundError(c, `No page found for id: ${id}`);
    }

    return c.json({ deleted: deleted.length });
  })

  // ---- POST /sync ----

  .post("/sync", async (c) => {
    const body = await parseJsonBody(c);
    if (!body) return invalidJsonError(c);

    const parsed = SyncBatchSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.message);

    const { pages, syncedFromBranch, syncedFromCommit } = parsed.data;
    const db = getDrizzleDb();
    let upserted = 0;

    const pageIds = pages.map((p) => p.id);

    try {
     await db.transaction(async (tx) => {
      const allVals = pages.map((page) => ({
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
        researchImportance: page.researchImportance ?? null,
        tacticalValue: page.tacticalValue ?? null,
        backlinkCount: page.backlinkCount ?? null,
        riskCategory: page.riskCategory ?? null,
        dateCreated: page.dateCreated ?? null,
        recommendedScore: page.recommendedScore ?? null,
        clusters: page.clusters ?? null,
        hallucinationRiskLevel: page.hallucinationRiskLevel ?? null,
        hallucinationRiskScore: page.hallucinationRiskScore ?? null,
        contentPlaintext: page.contentPlaintext ?? null,
        wordCount: page.wordCount ?? null,
        lastUpdated: page.lastUpdated ?? null,
        contentFormat: page.contentFormat ?? null,
        syncedFromBranch: syncedFromBranch ?? null,
        syncedFromCommit: syncedFromCommit ?? null,
      }));

      await tx
        .insert(wikiPages)
        .values(allVals)
        .onConflictDoUpdate({
          target: wikiPages.id,
          set: {
            numericId: sql`excluded.numeric_id`,
            title: sql`excluded.title`,
            description: sql`excluded.description`,
            llmSummary: sql`excluded.llm_summary`,
            category: sql`excluded.category`,
            subcategory: sql`excluded.subcategory`,
            entityType: sql`excluded.entity_type`,
            tags: sql`excluded.tags`,
            quality: sql`excluded.quality`,
            readerImportance: sql`excluded.reader_importance`,
            researchImportance: sql`excluded.research_importance`,
            tacticalValue: sql`excluded.tactical_value`,
            backlinkCount: sql`excluded.backlink_count`,
            riskCategory: sql`excluded.risk_category`,
            dateCreated: sql`excluded.date_created`,
            recommendedScore: sql`excluded.recommended_score`,
            clusters: sql`excluded.clusters`,
            hallucinationRiskLevel: sql`excluded.hallucination_risk_level`,
            hallucinationRiskScore: sql`excluded.hallucination_risk_score`,
            contentPlaintext: sql`excluded.content_plaintext`,
            wordCount: sql`excluded.word_count`,
            lastUpdated: sql`excluded.last_updated`,
            contentFormat: sql`excluded.content_format`,
            syncedFromBranch: sql`excluded.synced_from_branch`,
            syncedFromCommit: sql`excluded.synced_from_commit`,
            syncedAt: sql`now()`,
            updatedAt: sql`now()`,
          },
        });
      upserted = allVals.length;

      // Update search vectors inside the same transaction
      const idList = sql.join(pageIds.map(id => sql`${id}`), sql`, `);
      await tx.execute(sql`
        UPDATE wiki_pages SET search_vector =
          setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
          setweight(to_tsvector('english', coalesce(description, '')), 'B') ||
          setweight(to_tsvector('english', coalesce(llm_summary, '')), 'C') ||
          setweight(to_tsvector('english', coalesce(tags, '')), 'D') ||
          setweight(to_tsvector('english', coalesce(entity_type, '')), 'D')
        WHERE id IN (${idList})
      `);
    });
    } catch (err) {
      return dbError(c, "pages sync", err, { pageCount: pages.length });
    }

    return c.json({ upserted });
  });

export const pagesRoute = pagesApp;
export type PagesRoute = typeof pagesApp;
