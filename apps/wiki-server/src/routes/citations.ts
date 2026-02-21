import { Hono } from "hono";
import { z } from "zod";
import { eq, and, count, avg, sql, asc, isNotNull, lt } from "drizzle-orm";
import { getDrizzleDb } from "../db.js";
import { citationQuotes, citationContent } from "../schema.js";
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

const MarkAccuracySchema = z.object({
  pageId: z.string().min(1).max(200),
  footnote: z.number().int().min(0),
  verdict: z.enum(["accurate", "inaccurate", "unsupported"]),
  score: z.number().min(0).max(1),
  issues: z.string().max(10000).nullable().optional(),
  supportingQuotes: z.string().max(10000).nullable().optional(),
  verificationDifficulty: z.enum(["easy", "moderate", "hard"]).nullable().optional(),
});

const UpsertContentSchema = z.object({
  url: z.string().min(1).max(2000),
  pageId: z.string().min(1).max(200),
  footnote: z.number().int().min(0),
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
  const results: Array<{ id: number; pageId: string; footnote: number }> = [];

  await db.transaction(async (tx) => {
    for (const d of items) {
      const rows = await upsertQuote(tx, d);
      results.push({ id: rows[0].id, pageId: rows[0].pageId, footnote: rows[0].footnote });
    }
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
    pageId: d.pageId,
    footnote: d.footnote,
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

  return c.json({ url: d.url, pageId: d.pageId, footnote: d.footnote });
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
