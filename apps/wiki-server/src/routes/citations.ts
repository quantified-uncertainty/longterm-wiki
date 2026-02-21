import { Hono } from "hono";
import { z } from "zod";
import { eq, and, count, avg, sql, asc, desc, isNotNull, lt } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import { citationQuotes, citationContent, citationAccuracySnapshots } from "../schema.js";
import {
  parseJsonBody,
  validationError,
  invalidJsonError,
  notFoundError,
} from "./utils.js";

export const citationsRoute = new Hono();

// ---- Constants ----

const BROKEN_SCORE_THRESHOLD = 0.5;
const MAX_BATCH_SIZE = 100;
const MAX_PAGE_SIZE = 1000;
const MAX_PREVIEW_LENGTH = 50 * 1024; // 50KB

// ---- Schemas ----

const UpsertQuoteSchema = z.object({
  pageId: z.string().min(1).max(200),
  footnote: z.number().int().min(0),
  url: z.string().max(2000).nullable().optional(),
  resourceId: z.string().max(200).nullable().optional(),
  claimText: z.string().min(1).max(10000),
  claimContext: z.string().max(10000).nullable().optional(),
  sourceQuote: z.string().max(10000).nullable().optional(),
  sourceLocation: z.string().max(1000).nullable().optional(),
  quoteVerified: z.boolean().optional(),
  verificationMethod: z.string().max(200).nullable().optional(),
  verificationScore: z.number().min(0).max(1).nullable().optional(),
  sourceTitle: z.string().max(1000).nullable().optional(),
  sourceType: z.string().max(100).nullable().optional(),
  extractionModel: z.string().max(200).nullable().optional(),
});

type UpsertQuoteData = z.infer<typeof UpsertQuoteSchema>;

const UpsertBatchSchema = z.object({
  items: z.array(UpsertQuoteSchema).min(1).max(MAX_BATCH_SIZE),
});

const MarkVerifiedSchema = z.object({
  pageId: z.string().min(1).max(200),
  footnote: z.number().int().min(0),
  method: z.string().min(1).max(200),
  score: z.number().min(0).max(1),
});

const VALID_VERDICTS = ["accurate", "inaccurate", "unsupported", "minor_issues", "not_verifiable"] as const;

const MarkAccuracySchema = z.object({
  pageId: z.string().min(1).max(200),
  footnote: z.number().int().min(0),
  verdict: z.enum(VALID_VERDICTS),
  score: z.number().min(0).max(1),
  issues: z.string().max(10000).nullable().optional(),
  supportingQuotes: z.string().max(10000).nullable().optional(),
  verificationDifficulty: z.enum(["easy", "moderate", "hard"]).nullable().optional(),
});

const MarkAccuracyBatchSchema = z.object({
  items: z.array(MarkAccuracySchema).min(1).max(MAX_BATCH_SIZE),
});

const UpsertContentSchema = z.object({
  url: z.string().min(1).max(2000),
  fetchedAt: z.string().datetime(),
  httpStatus: z.number().int().nullable().optional(),
  contentType: z.string().max(200).nullable().optional(),
  pageTitle: z.string().max(1000).nullable().optional(),
  fullTextPreview: z.string().max(MAX_PREVIEW_LENGTH).nullable().optional(),
  contentLength: z.number().int().nullable().optional(),
  contentHash: z.string().max(64).nullable().optional(),
});

const PaginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---- Helpers ----

/** Build the values object for a citation quote upsert. */
function quoteValues(d: UpsertQuoteData) {
  return {
    pageId: d.pageId,
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
  d: UpsertQuoteData
) {
  const vals = quoteValues(d);
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

// ---- POST /quotes/upsert ----

citationsRoute.post("/quotes/upsert", async (c) => {
  const body = await parseJsonBody(c);
  if (!body) return invalidJsonError(c);

  const parsed = UpsertQuoteSchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.message);

  const db = getDrizzleDb();
  const rows = await upsertQuote(db, parsed.data);

  const row = rows[0];
  return c.json({
    id: row.id,
    pageId: row.pageId,
    footnote: row.footnote,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }, 200);
});

// ---- POST /quotes/upsert-batch ----

citationsRoute.post("/quotes/upsert-batch", async (c) => {
  const body = await parseJsonBody(c);
  if (!body) return invalidJsonError(c);

  const parsed = UpsertBatchSchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { items } = parsed.data;
  const db = getDrizzleDb();

  const results = await db.transaction(async (tx) => {
    return await tx
      .insert(citationQuotes)
      .values(items.map((d) => quoteValues(d)))
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

  return c.json({ results });
});

// ---- GET /quotes?page_id=X ----

citationsRoute.get("/quotes", async (c) => {
  const pageId = c.req.query("page_id");
  if (!pageId) return validationError(c, "page_id query parameter is required");

  const db = getDrizzleDb();
  const rows = await db
    .select()
    .from(citationQuotes)
    .where(eq(citationQuotes.pageId, pageId))
    .orderBy(asc(citationQuotes.footnote));

  return c.json({ quotes: rows });
});

// ---- GET /quotes/all (paginated) ----

citationsRoute.get("/quotes/all", async (c) => {
  const parsed = PaginationQuery.safeParse(c.req.query());
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { limit, offset } = parsed.data;
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
});

// ---- POST /quotes/mark-verified ----

citationsRoute.post("/quotes/mark-verified", async (c) => {
  const body = await parseJsonBody(c);
  if (!body) return invalidJsonError(c);

  const parsed = MarkVerifiedSchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { pageId, footnote, method, score } = parsed.data;
  const db = getDrizzleDb();

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
        eq(citationQuotes.pageId, pageId),
        eq(citationQuotes.footnote, footnote)
      )
    )
    .returning({
      id: citationQuotes.id,
      pageId: citationQuotes.pageId,
      footnote: citationQuotes.footnote,
    });

  if (rows.length === 0) {
    return notFoundError(c, `No quote for page=${pageId} footnote=${footnote}`);
  }

  return c.json({ updated: true, pageId, footnote });
});

// ---- POST /quotes/mark-accuracy ----

citationsRoute.post("/quotes/mark-accuracy", async (c) => {
  const body = await parseJsonBody(c);
  if (!body) return invalidJsonError(c);

  const parsed = MarkAccuracySchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { pageId, footnote, verdict, score, issues, supportingQuotes, verificationDifficulty } = parsed.data;
  const db = getDrizzleDb();

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
        eq(citationQuotes.pageId, pageId),
        eq(citationQuotes.footnote, footnote)
      )
    )
    .returning({
      id: citationQuotes.id,
      pageId: citationQuotes.pageId,
      footnote: citationQuotes.footnote,
    });

  if (rows.length === 0) {
    return notFoundError(c, `No quote for page=${pageId} footnote=${footnote}`);
  }

  return c.json({ updated: true, pageId, footnote, verdict });
});

// ---- GET /stats ----

citationsRoute.get("/stats", async (c) => {
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
});

// ---- GET /page-stats ----

citationsRoute.get("/page-stats", async (c) => {
  const db = getDrizzleDb();

  const rows = await db.select({
    pageId: citationQuotes.pageId,
    total: count(),
    withQuotes: sql<number>`count(case when ${citationQuotes.sourceQuote} is not null then 1 end)`,
    verified: sql<number>`count(case when ${citationQuotes.quoteVerified} = true then 1 end)`,
    avgScore: avg(citationQuotes.verificationScore),
    accuracyChecked: sql<number>`count(case when ${citationQuotes.accuracyVerdict} is not null then 1 end)`,
    accurate: sql<number>`count(case when ${citationQuotes.accuracyVerdict} = 'accurate' then 1 end)`,
    inaccurate: sql<number>`count(case when ${citationQuotes.accuracyVerdict} = 'inaccurate' then 1 end)`,
  })
    .from(citationQuotes)
    .groupBy(citationQuotes.pageId)
    .orderBy(asc(citationQuotes.pageId));

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
});

// ---- GET /accuracy-summary ----

citationsRoute.get("/accuracy-summary", async (c) => {
  const db = getDrizzleDb();

  const rows = await db.select({
    pageId: citationQuotes.pageId,
    checked: sql<number>`count(case when ${citationQuotes.accuracyVerdict} is not null then 1 end)`,
    accurate: sql<number>`count(case when ${citationQuotes.accuracyVerdict} = 'accurate' then 1 end)`,
    inaccurate: sql<number>`count(case when ${citationQuotes.accuracyVerdict} = 'inaccurate' then 1 end)`,
    unsupported: sql<number>`count(case when ${citationQuotes.accuracyVerdict} = 'unsupported' then 1 end)`,
  })
    .from(citationQuotes)
    .groupBy(citationQuotes.pageId)
    .having(sql`count(case when ${citationQuotes.accuracyVerdict} is not null then 1 end) > 0`)
    .orderBy(asc(citationQuotes.pageId));

  return c.json({
    pages: rows.map((r) => ({
      pageId: r.pageId,
      checked: Number(r.checked),
      accurate: Number(r.accurate),
      inaccurate: Number(r.inaccurate),
      unsupported: Number(r.unsupported),
    })),
  });
});

// ---- GET /broken ----

citationsRoute.get("/broken", async (c) => {
  const db = getDrizzleDb();

  const rows = await db
    .select({
      pageId: citationQuotes.pageId,
      footnote: citationQuotes.footnote,
      url: citationQuotes.url,
      claimText: citationQuotes.claimText,
      verificationScore: citationQuotes.verificationScore,
    })
    .from(citationQuotes)
    .where(
      and(
        eq(citationQuotes.quoteVerified, true),
        isNotNull(citationQuotes.verificationScore),
        lt(citationQuotes.verificationScore, BROKEN_SCORE_THRESHOLD)
      )
    )
    .orderBy(
      asc(citationQuotes.verificationScore),
      asc(citationQuotes.pageId),
      asc(citationQuotes.footnote)
    );

  return c.json({ broken: rows });
});

// ---- POST /content/upsert ----

citationsRoute.post("/content/upsert", async (c) => {
  const body = await parseJsonBody(c);
  if (!body) return invalidJsonError(c);

  const parsed = UpsertContentSchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.message);

  const d = parsed.data;
  const db = getDrizzleDb();

  const vals = {
    url: d.url,
    fetchedAt: new Date(d.fetchedAt),
    httpStatus: d.httpStatus ?? null,
    contentType: d.contentType ?? null,
    pageTitle: d.pageTitle ?? null,
    fullTextPreview: d.fullTextPreview ?? null,
    contentLength: d.contentLength ?? null,
    contentHash: d.contentHash ?? null,
  };

  await db
    .insert(citationContent)
    .values(vals)
    .onConflictDoUpdate({
      target: citationContent.url,
      set: { ...vals, updatedAt: sql`now()` },
    });

  return c.json({ url: d.url });
});

// ---- POST /quotes/mark-accuracy-batch ----

citationsRoute.post("/quotes/mark-accuracy-batch", async (c) => {
  const body = await parseJsonBody(c);
  if (!body) return invalidJsonError(c);

  const parsed = MarkAccuracyBatchSchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { items } = parsed.data;
  const db = getDrizzleDb();
  const results: Array<{ pageId: string; footnote: number; verdict: string }> = [];

  await db.transaction(async (tx) => {
    for (const d of items) {
      const rows = await tx
        .update(citationQuotes)
        .set({
          accuracyVerdict: d.verdict,
          accuracyScore: d.score,
          accuracyIssues: d.issues ?? null,
          accuracySupportingQuotes: d.supportingQuotes ?? null,
          verificationDifficulty: d.verificationDifficulty ?? null,
          accuracyCheckedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(citationQuotes.pageId, d.pageId),
            eq(citationQuotes.footnote, d.footnote)
          )
        )
        .returning({
          pageId: citationQuotes.pageId,
          footnote: citationQuotes.footnote,
        });

      if (rows.length > 0) {
        results.push({ pageId: rows[0].pageId, footnote: rows[0].footnote, verdict: d.verdict });
      }
    }
  });

  return c.json({ updated: results.length, results });
});

// ---- POST /accuracy-snapshot ----

citationsRoute.post("/accuracy-snapshot", async (c) => {
  const db = getDrizzleDb();

  // Compute per-page accuracy stats from current citation_quotes data
  const pageStats = await db.select({
    pageId: citationQuotes.pageId,
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
    .groupBy(citationQuotes.pageId)
    .having(sql`count(case when ${citationQuotes.accuracyVerdict} is not null then 1 end) > 0`);

  // Insert snapshots for all pages with accuracy data
  let inserted: Array<{ id: number; pageId: string }> = [];
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
        pageId: citationAccuracySnapshots.pageId,
      });
  }

  return c.json({
    snapshotCount: inserted.length,
    pages: inserted.map((r) => r.pageId),
  }, 201);
});

// ---- GET /accuracy-trends?page_id=X&limit=N ----

citationsRoute.get("/accuracy-trends", async (c) => {
  const pageId = c.req.query("page_id");
  const limitStr = c.req.query("limit");
  const limit = limitStr ? Math.min(Math.max(parseInt(limitStr, 10) || 50, 1), 500) : 50;

  const db = getDrizzleDb();

  if (pageId) {
    // Trends for a specific page
    const rows = await db
      .select()
      .from(citationAccuracySnapshots)
      .where(eq(citationAccuracySnapshots.pageId, pageId))
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
});

// ---- GET /accuracy-dashboard ----

citationsRoute.get("/accuracy-dashboard", async (c) => {
  const db = getDrizzleDb();

  // Get all quotes with accuracy data
  const allQuotes = await db
    .select()
    .from(citationQuotes)
    .orderBy(asc(citationQuotes.pageId), asc(citationQuotes.footnote));

  // Compute summary stats
  let checkedCount = 0;
  let accurateCount = 0;
  let inaccurateCount = 0;
  let unsupportedCount = 0;
  let minorIssueCount = 0;
  let scoreSum = 0;
  let scoreCount = 0;

  const verdictDist: Record<string, number> = {};
  const difficultyDist: Record<string, number> = {};

  // Page aggregation
  const pageMap = new Map<string, {
    total: number; checked: number; accurate: number;
    inaccurate: number; unsupported: number; minorIssues: number;
    scoreSum: number; scoreCount: number;
  }>();

  // Domain aggregation
  const domainMap = new Map<string, {
    total: number; checked: number; accurate: number;
    inaccurate: number; unsupported: number;
  }>();

  // Flagged citations
  const flagged: Array<{
    pageId: string; footnote: number; claimText: string;
    sourceTitle: string | null; url: string | null;
    verdict: string; score: number | null;
    issues: string | null; difficulty: string | null;
    checkedAt: string | null;
  }> = [];

  for (const q of allQuotes) {
    const pageId = q.pageId;
    const verdict = q.accuracyVerdict;
    const score = q.accuracyScore;
    const difficulty = q.verificationDifficulty;
    const url = q.url;

    // Extract domain
    let domain: string | null = null;
    if (url) {
      try { domain = new URL(url).hostname.replace(/^www\./, ''); } catch { /* invalid URL */ }
    }

    // Page aggregation
    if (!pageMap.has(pageId)) {
      pageMap.set(pageId, { total: 0, checked: 0, accurate: 0, inaccurate: 0, unsupported: 0, minorIssues: 0, scoreSum: 0, scoreCount: 0 });
    }
    const page = pageMap.get(pageId)!;
    page.total++;

    // Domain aggregation
    if (domain) {
      if (!domainMap.has(domain)) {
        domainMap.set(domain, { total: 0, checked: 0, accurate: 0, inaccurate: 0, unsupported: 0 });
      }
      const d = domainMap.get(domain)!;
      d.total++;
    }

    if (verdict) {
      checkedCount++;
      page.checked++;
      verdictDist[verdict] = (verdictDist[verdict] || 0) + 1;

      if (domain) domainMap.get(domain)!.checked++;

      if (score !== null) {
        scoreSum += score;
        scoreCount++;
        page.scoreSum += score;
        page.scoreCount++;
      }

      if (difficulty) {
        difficultyDist[difficulty] = (difficultyDist[difficulty] || 0) + 1;
      }

      if (verdict === 'accurate') {
        accurateCount++; page.accurate++;
        if (domain) domainMap.get(domain)!.accurate++;
      } else if (verdict === 'inaccurate') {
        inaccurateCount++; page.inaccurate++;
        if (domain) domainMap.get(domain)!.inaccurate++;
      } else if (verdict === 'unsupported') {
        unsupportedCount++; page.unsupported++;
        if (domain) domainMap.get(domain)!.unsupported++;
      } else if (verdict === 'minor_issues') {
        minorIssueCount++; page.minorIssues++;
      }

      // Flag problematic citations
      if (verdict === 'inaccurate' || verdict === 'unsupported') {
        const claimText = q.claimText.length > 150 ? q.claimText.slice(0, 150) + '...' : q.claimText;
        flagged.push({
          pageId, footnote: q.footnote, claimText,
          sourceTitle: q.sourceTitle, url,
          verdict, score,
          issues: q.accuracyIssues,
          difficulty,
          checkedAt: q.accuracyCheckedAt?.toISOString() ?? null,
        });
      }
    }
  }

  // Build page summaries
  const pages = Array.from(pageMap.entries()).map(([pageId, p]) => ({
    pageId,
    totalCitations: p.total,
    checked: p.checked,
    accurate: p.accurate,
    inaccurate: p.inaccurate,
    unsupported: p.unsupported,
    minorIssues: p.minorIssues,
    accuracyRate: p.checked > 0 ? Math.round(((p.accurate + p.minorIssues) / p.checked) * 100) / 100 : null,
    avgScore: p.scoreCount > 0 ? Math.round((p.scoreSum / p.scoreCount) * 100) / 100 : null,
  }));
  pages.sort((a, b) => {
    const aInacc = a.checked > 0 ? (a.inaccurate + a.unsupported) / a.checked : 0;
    const bInacc = b.checked > 0 ? (b.inaccurate + b.unsupported) / b.checked : 0;
    if (bInacc !== aInacc) return bInacc - aInacc;
    return b.totalCitations - a.totalCitations;
  });

  // Build domain summaries
  const MIN_DOMAIN_CITATIONS = 2;
  const domainAnalysis = Array.from(domainMap.entries())
    .filter(([, d]) => d.total >= MIN_DOMAIN_CITATIONS)
    .map(([domain, d]) => ({
      domain,
      totalCitations: d.total,
      checked: d.checked,
      accurate: d.accurate,
      inaccurate: d.inaccurate,
      unsupported: d.unsupported,
      inaccuracyRate: d.checked > 0 ? Math.round(((d.inaccurate + d.unsupported) / d.checked) * 100) / 100 : null,
    }));
  domainAnalysis.sort((a, b) => {
    const aRate = a.inaccuracyRate ?? 0;
    const bRate = b.inaccuracyRate ?? 0;
    if (bRate !== aRate) return bRate - aRate;
    return b.totalCitations - a.totalCitations;
  });

  // Sort flagged by score (worst first)
  flagged.sort((a, b) => (a.score ?? 0) - (b.score ?? 0));

  return c.json({
    exportedAt: new Date().toISOString(),
    summary: {
      totalCitations: allQuotes.length,
      checkedCitations: checkedCount,
      accurateCitations: accurateCount,
      inaccurateCitations: inaccurateCount,
      unsupportedCitations: unsupportedCount,
      minorIssueCitations: minorIssueCount,
      uncheckedCitations: allQuotes.length - checkedCount,
      averageScore: scoreCount > 0 ? Math.round((scoreSum / scoreCount) * 100) / 100 : null,
    },
    verdictDistribution: verdictDist,
    difficultyDistribution: difficultyDist,
    pages,
    flaggedCitations: flagged,
    domainAnalysis,
  });
});

// ---- GET /content?url=X ----

citationsRoute.get("/content", async (c) => {
  const url = c.req.query("url");
  if (!url) return validationError(c, "url query parameter is required");

  const db = getDrizzleDb();
  const rows = await db
    .select()
    .from(citationContent)
    .where(eq(citationContent.url, url));

  if (rows.length === 0) {
    return notFoundError(c, `No content for url: ${url}`);
  }

  return c.json(rows[0]);
});
