import { Hono, type Context } from "hono";
import { z } from "zod";
import { getDb, type SqlQuery } from "../db.js";

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

function parseJsonBody(c: Context) {
  return c.req.json().catch(() => null);
}

function validationError(c: Context, message: string) {
  return c.json({ error: "validation_error", message }, 400);
}

/** Shared upsert SQL for single and batch quote operations. */
function upsertQuoteSql(db: { (s: TemplateStringsArray, ...v: unknown[]): unknown }, d: UpsertQuoteData) {
  return db`
    INSERT INTO citation_quotes (
      page_id, footnote, url, resource_id, claim_text, claim_context,
      source_quote, source_location, quote_verified, verification_method,
      verification_score, source_title, source_type, extraction_model
    ) VALUES (
      ${d.pageId}, ${d.footnote}, ${d.url ?? null}, ${d.resourceId ?? null},
      ${d.claimText}, ${d.claimContext ?? null}, ${d.sourceQuote ?? null},
      ${d.sourceLocation ?? null}, ${d.quoteVerified ?? false},
      ${d.verificationMethod ?? null}, ${d.verificationScore ?? null},
      ${d.sourceTitle ?? null}, ${d.sourceType ?? null}, ${d.extractionModel ?? null}
    )
    ON CONFLICT (page_id, footnote) DO UPDATE SET
      url = EXCLUDED.url,
      resource_id = EXCLUDED.resource_id,
      claim_text = EXCLUDED.claim_text,
      claim_context = EXCLUDED.claim_context,
      source_quote = EXCLUDED.source_quote,
      source_location = EXCLUDED.source_location,
      quote_verified = EXCLUDED.quote_verified,
      verification_method = EXCLUDED.verification_method,
      verification_score = EXCLUDED.verification_score,
      source_title = EXCLUDED.source_title,
      source_type = EXCLUDED.source_type,
      extraction_model = EXCLUDED.extraction_model,
      updated_at = NOW()
    RETURNING id, page_id, footnote, created_at, updated_at
  `;
}

// ---- POST /quotes/upsert ----

citationsRoute.post("/quotes/upsert", async (c) => {
  const body = await parseJsonBody(c);
  if (!body) return c.json({ error: "invalid_json", message: "Request body must be valid JSON" }, 400);

  const parsed = UpsertQuoteSchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.message);

  const db = getDb();
  const rows = await upsertQuoteSql(db, parsed.data) as any[];

  const row = rows[0];
  return c.json({
    id: row.id,
    pageId: row.page_id,
    footnote: row.footnote,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }, 200);
});

// ---- POST /quotes/upsert-batch ----

citationsRoute.post("/quotes/upsert-batch", async (c) => {
  const body = await parseJsonBody(c);
  if (!body) return c.json({ error: "invalid_json", message: "Request body must be valid JSON" }, 400);

  const parsed = UpsertBatchSchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { items } = parsed.data;
  const db = getDb();
  const results: Array<{ id: number; pageId: string; footnote: number }> = [];

  await db.begin(async (tx) => {
    const q = tx as unknown as SqlQuery;
    for (const d of items) {
      const rows = await upsertQuoteSql(q as any, d) as any[];
      results.push({ id: rows[0].id, pageId: rows[0].page_id, footnote: rows[0].footnote });
    }
  });

  return c.json({ results });
});

// ---- GET /quotes?page_id=X ----

citationsRoute.get("/quotes", async (c) => {
  const pageId = c.req.query("page_id");
  if (!pageId) return validationError(c, "page_id query parameter is required");

  const db = getDb();
  const rows = await db`
    SELECT * FROM citation_quotes
    WHERE page_id = ${pageId}
    ORDER BY footnote
  `;

  return c.json({ quotes: rows.map(formatQuoteRow) });
});

// ---- GET /quotes/all (paginated) ----

citationsRoute.get("/quotes/all", async (c) => {
  const parsed = PaginationQuery.safeParse(c.req.query());
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { limit, offset } = parsed.data;
  const db = getDb();

  const rows = await db`
    SELECT * FROM citation_quotes
    ORDER BY page_id, footnote
    LIMIT ${limit} OFFSET ${offset}
  `;

  const countResult = await db`SELECT COUNT(*) AS count FROM citation_quotes`;
  const total = Number(countResult[0].count);

  return c.json({
    quotes: rows.map(formatQuoteRow),
    total,
    limit,
    offset,
  });
});

// ---- POST /quotes/mark-verified ----

citationsRoute.post("/quotes/mark-verified", async (c) => {
  const body = await parseJsonBody(c);
  if (!body) return c.json({ error: "invalid_json", message: "Request body must be valid JSON" }, 400);

  const parsed = MarkVerifiedSchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { pageId, footnote, method, score } = parsed.data;
  const db = getDb();

  const rows = await db`
    UPDATE citation_quotes
    SET quote_verified = true,
        verification_method = ${method},
        verification_score = ${score},
        verified_at = NOW(),
        updated_at = NOW()
    WHERE page_id = ${pageId} AND footnote = ${footnote}
    RETURNING id, page_id, footnote
  `;

  if (rows.length === 0) {
    return c.json({ error: "not_found", message: `No quote for page=${pageId} footnote=${footnote}` }, 404);
  }

  return c.json({ updated: true, pageId, footnote });
});

// ---- POST /quotes/mark-accuracy ----

citationsRoute.post("/quotes/mark-accuracy", async (c) => {
  const body = await parseJsonBody(c);
  if (!body) return c.json({ error: "invalid_json", message: "Request body must be valid JSON" }, 400);

  const parsed = MarkAccuracySchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.message);

  const { pageId, footnote, verdict, score, issues, supportingQuotes, verificationDifficulty } = parsed.data;
  const db = getDb();

  const rows = await db`
    UPDATE citation_quotes
    SET accuracy_verdict = ${verdict},
        accuracy_score = ${score},
        accuracy_issues = ${issues ?? null},
        accuracy_supporting_quotes = ${supportingQuotes ?? null},
        verification_difficulty = ${verificationDifficulty ?? null},
        accuracy_checked_at = NOW(),
        updated_at = NOW()
    WHERE page_id = ${pageId} AND footnote = ${footnote}
    RETURNING id, page_id, footnote
  `;

  if (rows.length === 0) {
    return c.json({ error: "not_found", message: `No quote for page=${pageId} footnote=${footnote}` }, 404);
  }

  return c.json({ updated: true, pageId, footnote, verdict });
});

// ---- GET /stats ----

citationsRoute.get("/stats", async (c) => {
  const db = getDb();

  const rows = await db`
    SELECT
      COUNT(*) AS total_quotes,
      COUNT(CASE WHEN source_quote IS NOT NULL THEN 1 END) AS with_quotes,
      COUNT(CASE WHEN quote_verified = true THEN 1 END) AS verified,
      COUNT(CASE WHEN quote_verified = false OR quote_verified IS NULL THEN 1 END) AS unverified,
      COUNT(DISTINCT page_id) AS total_pages,
      AVG(CASE WHEN verification_score IS NOT NULL THEN verification_score END) AS average_score
    FROM citation_quotes
  `;

  const r = rows[0];
  return c.json({
    totalQuotes: Number(r.total_quotes),
    withQuotes: Number(r.with_quotes),
    verified: Number(r.verified),
    unverified: Number(r.unverified),
    totalPages: Number(r.total_pages),
    averageScore: r.average_score != null ? Number(r.average_score) : null,
  });
});

// ---- GET /page-stats ----

citationsRoute.get("/page-stats", async (c) => {
  const db = getDb();

  const rows = await db`
    SELECT
      page_id,
      COUNT(*) AS total,
      COUNT(CASE WHEN source_quote IS NOT NULL THEN 1 END) AS with_quotes,
      COUNT(CASE WHEN quote_verified = true THEN 1 END) AS verified,
      AVG(CASE WHEN verification_score IS NOT NULL THEN verification_score END) AS avg_score,
      COUNT(CASE WHEN accuracy_verdict IS NOT NULL THEN 1 END) AS accuracy_checked,
      COUNT(CASE WHEN accuracy_verdict = 'accurate' THEN 1 END) AS accurate,
      COUNT(CASE WHEN accuracy_verdict = 'inaccurate' THEN 1 END) AS inaccurate
    FROM citation_quotes
    GROUP BY page_id
    ORDER BY page_id
  `;

  return c.json({
    pages: rows.map((r) => ({
      pageId: r.page_id,
      total: Number(r.total),
      withQuotes: Number(r.with_quotes),
      verified: Number(r.verified),
      avgScore: r.avg_score != null ? Number(r.avg_score) : null,
      accuracyChecked: Number(r.accuracy_checked),
      accurate: Number(r.accurate),
      inaccurate: Number(r.inaccurate),
    })),
  });
});

// ---- GET /accuracy-summary ----

citationsRoute.get("/accuracy-summary", async (c) => {
  const db = getDb();

  const rows = await db`
    SELECT
      page_id,
      COUNT(CASE WHEN accuracy_verdict IS NOT NULL THEN 1 END) AS checked,
      COUNT(CASE WHEN accuracy_verdict = 'accurate' THEN 1 END) AS accurate,
      COUNT(CASE WHEN accuracy_verdict = 'inaccurate' THEN 1 END) AS inaccurate,
      COUNT(CASE WHEN accuracy_verdict = 'unsupported' THEN 1 END) AS unsupported
    FROM citation_quotes
    GROUP BY page_id
    HAVING COUNT(CASE WHEN accuracy_verdict IS NOT NULL THEN 1 END) > 0
    ORDER BY page_id
  `;

  return c.json({
    pages: rows.map((r) => ({
      pageId: r.page_id,
      checked: Number(r.checked),
      accurate: Number(r.accurate),
      inaccurate: Number(r.inaccurate),
      unsupported: Number(r.unsupported),
    })),
  });
});

// ---- GET /broken ----

citationsRoute.get("/broken", async (c) => {
  const db = getDb();

  const rows = await db`
    SELECT page_id, footnote, url, claim_text, verification_score
    FROM citation_quotes
    WHERE quote_verified = true AND verification_score IS NOT NULL AND verification_score < ${BROKEN_SCORE_THRESHOLD}
    ORDER BY verification_score ASC, page_id, footnote
  `;

  return c.json({
    broken: rows.map((r) => ({
      pageId: r.page_id,
      footnote: r.footnote,
      url: r.url,
      claimText: r.claim_text,
      verificationScore: r.verification_score,
    })),
  });
});

// ---- POST /content/upsert ----

citationsRoute.post("/content/upsert", async (c) => {
  const body = await parseJsonBody(c);
  if (!body) return c.json({ error: "invalid_json", message: "Request body must be valid JSON" }, 400);

  const parsed = UpsertContentSchema.safeParse(body);
  if (!parsed.success) return validationError(c, parsed.error.message);

  const d = parsed.data;
  const db = getDb();

  await db`
    INSERT INTO citation_content (
      url, page_id, footnote, fetched_at, http_status, content_type,
      page_title, full_text_preview, content_length, content_hash
    ) VALUES (
      ${d.url}, ${d.pageId}, ${d.footnote}, ${d.fetchedAt},
      ${d.httpStatus ?? null}, ${d.contentType ?? null}, ${d.pageTitle ?? null},
      ${d.fullTextPreview ?? null}, ${d.contentLength ?? null}, ${d.contentHash ?? null}
    )
    ON CONFLICT (url) DO UPDATE SET
      page_id = EXCLUDED.page_id,
      footnote = EXCLUDED.footnote,
      fetched_at = EXCLUDED.fetched_at,
      http_status = EXCLUDED.http_status,
      content_type = EXCLUDED.content_type,
      page_title = EXCLUDED.page_title,
      full_text_preview = EXCLUDED.full_text_preview,
      content_length = EXCLUDED.content_length,
      content_hash = EXCLUDED.content_hash,
      updated_at = NOW()
    RETURNING url, page_id, footnote
  `;

  return c.json({ url: d.url, pageId: d.pageId, footnote: d.footnote });
});

// ---- GET /content?url=X ----

citationsRoute.get("/content", async (c) => {
  const url = c.req.query("url");
  if (!url) return validationError(c, "url query parameter is required");

  const db = getDb();
  const rows = await db`
    SELECT * FROM citation_content WHERE url = ${url}
  `;

  if (rows.length === 0) {
    return c.json({ error: "not_found", message: `No content for url: ${url}` }, 404);
  }

  const r = rows[0];
  return c.json({
    url: r.url,
    pageId: r.page_id,
    footnote: r.footnote,
    fetchedAt: r.fetched_at,
    httpStatus: r.http_status,
    contentType: r.content_type,
    pageTitle: r.page_title,
    fullTextPreview: r.full_text_preview,
    contentLength: r.content_length,
    contentHash: r.content_hash,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
});

// ---- Row formatter ----

function formatQuoteRow(r: Record<string, unknown>) {
  return {
    id: r.id,
    pageId: r.page_id,
    footnote: r.footnote,
    url: r.url,
    resourceId: r.resource_id,
    claimText: r.claim_text,
    claimContext: r.claim_context,
    sourceQuote: r.source_quote,
    sourceLocation: r.source_location,
    quoteVerified: r.quote_verified,
    verificationMethod: r.verification_method,
    verificationScore: r.verification_score,
    verifiedAt: r.verified_at,
    sourceTitle: r.source_title,
    sourceType: r.source_type,
    extractionModel: r.extraction_model,
    accuracyVerdict: r.accuracy_verdict,
    accuracyIssues: r.accuracy_issues,
    accuracyScore: r.accuracy_score,
    accuracyCheckedAt: r.accuracy_checked_at,
    accuracySupportingQuotes: r.accuracy_supporting_quotes,
    verificationDifficulty: r.verification_difficulty,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
