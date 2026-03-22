import { Hono } from "hono";
import { z } from "zod";
import { eq, and, count, avg, sql, asc, desc, isNotNull, lt } from "drizzle-orm";
import { getDrizzleDb, getDb } from "../../db.js";
import { citationQuotes, citationContent, citationAccuracySnapshots, wikiPages, resources } from "../../schema.js";
import { checkRefsExist } from "../shared/ref-check.js";
import {
  validationError,
  notFoundError,
  firstOrThrow,
  dbError,
  paginationQuery,
  zv,
} from "../shared/utils.js";
import {
  UpsertCitationQuoteSchema,
  UpsertCitationQuoteBatchSchema,
  MarkAccuracySchema as SharedMarkAccuracySchema,
  UpsertCitationContentSchema,
  CITATION_CONTENT_PREVIEW_MAX,
} from "../../api-types.js";
import { logger } from "../../logger.js";
import { resolvePageIntId, resolvePageIntIds } from "../shared/page-id-helpers.js";

// ---- Constants ----

const BROKEN_SCORE_THRESHOLD = 0.5;
const MAX_PAGE_SIZE = 5000;

// ---- Deprecation helper (#1310) ----
// Citation_quotes write endpoints are deprecated. Use claims + claim_sources instead.
// These endpoints will be removed when the citation_quotes table is dropped (#1311).
function deprecationWarning(endpoint: string): void {
  logger.warn({ endpoint }, "Deprecated endpoint — use claims API instead. Will be removed in #1311.");
}

// ---- Schemas (from shared api-types) ----

const UpsertQuoteSchema = UpsertCitationQuoteSchema;
type UpsertQuoteData = z.infer<typeof UpsertQuoteSchema>;

const UpsertBatchSchema = UpsertCitationQuoteBatchSchema;

const MarkVerifiedSchema = z.object({
  pageId: z.string().min(1).max(200),
  footnote: z.number().int().min(0),
  method: z.string().min(1).max(200),
  score: z.number().min(0).max(1),
});

const MarkAccuracySchema = SharedMarkAccuracySchema;

const UpsertContentSchema = UpsertCitationContentSchema;

const PaginationQuery = paginationQuery({ maxLimit: MAX_PAGE_SIZE, defaultLimit: 100 });

// Query schemas for endpoints that accept only a limit param
const QuotesLimitQuery = z.object({
  page_id: z.string().min(1, "page_id query parameter is required").max(500),
  limit: z.coerce.number().int().min(1).max(500).default(100).catch(100),
});
const TrendsLimitQuery = z.object({
  page_id: z.string().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50).catch(50),
});
const QuotesByUrlQuery = z.object({
  url: z.string().min(1, "url query parameter is required").max(2000),
  limit: z.coerce.number().int().min(1).max(500).default(100).catch(100),
});
const UnverifiedLimitQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(100).catch(100),
});
const CleanupQuery = z.object({
  keep: z.coerce.number().int().min(1).max(1000).default(30).catch(30),
  dry_run: z.string().optional().transform((v) => v === "true" || v === "1"),
});

// ---- Helpers ----

/** Build the values object for a citation quote upsert. */
function quoteValues(d: UpsertQuoteData, pageIdInt: number) {
  return {
    pageId: pageIdInt,
    footnote: d.footnote,
    url: d.url ?? null,
    resourceId: d.resourceId ?? null,
    claimText: d.claimText,
    claimContext: d.claimContext ?? null,
    sourceQuote: d.sourceQuote ?? null,
    sourceLocation: d.sourceLocation ?? null,
    quoteVerified: d.quoteVerified ?? false,
    verificationMethod: d.verificationMethod ?? null,
    verificationScore: d.verificationScore ?? null,
    sourceTitle: d.sourceTitle ?? null,
    sourceType: d.sourceType ?? null,
    extractionModel: d.extractionModel ?? null,
  };
}

/** Shared upsert for single and batch quote operations. */
function upsertQuote(
  db: ReturnType<typeof getDrizzleDb> | Parameters<Parameters<ReturnType<typeof getDrizzleDb>["transaction"]>[0]>[0],
  d: UpsertQuoteData,
  pageId: number
) {
  const vals = quoteValues(d, pageId);
  return db
    .insert(citationQuotes)
    .values(vals)
    .onConflictDoUpdate({
      target: [citationQuotes.pageId, citationQuotes.footnote],
      set: { ...vals, updatedAt: sql`now()` },
    })
    .returning({
      id: citationQuotes.id,
      pageId: citationQuotes.pageId,
      footnote: citationQuotes.footnote,
      createdAt: citationQuotes.createdAt,
      updatedAt: citationQuotes.updatedAt,
    });
}

/**
 * Compute per-page citation health from a set of quote rows.
 * Shared between the /health/:pageId endpoint and batch aggregations.
 */
function computePageHealth(
  pageId: string,
  rows: Array<{
    sourceQuote: string | null;
    quoteVerified: boolean;
    verificationScore: number | null;
    accuracyVerdict: string | null;
    accuracyScore: number | null;
  }>
) {
  let withQuotes = 0;
  let verified = 0;
  let accuracyChecked = 0;
  let accurate = 0;
  let inaccurate = 0;
  let unsupported = 0;
  let minorIssues = 0;
  let notVerifiable = 0;
  let scoreSum = 0;
  let scoreCount = 0;

  for (const q of rows) {
    if (q.sourceQuote != null) withQuotes++;
    if (q.quoteVerified) verified++;
    if (q.verificationScore != null) {
      scoreSum += q.verificationScore;
      scoreCount++;
    }
    if (q.accuracyVerdict != null) {
      accuracyChecked++;
      switch (q.accuracyVerdict) {
        case "accurate": accurate++; break;
        case "inaccurate": inaccurate++; break;
        case "unsupported": unsupported++; break;
        case "minor_issues": minorIssues++; break;
        case "not_verifiable": notVerifiable++; break;
      }
    }
  }

  return {
    pageId,
    total: rows.length,
    withQuotes,
    verified,
    accuracyChecked,
    accurate,
    inaccurate,
    unsupported,
    minorIssues,
    notVerifiable,
    avgScore: scoreCount > 0 ? Math.round((scoreSum / scoreCount) * 100) / 100 : null,
  };
}

const citationsApp = new Hono()
  // ---- GET /health/:pageId ----
  // Per-page citation health summary — used by the Next.js frontend.
  .get("/health/:pageId", async (c) => {
    const pageId = c.req.param("pageId");
    const db = getDrizzleDb();

    // Resolve slug to integer ID
    const intId = await resolvePageIntId(db, pageId);
    if (intId === null) return c.json(computePageHealth(pageId, []));

    const rows = await db
      .select({
        sourceQuote: citationQuotes.sourceQuote,
        quoteVerified: citationQuotes.quoteVerified,
        verificationScore: citationQuotes.verificationScore,
        accuracyVerdict: citationQuotes.accuracyVerdict,
        accuracyScore: citationQuotes.accuracyScore,
      })
      .from(citationQuotes)
      .where(eq(citationQuotes.pageId, intId));

    return c.json(computePageHealth(pageId, rows));
  })

  // ---- POST /quotes/upsert ---- [DEPRECATED: use POST /api/claims + POST /api/claims/:id/sources]
  .post("/quotes/upsert", zv("json", UpsertQuoteSchema), async (c) => {
    deprecationWarning("POST /quotes/upsert");
    const parsed = c.req.valid("json");
    const db = getDrizzleDb();

    // Validate page reference
    const missingPages = await checkRefsExist(db, wikiPages, wikiPages.slug, [parsed.pageId]);
    if (missingPages.length > 0) {
      return validationError(c, `Referenced page not found: ${missingPages.join(", ")}`);
    }

    // Validate resource reference (optional)
    if (parsed.resourceId) {
      const missingRes = await checkRefsExist(db, resources, resources.id, [parsed.resourceId]);
      if (missingRes.length > 0) {
        return validationError(c, `Referenced resource not found: ${missingRes.join(", ")}`);
      }
    }

    // Resolve page slug to integer ID
    const singlePageIdInt = await resolvePageIntId(db, parsed.pageId);
    if (singlePageIdInt === null) {
      return validationError(c, `Could not resolve integer ID for page: ${parsed.pageId}`);
    }
    const rows = await upsertQuote(db, parsed, singlePageIdInt);

    const row = firstOrThrow(rows, "citation quote upsert");
    return c.json({
      id: row.id,
      pageId: parsed.pageId,
      footnote: row.footnote,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }, 200);
  })

  // ---- POST /quotes/upsert-batch ---- [DEPRECATED: use POST /api/claims/batch]
  .post("/quotes/upsert-batch", zv("json", UpsertBatchSchema), async (c) => {
    deprecationWarning("POST /quotes/upsert-batch");
    const { items } = c.req.valid("json");
    const db = getDrizzleDb();

    // Validate page references
    const pageIds = [...new Set(items.map((d) => d.pageId))];
    const missingPages = await checkRefsExist(db, wikiPages, wikiPages.slug, pageIds);
    if (missingPages.length > 0) {
      return validationError(
        c,
        `Referenced pages not found: ${missingPages.join(", ")}`
      );
    }

    // Validate resource references (optional field)
    const resourceIds = [
      ...new Set(items.map((d) => d.resourceId).filter((r): r is string => r != null)),
    ];
    if (resourceIds.length > 0) {
      const missingResources = await checkRefsExist(db, resources, resources.id, resourceIds);
      if (missingResources.length > 0) {
        return validationError(
          c,
          `Referenced resources not found: ${missingResources.join(", ")}`
        );
      }
    }

    let results;
    try {
      results = await db.transaction(async (tx) => {
        // Resolve page slugs to integer IDs inside tx for consistency
        const batchIntIdMap = await resolvePageIntIds(tx, pageIds);
        return await tx
          .insert(citationQuotes)
          .values(items.map((d) => {
            const intId = batchIntIdMap.get(d.pageId) ?? null;
            if (intId === null) {
              throw new Error(`Could not resolve integer ID for page: ${d.pageId}`);
            }
            return quoteValues(d, intId);
          }))
          .onConflictDoUpdate({
            target: [citationQuotes.pageId, citationQuotes.footnote],
            set: {
              url: sql`excluded.url`,
              resourceId: sql`excluded.resource_id`,
              claimText: sql`excluded.claim_text`,
              claimContext: sql`excluded.claim_context`,
              sourceQuote: sql`excluded.source_quote`,
              sourceLocation: sql`excluded.source_location`,
              quoteVerified: sql`excluded.quote_verified`,
              verificationMethod: sql`excluded.verification_method`,
              verificationScore: sql`excluded.verification_score`,
              sourceTitle: sql`excluded.source_title`,
              sourceType: sql`excluded.source_type`,
              extractionModel: sql`excluded.extraction_model`,
              updatedAt: sql`now()`,
            },
          })
          .returning({
            id: citationQuotes.id,
            pageId: citationQuotes.pageId,
            footnote: citationQuotes.footnote,
          });
      });
    } catch (err) {
      return dbError(c, "citation quotes upsert-batch", err, { itemCount: items.length });
    }

    // Build reverse map intId→slug for response
    const intIdToSlug = new Map<number, string>();
    for (const [slug, intId] of (await resolvePageIntIds(db, pageIds)).entries()) {
      if (intId !== null) intIdToSlug.set(intId, slug);
    }

    return c.json({
      results: results.map((r) => ({
        id: r.id,
        pageId: intIdToSlug.get(r.pageId!) ?? "unknown",
        footnote: r.footnote,
      })),
    });
  })

  // ---- GET /quotes?page_id=X ----
  .get("/quotes", zv("query", QuotesLimitQuery), async (c) => {
    const { page_id: pageId, limit } = c.req.valid("query");

    const db = getDrizzleDb();
    const intId = await resolvePageIntId(db, pageId);
    if (intId === null) return c.json({ quotes: [] });

    const rows = await db
      .select()
      .from(citationQuotes)
      .where(eq(citationQuotes.pageId, intId))
      .orderBy(asc(citationQuotes.footnote))
      .limit(limit);

    return c.json({ quotes: rows });
  })

  // ---- GET /quotes/all (paginated) ----
  .get("/quotes/all", zv("query", PaginationQuery), async (c) => {
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const rows = await db
      .select()
      .from(citationQuotes)
      .orderBy(asc(citationQuotes.pageId), asc(citationQuotes.footnote))
      .limit(limit)
      .offset(offset);

    const countResult = await db.select({ count: count() }).from(citationQuotes);
    const total = countResult[0].count;

    return c.json({ quotes: rows, total, limit, offset });
  })

  // ---- POST /quotes/mark-verified ---- [DEPRECATED: update claim_sources.sourceVerdict instead]
  .post("/quotes/mark-verified", zv("json", MarkVerifiedSchema), async (c) => {
    deprecationWarning("POST /quotes/mark-verified");
    const { pageId, footnote, method, score } = c.req.valid("json");
    const db = getDrizzleDb();
    const intId = await resolvePageIntId(db, pageId);
    if (intId === null) return notFoundError(c, `No quote for page=${pageId} footnote=${footnote}`);

    const rows = await db
      .update(citationQuotes)
      .set({
        quoteVerified: true,
        verificationMethod: method,
        verificationScore: score,
        verifiedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(citationQuotes.pageId, intId),
          eq(citationQuotes.footnote, footnote)
        )
      )
      .returning({
        id: citationQuotes.id,
        footnote: citationQuotes.footnote,
      });

    if (rows.length === 0) {
      return notFoundError(c, `No quote for page=${pageId} footnote=${footnote}`);
    }

    return c.json({ updated: true, pageId, footnote });
  })

  // ---- POST /quotes/mark-unverified ---- [DEPRECATED: update claim_sources.sourceVerdict instead]
  .post("/quotes/mark-unverified", zv("json", MarkVerifiedSchema), async (c) => {
    deprecationWarning("POST /quotes/mark-unverified");
    const { pageId, footnote, method, score } = c.req.valid("json");
    const db = getDrizzleDb();
    const intId = await resolvePageIntId(db, pageId);
    if (intId === null) return notFoundError(c, `No quote for page=${pageId} footnote=${footnote}`);

    const rows = await db
      .update(citationQuotes)
      .set({
        quoteVerified: false,
        verificationMethod: method,
        verificationScore: score,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(citationQuotes.pageId, intId),
          eq(citationQuotes.footnote, footnote)
        )
      )
      .returning({
        id: citationQuotes.id,
        footnote: citationQuotes.footnote,
      });

    if (rows.length === 0) {
      return notFoundError(c, `No quote for page=${pageId} footnote=${footnote}`);
    }

    return c.json({ updated: true, pageId, footnote });
  })

  // ---- POST /quotes/mark-accuracy ---- [DEPRECATED: update claims.claimVerdict instead]
  .post("/quotes/mark-accuracy", zv("json", MarkAccuracySchema), async (c) => {
    deprecationWarning("POST /quotes/mark-accuracy");
    const { pageId, footnote, verdict, score, issues, supportingQuotes, verificationDifficulty } = c.req.valid("json");
    const db = getDrizzleDb();
    const intId = await resolvePageIntId(db, pageId);
    if (intId === null) return notFoundError(c, `No quote for page=${pageId} footnote=${footnote}`);

    const rows = await db
      .update(citationQuotes)
      .set({
        accuracyVerdict: verdict,
        accuracyScore: score,
        accuracyIssues: issues ?? null,
        accuracySupportingQuotes: supportingQuotes ?? null,
        verificationDifficulty: verificationDifficulty ?? null,
        accuracyCheckedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(citationQuotes.pageId, intId),
          eq(citationQuotes.footnote, footnote)
        )
      )
      .returning({
        id: citationQuotes.id,
        footnote: citationQuotes.footnote,
      });

    if (rows.length === 0) {
      return notFoundError(c, `No quote for page=${pageId} footnote=${footnote}`);
    }

    return c.json({ updated: true, pageId, footnote, verdict });
  })

  // ---- GET /stats ----
  .get("/stats", async (c) => {
    const db = getDrizzleDb();

    const rows = await db.select({
      totalQuotes: count(),
      withQuotes: sql<number>`count(case when ${citationQuotes.sourceQuote} is not null then 1 end)`,
      verified: sql<number>`count(case when ${citationQuotes.quoteVerified} = true then 1 end)`,
      unverified: sql<number>`count(case when ${citationQuotes.quoteVerified} = false or ${citationQuotes.quoteVerified} is null then 1 end)`,
      totalPages: sql<number>`count(distinct ${citationQuotes.pageId})`,
      averageScore: avg(citationQuotes.verificationScore),
    }).from(citationQuotes);

    const r = rows[0];
    return c.json({
      totalQuotes: r.totalQuotes,
      withQuotes: Number(r.withQuotes),
      verified: Number(r.verified),
      unverified: Number(r.unverified),
      totalPages: Number(r.totalPages),
      averageScore: r.averageScore != null ? Number(r.averageScore) : null,
    });
  })

  // ---- GET /page-stats ----
  .get("/page-stats", async (c) => {
    const db = getDrizzleDb();

    const rows = await db.select({
      pageId: wikiPages.slug,
      total: count(),
      withQuotes: sql<number>`count(case when ${citationQuotes.sourceQuote} is not null then 1 end)`,
      verified: sql<number>`count(case when ${citationQuotes.quoteVerified} = true then 1 end)`,
      avgScore: avg(citationQuotes.verificationScore),
      accuracyChecked: sql<number>`count(case when ${citationQuotes.accuracyVerdict} is not null then 1 end)`,
      accurate: sql<number>`count(case when ${citationQuotes.accuracyVerdict} = 'accurate' then 1 end)`,
      inaccurate: sql<number>`count(case when ${citationQuotes.accuracyVerdict} = 'inaccurate' then 1 end)`,
    })
      .from(citationQuotes)
      .leftJoin(wikiPages, eq(wikiPages.id, citationQuotes.pageId))
      .groupBy(wikiPages.slug)
      .orderBy(asc(wikiPages.slug))
      // Limit raised well above the ~700 page max so that sorting by inaccuracy
      // rate on the client side (e.g. in the accuracy dashboard) sees all pages.
      .limit(5000);

    return c.json({
      pages: rows.map((r) => ({
        pageId: r.pageId,
        total: r.total,
        withQuotes: Number(r.withQuotes),
        verified: Number(r.verified),
        avgScore: r.avgScore != null ? Number(r.avgScore) : null,
        accuracyChecked: Number(r.accuracyChecked),
        accurate: Number(r.accurate),
        inaccurate: Number(r.inaccurate),
      })),
    });
  })

  // ---- GET /accuracy-summary ----
  .get("/accuracy-summary", async (c) => {
    const db = getDrizzleDb();

    const rows = await db.select({
      pageId: wikiPages.slug,
      checked: sql<number>`count(case when ${citationQuotes.accuracyVerdict} is not null then 1 end)`,
      accurate: sql<number>`count(case when ${citationQuotes.accuracyVerdict} = 'accurate' then 1 end)`,
      inaccurate: sql<number>`count(case when ${citationQuotes.accuracyVerdict} = 'inaccurate' then 1 end)`,
      unsupported: sql<number>`count(case when ${citationQuotes.accuracyVerdict} = 'unsupported' then 1 end)`,
    })
      .from(citationQuotes)
      .leftJoin(wikiPages, eq(wikiPages.id, citationQuotes.pageId))
      .groupBy(wikiPages.slug)
      .having(sql`count(case when ${citationQuotes.accuracyVerdict} is not null then 1 end) > 0`)
      .orderBy(asc(wikiPages.slug))
      .limit(500);

    return c.json({
      pages: rows.map((r) => ({
        pageId: r.pageId,
        checked: Number(r.checked),
        accurate: Number(r.accurate),
        inaccurate: Number(r.inaccurate),
        unsupported: Number(r.unsupported),
      })),
    });
  })

  // ---- GET /broken ----
  .get("/broken", async (c) => {
    const db = getDrizzleDb();

    const rows = await db
      .select({
        pageId: wikiPages.slug,
        footnote: citationQuotes.footnote,
        url: citationQuotes.url,
        claimText: citationQuotes.claimText,
        verificationScore: citationQuotes.verificationScore,
      })
      .from(citationQuotes)
      .leftJoin(wikiPages, eq(wikiPages.id, citationQuotes.pageId))
      .where(
        and(
          eq(citationQuotes.quoteVerified, true),
          isNotNull(citationQuotes.verificationScore),
          lt(citationQuotes.verificationScore, BROKEN_SCORE_THRESHOLD)
        )
      )
      .orderBy(
        asc(citationQuotes.verificationScore),
        asc(wikiPages.slug),
        asc(citationQuotes.footnote)
      )
      .limit(500);

    return c.json({ broken: rows });
  })

  // ---- POST /content/upsert ----
  // BREAKING CHANGE (PR #476): This endpoint no longer accepts `pageId` or
  // `footnote` fields. Citation content is now keyed by URL only. External
  // scripts that previously sent pageId/footnote need updating.
  .post("/content/upsert", zv("json", UpsertContentSchema), async (c) => {
    const d = c.req.valid("json");
    const db = getDrizzleDb();

    const vals = {
      url: d.url,
      resourceId: d.resourceId ?? null,
      fetchedAt: new Date(d.fetchedAt),
      httpStatus: d.httpStatus ?? null,
      contentType: d.contentType ?? null,
      pageTitle: d.pageTitle ?? null,
      fullTextPreview: d.fullTextPreview ?? (d.fullText ? d.fullText.slice(0, CITATION_CONTENT_PREVIEW_MAX) : null),
      fullText: d.fullText ?? null,
      contentLength: d.contentLength ?? null,
      contentHash: d.contentHash ?? null,
      fetchMethod: d.fetchMethod ?? null,
    };

    await db
      .insert(citationContent)
      .values(vals)
      .onConflictDoUpdate({
        target: citationContent.url,
        set: { ...vals, updatedAt: sql`now()` },
      });

    return c.json({ url: d.url });
  })

  // ---- POST /accuracy-snapshot ----
  .post("/accuracy-snapshot", async (c) => {
    const db = getDrizzleDb();

    // Compute per-page accuracy stats from current citation_quotes data
    // Group by pageId and LEFT JOIN wiki_pages to get slug
    const pageStats = await db.select({
      pageId: citationQuotes.pageId,
      pageSlug: wikiPages.slug,
      totalCitations: count(),
      checkedCitations: sql<number>`count(case when ${citationQuotes.accuracyVerdict} is not null then 1 end)`,
      accurateCount: sql<number>`count(case when ${citationQuotes.accuracyVerdict} = 'accurate' then 1 end)`,
      minorIssuesCount: sql<number>`count(case when ${citationQuotes.accuracyVerdict} = 'minor_issues' then 1 end)`,
      inaccurateCount: sql<number>`count(case when ${citationQuotes.accuracyVerdict} = 'inaccurate' then 1 end)`,
      unsupportedCount: sql<number>`count(case when ${citationQuotes.accuracyVerdict} = 'unsupported' then 1 end)`,
      notVerifiableCount: sql<number>`count(case when ${citationQuotes.accuracyVerdict} = 'not_verifiable' then 1 end)`,
      averageScore: avg(citationQuotes.accuracyScore),
    })
      .from(citationQuotes)
      .leftJoin(wikiPages, eq(wikiPages.id, citationQuotes.pageId))
      .groupBy(citationQuotes.pageId, wikiPages.slug)
      .having(sql`count(case when ${citationQuotes.accuracyVerdict} is not null then 1 end) > 0`);

    // Insert snapshots for all pages with accuracy data
    let inserted: Array<{ id: number }> = [];
    if (pageStats.length > 0) {
      inserted = await db
        .insert(citationAccuracySnapshots)
        .values(
          pageStats.map((ps) => ({
            pageId: ps.pageId,
            totalCitations: ps.totalCitations,
            checkedCitations: Number(ps.checkedCitations),
            accurateCount: Number(ps.accurateCount),
            minorIssuesCount: Number(ps.minorIssuesCount),
            inaccurateCount: Number(ps.inaccurateCount),
            unsupportedCount: Number(ps.unsupportedCount),
            notVerifiableCount: Number(ps.notVerifiableCount),
            averageScore: ps.averageScore != null ? Number(ps.averageScore) : null,
          }))
        )
        .returning({
          id: citationAccuracySnapshots.id,
        });
    }

    return c.json({
      snapshotCount: inserted.length,
      pages: pageStats.map((ps) => ps.pageSlug ?? "unknown"),
    }, 201);
  })

  // ---- GET /accuracy-trends?page_id=X&limit=N ----
  .get("/accuracy-trends", zv("query", TrendsLimitQuery), async (c) => {
    const { page_id: pageId, limit } = c.req.valid("query");

    const db = getDrizzleDb();

    if (pageId) {
      // Trends for a specific page
      const intId = await resolvePageIntId(db, pageId);
      if (intId === null) return c.json({ pageId, snapshots: [] });

      const rows = await db
        .select()
        .from(citationAccuracySnapshots)
        .where(eq(citationAccuracySnapshots.pageId, intId))
        .orderBy(desc(citationAccuracySnapshots.snapshotAt))
        .limit(limit);

      return c.json({ pageId, snapshots: rows });
    }

    // Global trends: aggregate all snapshots by timestamp
    const rows = await db
      .select({
        snapshotAt: citationAccuracySnapshots.snapshotAt,
        totalPages: sql<number>`count(distinct ${citationAccuracySnapshots.pageId})`,
        totalCitations: sql<number>`sum(${citationAccuracySnapshots.totalCitations})`,
        checkedCitations: sql<number>`sum(${citationAccuracySnapshots.checkedCitations})`,
        accurateCount: sql<number>`sum(${citationAccuracySnapshots.accurateCount})`,
        minorIssuesCount: sql<number>`sum(${citationAccuracySnapshots.minorIssuesCount})`,
        inaccurateCount: sql<number>`sum(${citationAccuracySnapshots.inaccurateCount})`,
        unsupportedCount: sql<number>`sum(${citationAccuracySnapshots.unsupportedCount})`,
        notVerifiableCount: sql<number>`sum(${citationAccuracySnapshots.notVerifiableCount})`,
        averageScore: avg(citationAccuracySnapshots.averageScore),
      })
      .from(citationAccuracySnapshots)
      .groupBy(citationAccuracySnapshots.snapshotAt)
      .orderBy(desc(citationAccuracySnapshots.snapshotAt))
      .limit(limit);

    return c.json({
      snapshots: rows.map((r) => ({
        ...r,
        totalPages: Number(r.totalPages),
        totalCitations: Number(r.totalCitations),
        checkedCitations: Number(r.checkedCitations),
        accurateCount: Number(r.accurateCount),
        minorIssuesCount: Number(r.minorIssuesCount),
        inaccurateCount: Number(r.inaccurateCount),
        unsupportedCount: Number(r.unsupportedCount),
        notVerifiableCount: Number(r.notVerifiableCount),
        averageScore: r.averageScore != null ? Number(r.averageScore) : null,
      })),
    });
  })

  // ---- GET /accuracy-dashboard ----
  // Aggregation is pushed into SQL to avoid loading the full citation_quotes table
  // into memory. Three queries replace the previous single full-scan + in-process loop.
  .get("/accuracy-dashboard", async (c) => {
    const db = getDrizzleDb();

    // --- 1. Overall summary stats ---
    const [summaryRow] = await db.select({
      totalCitations: count(),
      checkedCitations: sql<number>`count(case when ${citationQuotes.accuracyVerdict} is not null then 1 end)`,
      accurateCitations: sql<number>`count(case when ${citationQuotes.accuracyVerdict} = 'accurate' then 1 end)`,
      inaccurateCitations: sql<number>`count(case when ${citationQuotes.accuracyVerdict} = 'inaccurate' then 1 end)`,
      unsupportedCitations: sql<number>`count(case when ${citationQuotes.accuracyVerdict} = 'unsupported' then 1 end)`,
      minorIssueCitations: sql<number>`count(case when ${citationQuotes.accuracyVerdict} = 'minor_issues' then 1 end)`,
      // Only average scores for checked citations (those with a non-null verdict),
      // matching the old JS-loop behaviour that guarded scoreSum inside `if (verdict)`.
      averageScore: avg(sql`CASE WHEN ${citationQuotes.accuracyVerdict} IS NOT NULL THEN ${citationQuotes.accuracyScore} END`),
    }).from(citationQuotes);

    const totalCitations = summaryRow.totalCitations;
    const checkedCitations = Number(summaryRow.checkedCitations);
    const summary = {
      totalCitations,
      checkedCitations,
      accurateCitations: Number(summaryRow.accurateCitations),
      inaccurateCitations: Number(summaryRow.inaccurateCitations),
      unsupportedCitations: Number(summaryRow.unsupportedCitations),
      minorIssueCitations: Number(summaryRow.minorIssueCitations),
      uncheckedCitations: totalCitations - checkedCitations,
      averageScore: summaryRow.averageScore != null
        ? Math.round(Number(summaryRow.averageScore) * 100) / 100
        : null,
    };

    // --- 2. Verdict distribution (GROUP BY verdict, checked only) ---
    const verdictRows = await db.select({
      verdict: citationQuotes.accuracyVerdict,
      cnt: count(),
    })
      .from(citationQuotes)
      .where(isNotNull(citationQuotes.accuracyVerdict))
      .groupBy(citationQuotes.accuracyVerdict);

    const verdictDistribution: Record<string, number> = {};
    for (const r of verdictRows) {
      if (r.verdict) verdictDistribution[r.verdict] = r.cnt;
    }

    // --- 3. Difficulty distribution ---
    const difficultyRows = await db.select({
      difficulty: citationQuotes.verificationDifficulty,
      cnt: count(),
    })
      .from(citationQuotes)
      .where(isNotNull(citationQuotes.verificationDifficulty))
      .groupBy(citationQuotes.verificationDifficulty);

    const difficultyDistribution: Record<string, number> = {};
    for (const r of difficultyRows) {
      if (r.difficulty) difficultyDistribution[r.difficulty] = r.cnt;
    }

    // --- 4. Per-page aggregation (GROUP BY pageId) ---
    // GROUP BY pageId — bounded by number of wiki pages (~700) but a safety LIMIT
    // prevents unbounded result sets if data grows unexpectedly.
    // JS sorts by inaccuracy rate afterward, so all pages must be fetched before slicing.
    const PAGES_HARD_LIMIT = 5000;
    const pageRows = await db.select({
      pageIdSlug: wikiPages.slug,
      totalCitations: count(),
      checked: sql<number>`count(case when ${citationQuotes.accuracyVerdict} is not null then 1 end)`,
      accurate: sql<number>`count(case when ${citationQuotes.accuracyVerdict} = 'accurate' then 1 end)`,
      inaccurate: sql<number>`count(case when ${citationQuotes.accuracyVerdict} = 'inaccurate' then 1 end)`,
      unsupported: sql<number>`count(case when ${citationQuotes.accuracyVerdict} = 'unsupported' then 1 end)`,
      minorIssues: sql<number>`count(case when ${citationQuotes.accuracyVerdict} = 'minor_issues' then 1 end)`,
      // Only average scores for checked citations to match old JS-loop behaviour.
      avgScore: avg(sql`CASE WHEN ${citationQuotes.accuracyVerdict} IS NOT NULL THEN ${citationQuotes.accuracyScore} END`),
    })
      .from(citationQuotes)
      .leftJoin(wikiPages, eq(wikiPages.id, citationQuotes.pageId))
      .groupBy(wikiPages.slug)
      .orderBy(asc(wikiPages.slug))
      .limit(PAGES_HARD_LIMIT);

    const pages = pageRows.map((r) => {
      const checked = Number(r.checked);
      const accurate = Number(r.accurate);
      const inaccurate = Number(r.inaccurate);
      const unsupported = Number(r.unsupported);
      const minorIssues = Number(r.minorIssues);
      return {
        pageId: r.pageIdSlug ?? "unknown",
        totalCitations: r.totalCitations,
        checked,
        accurate,
        inaccurate,
        unsupported,
        minorIssues,
        accuracyRate: checked > 0 ? Math.round(((accurate + minorIssues) / checked) * 100) / 100 : null,
        avgScore: r.avgScore != null ? Math.round(Number(r.avgScore) * 100) / 100 : null,
      };
    });
    pages.sort((a, b) => {
      const aInacc = a.checked > 0 ? (a.inaccurate + a.unsupported) / a.checked : 0;
      const bInacc = b.checked > 0 ? (b.inaccurate + b.unsupported) / b.checked : 0;
      if (bInacc !== aInacc) return bInacc - aInacc;
      return b.totalCitations - a.totalCitations;
    });

    // --- 5. Domain aggregation (GROUP BY extracted hostname) ---
    // PostgreSQL regexp_replace strips scheme and www. prefix to yield the bare domain.
    const domainRows = await db.select({
      domain: sql<string>`regexp_replace(${citationQuotes.url}, '^https?://(www\\.)?([^/?#]+).*', '\\2')`,
      totalCitations: count(),
      checked: sql<number>`count(case when ${citationQuotes.accuracyVerdict} is not null then 1 end)`,
      accurate: sql<number>`count(case when ${citationQuotes.accuracyVerdict} = 'accurate' then 1 end)`,
      inaccurate: sql<number>`count(case when ${citationQuotes.accuracyVerdict} = 'inaccurate' then 1 end)`,
      unsupported: sql<number>`count(case when ${citationQuotes.accuracyVerdict} = 'unsupported' then 1 end)`,
      minorIssues: sql<number>`count(case when ${citationQuotes.accuracyVerdict} = 'minor_issues' then 1 end)`,
    })
      .from(citationQuotes)
      .where(isNotNull(citationQuotes.url))
      .groupBy(sql`regexp_replace(${citationQuotes.url}, '^https?://(www\\.)?([^/?#]+).*', '\\2')`)
      .having(sql`count(*) >= 2`)
      .orderBy(desc(sql`count(*)`))
      .limit(200);

    const domainAnalysis = domainRows.map((r) => {
      const checked = Number(r.checked);
      const inaccurate = Number(r.inaccurate);
      const unsupported = Number(r.unsupported);
      return {
        domain: r.domain,
        totalCitations: r.totalCitations,
        checked,
        accurate: Number(r.accurate),
        inaccurate,
        unsupported,
        minorIssues: Number(r.minorIssues),
        inaccuracyRate: checked > 0 ? Math.round(((inaccurate + unsupported) / checked) * 100) / 100 : null,
      };
    });
    domainAnalysis.sort((a, b) => {
      const aRate = a.inaccuracyRate ?? 0;
      const bRate = b.inaccuracyRate ?? 0;
      if (bRate !== aRate) return bRate - aRate;
      return b.totalCitations - a.totalCitations;
    });

    // --- 6. Flagged citations (inaccurate or unsupported, worst score first) ---
    const flaggedRows = await db.select({
      pageSlug: wikiPages.slug,
      footnote: citationQuotes.footnote,
      claimText: citationQuotes.claimText,
      sourceTitle: citationQuotes.sourceTitle,
      url: citationQuotes.url,
      verdict: citationQuotes.accuracyVerdict,
      score: citationQuotes.accuracyScore,
      issues: citationQuotes.accuracyIssues,
      difficulty: citationQuotes.verificationDifficulty,
      checkedAt: citationQuotes.accuracyCheckedAt,
    })
      .from(citationQuotes)
      .leftJoin(wikiPages, eq(citationQuotes.pageId, wikiPages.id))
      .where(sql`${citationQuotes.accuracyVerdict} in ('inaccurate', 'unsupported')`)
      .orderBy(asc(citationQuotes.accuracyScore))
      .limit(500);

    const flaggedCitations = flaggedRows.map((q) => ({
      pageId: q.pageSlug ?? "",
      footnote: q.footnote,
      claimText: q.claimText.length > 150 ? q.claimText.slice(0, 150) + '...' : q.claimText,
      sourceTitle: q.sourceTitle,
      url: q.url,
      verdict: q.verdict ?? '',
      score: q.score,
      issues: q.issues,
      difficulty: q.difficulty,
      checkedAt: q.checkedAt?.toISOString() ?? null,
    }));

    return c.json({
      exportedAt: new Date().toISOString(),
      summary,
      verdictDistribution,
      difficultyDistribution,
      pages,
      flaggedCitations,
      domainAnalysis,
    });
  })

  // ---- GET /content?url=X ----
  .get("/content", async (c) => {
    const url = c.req.query("url");
    if (!url) return validationError(c, "url query parameter is required");

    const db = getDrizzleDb();
    const rows = await db
      .select()
      .from(citationContent)
      .where(eq(citationContent.url, url))
      .limit(1);

    if (rows.length === 0) {
      return notFoundError(c, `No content for url: ${url}`);
    }

    return c.json(rows[0]);
  })

  // ---- GET /content/list (paginated, metadata only — no full_text) ----
  .get("/content/list", zv("query", PaginationQuery), async (c) => {
    const { limit, offset } = c.req.valid("query");
    const db = getDrizzleDb();

    const rows = await db
      .select({
        url: citationContent.url,
        fetchedAt: citationContent.fetchedAt,
        httpStatus: citationContent.httpStatus,
        contentType: citationContent.contentType,
        pageTitle: citationContent.pageTitle,
        contentLength: citationContent.contentLength,
        contentHash: citationContent.contentHash,
        hasFullText: sql<boolean>`(${citationContent.fullText} IS NOT NULL)`,
        hasPreview: sql<boolean>`(${citationContent.fullTextPreview} IS NOT NULL)`,
        createdAt: citationContent.createdAt,
        updatedAt: citationContent.updatedAt,
      })
      .from(citationContent)
      .orderBy(desc(citationContent.fetchedAt))
      .limit(limit)
      .offset(offset);

    // Single aggregate query — avoids 3 separate round-trips and is consistent
    const aggregates = await db.select({
      total: count(),
      withFullText: sql<number>`count(case when ${citationContent.fullText} is not null then 1 end)`,
      withPreview: sql<number>`count(case when ${citationContent.fullTextPreview} is not null then 1 end)`,
    }).from(citationContent);

    return c.json({
      entries: rows,
      total: aggregates[0].total,
      withFullText: Number(aggregates[0].withFullText),
      withPreview: Number(aggregates[0].withPreview),
      limit,
      offset,
    });
  })

  // ---- GET /content/stats ----
  .get("/content/stats", async (c) => {
    const db = getDrizzleDb();

    const rows = await db.select({
      total: count(),
      withFullText: sql<number>`count(case when ${citationContent.fullText} is not null then 1 end)`,
      withPreview: sql<number>`count(case when ${citationContent.fullTextPreview} is not null then 1 end)`,
      okCount: sql<number>`count(case when ${citationContent.httpStatus} = 200 then 1 end)`,
      deadCount: sql<number>`count(case when ${citationContent.httpStatus} >= 400 then 1 end)`,
      avgContentLength: avg(citationContent.contentLength),
    }).from(citationContent);

    const r = rows[0];
    return c.json({
      total: r.total,
      withFullText: Number(r.withFullText),
      withPreview: Number(r.withPreview),
      coverage: r.total > 0 ? Math.round((Number(r.withFullText) / r.total) * 100) : 0,
      okCount: Number(r.okCount),
      deadCount: Number(r.deadCount),
      avgContentLength: r.avgContentLength != null ? Math.round(Number(r.avgContentLength)) : null,
    });
  })

  // ---- POST /content/link-resources ----
  // Batch-links citation_content rows to their matching resources by URL.
  // This bridges the gap between fetched content (URL-keyed) and curated resources (ID-keyed).
  .post("/content/link-resources", async (c) => {
    const db = getDrizzleDb();

    // Find all citation_content rows that have no resource_id
    // and match a resource by URL.
    let result;
    try {
      result = await db.execute(sql`
      UPDATE citation_content cc
      SET resource_id = r.id
      FROM resources r
      WHERE cc.url = r.url
        AND cc.resource_id IS NULL
    `);
    } catch (err) {
      return dbError(c, "citation content link-resources", err);
    }

    const linked = "count" in result ? Number(result.count) : 0;
    return c.json({ linked });
  })

  // ---- GET /quotes-by-url?url=X ----
  // Returns all citation quotes across all pages for a given source URL.
  // Used by resource pages to show cross-page citations.
  .get("/quotes-by-url", zv("query", QuotesByUrlQuery), async (c) => {
    const { url, limit } = c.req.valid("query");

    const db = getDrizzleDb();
    const rows = await db
      .select()
      .from(citationQuotes)
      .where(eq(citationQuotes.url, url))
      .orderBy(asc(citationQuotes.pageId), asc(citationQuotes.footnote))
      .limit(limit);

    // Also get aggregate stats
    const stats = await db
      .select({
        totalPages: sql<number>`count(distinct ${citationQuotes.pageId})`,
        totalQuotes: count(),
        verified: sql<number>`count(case when ${citationQuotes.quoteVerified} = true then 1 end)`,
        accurate: sql<number>`count(case when ${citationQuotes.accuracyVerdict} = 'accurate' then 1 end)`,
        inaccurate: sql<number>`count(case when ${citationQuotes.accuracyVerdict} = 'inaccurate' then 1 end)`,
        unsupported: sql<number>`count(case when ${citationQuotes.accuracyVerdict} = 'unsupported' then 1 end)`,
        minorIssues: sql<number>`count(case when ${citationQuotes.accuracyVerdict} = 'minor_issues' then 1 end)`,
      })
      .from(citationQuotes)
      .where(eq(citationQuotes.url, url));

    const s = stats[0];
    return c.json({
      quotes: rows,
      stats: {
        totalPages: Number(s.totalPages),
        totalQuotes: s.totalQuotes,
        verified: Number(s.verified),
        accurate: Number(s.accurate),
        inaccurate: Number(s.inaccurate),
        unsupported: Number(s.unsupported),
        minorIssues: Number(s.minorIssues),
      },
    });
  })

  // ---- PATCH /quotes/:id/link-claim ---- [REMOVED: claims tables archived by migration 0065]
  .patch("/quotes/:id/link-claim", async (c) => {
    return c.json(
      { error: "Claim linking is no longer supported. The claims tables were archived by migration 0065." },
      410,
    );
  })

  // ---- POST /quotes/link-claims-batch ---- [REMOVED: claims tables archived by migration 0065]
  .post("/quotes/link-claims-batch", async (c) => {
    return c.json(
      { error: "Claim linking is no longer supported. The claims tables were archived by migration 0065." },
      410,
    );
  })

  // NOTE: POST /quotes/propagate-from-claims was removed in #1310.
  // Backward propagation from claims → citation_quotes is no longer needed
  // since claims is now the single source of truth for verification data.

  // ---- GET /source-type-stats ----
  .get("/source-type-stats", async (c) => {
    const db = getDrizzleDb();

    const rows = await db
      .select({
        sourceType: sql<string>`coalesce(${citationQuotes.sourceType}, 'unknown')`,
        count: count(),
        withQuotes: sql<number>`count(case when ${citationQuotes.sourceQuote} is not null and ${citationQuotes.sourceQuote} != '' then 1 end)`,
      })
      .from(citationQuotes)
      .groupBy(citationQuotes.sourceType)
      .orderBy(desc(count()));

    return c.json({
      stats: rows.map((r) => ({
        sourceType: r.sourceType,
        count: r.count,
        withQuotes: Number(r.withQuotes),
      })),
    });
  })

  // ---- GET /pages-with-quotes ----
  .get("/pages-with-quotes", async (c) => {
    const db = getDrizzleDb();

    const rows = await db
      .select({
        pageId: wikiPages.slug,
        quoteCount: count(),
      })
      .from(citationQuotes)
      .leftJoin(wikiPages, eq(wikiPages.id, citationQuotes.pageId))
      .where(
        and(
          isNotNull(citationQuotes.sourceQuote),
          sql`${citationQuotes.sourceQuote} != ''`
        )
      )
      .groupBy(wikiPages.slug)
      .orderBy(desc(count()));

    return c.json({
      pages: rows.map((r) => ({
        pageId: r.pageId,
        quoteCount: r.quoteCount,
      })),
    });
  })

  // ---- GET /unverified ----
  .get("/unverified", zv("query", UnverifiedLimitQuery), async (c) => {
    const { limit } = c.req.valid("query");

    const db = getDrizzleDb();

    const rows = await db
      .select()
      .from(citationQuotes)
      .where(
        and(
          isNotNull(citationQuotes.sourceQuote),
          sql`${citationQuotes.sourceQuote} != ''`,
          eq(citationQuotes.quoteVerified, false)
        )
      )
      .orderBy(asc(citationQuotes.createdAt))
      .limit(limit);

    return c.json({ quotes: rows });
  })

  // ---- GET /quotes/:pageId/:footnote ----
  .get("/quotes/:pageId/:footnote", async (c) => {
    const pageId = c.req.param("pageId");
    const footnoteStr = c.req.param("footnote");
    const footnote = parseInt(footnoteStr, 10);
    if (isNaN(footnote)) return validationError(c, "footnote must be a number");

    const db = getDrizzleDb();
    const intId = await resolvePageIntId(db, pageId);
    if (intId === null) return notFoundError(c, `No quote for page=${pageId} footnote=${footnote}`);

    const rows = await db
      .select()
      .from(citationQuotes)
      .where(
        and(
          eq(citationQuotes.pageId, intId),
          eq(citationQuotes.footnote, footnote)
        )
      )
      .limit(1);

    if (rows.length === 0) {
      return notFoundError(c, `No quote for page=${pageId} footnote=${footnote}`);
    }

    return c.json({ quote: rows[0] });
  })

  // ---- DELETE /accuracy-snapshots/cleanup (retention: keep latest N snapshots per page) ----
  .delete("/accuracy-snapshots/cleanup", zv("query", CleanupQuery), async (c) => {
    const { keep, dry_run: dryRun } = c.req.valid("query");

    const rawDb = getDb();

    if (dryRun) {
      const result = await rawDb`
        SELECT count(*)::int AS count
        FROM citation_accuracy_snapshots cas
        WHERE id NOT IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (
              -- COALESCE to -1 so NULL page_id rows don't all collapse into one partition
              PARTITION BY COALESCE(page_id, -1) ORDER BY snapshot_at DESC
            ) AS rn
            FROM citation_accuracy_snapshots
          ) ranked
          WHERE rn <= ${keep}
        )
      `;
      const wouldDelete = result[0]?.count ?? 0;

      const totalResult = await rawDb`
        SELECT count(*)::int AS total FROM citation_accuracy_snapshots
      `;
      const total = totalResult[0]?.total ?? 0;

      return c.json({
        dryRun: true,
        keep,
        totalSnapshots: total,
        wouldDelete,
        wouldRetain: total - wouldDelete,
      });
    }

    logger.info({ keep }, "Deleting old citation accuracy snapshots");
    const result = await rawDb`
      DELETE FROM citation_accuracy_snapshots
      WHERE id NOT IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (
            -- COALESCE to -1 so NULL page_id rows don't all collapse into one partition
            PARTITION BY COALESCE(page_id, -1) ORDER BY snapshot_at DESC
          ) AS rn
          FROM citation_accuracy_snapshots
        ) ranked
        WHERE rn <= ${keep}
      )
    `;

    return c.json({ deleted: result.count, keep });
  });

export const citationsRoute = citationsApp;
export type CitationsRoute = typeof citationsApp;
