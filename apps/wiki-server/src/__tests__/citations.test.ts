import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// ---- In-memory stores simulating Postgres tables ----

let nextQuoteId = 1;
let quotesStore: Map<
  string, // key: `${page_id}:${footnote}`
  Record<string, unknown>
>;
let contentStore: Map<string, Record<string, unknown>>; // key: url

function resetStores() {
  nextQuoteId = 1;
  quotesStore = new Map();
  contentStore = new Map();
}

function quoteKey(pageId: string, footnote: number) {
  return `${pageId}:${footnote}`;
}

/**
 * Mock tagged-template SQL that dispatches based on query text.
 * Handles citation_quotes, citation_content, and entity_ids tables.
 */
function createMockSql() {
  const mockSql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?").trim();

    // --- Schema creation (initDb) ---
    if (
      query.includes("CREATE TABLE") ||
      query.includes("CREATE INDEX") ||
      query.includes("CREATE SEQUENCE") ||
      query.includes("DO $$")
    ) {
      return [];
    }

    // --- citation_quotes: INSERT ... ON CONFLICT ---
    if (query.includes("INSERT INTO citation_quotes")) {
      const [pageId, footnote, url, resourceId, claimText, claimContext,
        sourceQuote, sourceLocation, quoteVerified, verificationMethod,
        verificationScore, sourceTitle, sourceType, extractionModel] = values;

      const key = quoteKey(pageId as string, footnote as number);
      const now = new Date().toISOString();
      const existing = quotesStore.get(key);

      if (existing) {
        // ON CONFLICT DO UPDATE
        const updated = {
          ...existing,
          url, resource_id: resourceId, claim_text: claimText,
          claim_context: claimContext, source_quote: sourceQuote,
          source_location: sourceLocation, quote_verified: quoteVerified ?? false,
          verification_method: verificationMethod, verification_score: verificationScore,
          source_title: sourceTitle, source_type: sourceType,
          extraction_model: extractionModel, updated_at: now,
        };
        quotesStore.set(key, updated);
        return [updated];
      }

      const row: Record<string, unknown> = {
        id: nextQuoteId++,
        page_id: pageId, footnote, url, resource_id: resourceId,
        claim_text: claimText, claim_context: claimContext,
        source_quote: sourceQuote, source_location: sourceLocation,
        quote_verified: quoteVerified ?? false,
        verification_method: verificationMethod, verification_score: verificationScore,
        verified_at: null, source_title: sourceTitle, source_type: sourceType,
        extraction_model: extractionModel,
        accuracy_verdict: null, accuracy_issues: null, accuracy_score: null,
        accuracy_checked_at: null, accuracy_supporting_quotes: null,
        verification_difficulty: null,
        created_at: now, updated_at: now,
      };
      quotesStore.set(key, row);
      return [row];
    }

    // --- citation_quotes: UPDATE ... mark-accuracy ---
    if (query.includes("UPDATE citation_quotes") && query.includes("accuracy_verdict")) {
      const [verdict, score, issues, supportingQuotes, difficulty, pageId, footnote] = values;
      const key = quoteKey(pageId as string, footnote as number);
      const existing = quotesStore.get(key);
      if (!existing) return [];
      existing.accuracy_verdict = verdict;
      existing.accuracy_score = score;
      existing.accuracy_issues = issues;
      existing.accuracy_supporting_quotes = supportingQuotes;
      existing.verification_difficulty = difficulty;
      existing.accuracy_checked_at = new Date().toISOString();
      existing.updated_at = new Date().toISOString();
      return [existing];
    }

    // --- citation_quotes: UPDATE ... mark-verified ---
    if (query.includes("UPDATE citation_quotes") && query.includes("quote_verified")) {
      const [method, score, pageId, footnote] = values;
      const key = quoteKey(pageId as string, footnote as number);
      const existing = quotesStore.get(key);
      if (!existing) return [];
      existing.quote_verified = true;
      existing.verification_method = method;
      existing.verification_score = score;
      existing.verified_at = new Date().toISOString();
      existing.updated_at = new Date().toISOString();
      return [existing];
    }

    // --- citation_quotes: SELECT * WHERE page_id ---
    if (query.includes("FROM citation_quotes") && query.includes("WHERE page_id")) {
      const pageId = values[0] as string;
      return Array.from(quotesStore.values())
        .filter((r) => r.page_id === pageId)
        .sort((a, b) => (a.footnote as number) - (b.footnote as number));
    }

    // --- citation_quotes: SELECT * ORDER BY (all, paginated — has LIMIT) ---
    if (query.includes("FROM citation_quotes") && query.includes("ORDER BY page_id") && query.includes("LIMIT")) {
      const limit = values[0] as number;
      const offset = values[1] as number;
      const all = Array.from(quotesStore.values()).sort((a, b) => {
        const pc = (a.page_id as string).localeCompare(b.page_id as string);
        return pc !== 0 ? pc : (a.footnote as number) - (b.footnote as number);
      });
      return all.slice(offset, offset + limit);
    }

    // --- citation_quotes: SELECT COUNT(*) ---
    if (query.includes("SELECT COUNT(*)") && query.includes("citation_quotes")) {
      return [{ count: quotesStore.size }];
    }

    // --- citation_quotes: Stats aggregation ---
    if (query.includes("FROM citation_quotes") && query.includes("total_quotes")) {
      const all = Array.from(quotesStore.values());
      const withQuotes = all.filter((r) => r.source_quote != null).length;
      const verified = all.filter((r) => r.quote_verified === true).length;
      const scores = all.filter((r) => r.verification_score != null).map((r) => r.verification_score as number);
      const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
      const pages = new Set(all.map((r) => r.page_id));
      return [{
        total_quotes: all.length,
        with_quotes: withQuotes,
        verified,
        unverified: all.length - verified,
        total_pages: pages.size,
        average_score: avgScore,
      }];
    }

    // --- citation_quotes: Accuracy summary (check before page-stats since both have GROUP BY) ---
    if (query.includes("GROUP BY page_id") && query.includes("HAVING")) {
      const byPage = new Map<string, Record<string, unknown>[]>();
      for (const r of quotesStore.values()) {
        if (r.accuracy_verdict != null) {
          const arr = byPage.get(r.page_id as string) || [];
          arr.push(r);
          byPage.set(r.page_id as string, arr);
        }
      }
      return Array.from(byPage.entries())
        .map(([pageId, rows]) => ({
          page_id: pageId,
          checked: rows.length,
          accurate: rows.filter((r) => r.accuracy_verdict === "accurate").length,
          inaccurate: rows.filter((r) => r.accuracy_verdict === "inaccurate").length,
          unsupported: rows.filter((r) => r.accuracy_verdict === "unsupported").length,
        }))
        .sort((a, b) => a.page_id.localeCompare(b.page_id));
    }

    // --- citation_quotes: Page stats aggregation ---
    if (query.includes("GROUP BY page_id") && query.includes("with_quotes")) {
      const byPage = new Map<string, Record<string, unknown>[]>();
      for (const r of quotesStore.values()) {
        const arr = byPage.get(r.page_id as string) || [];
        arr.push(r);
        byPage.set(r.page_id as string, arr);
      }
      return Array.from(byPage.entries())
        .map(([pageId, rows]) => ({
          page_id: pageId,
          total: rows.length,
          with_quotes: rows.filter((r) => r.source_quote != null).length,
          verified: rows.filter((r) => r.quote_verified === true).length,
          avg_score: null,
          accuracy_checked: rows.filter((r) => r.accuracy_verdict != null).length,
          accurate: rows.filter((r) => r.accuracy_verdict === "accurate").length,
          inaccurate: rows.filter((r) => r.accuracy_verdict === "inaccurate").length,
        }))
        .sort((a, b) => a.page_id.localeCompare(b.page_id));
    }

    // --- citation_quotes: Broken quotes (verification_score < threshold) ---
    if (query.includes("verification_score <") && !query.includes("LIMIT")) {
      const threshold = (values[0] as number) ?? 0.5;
      return Array.from(quotesStore.values())
        .filter((r) => r.quote_verified === true && r.verification_score != null && (r.verification_score as number) < threshold)
        .sort((a, b) => (a.verification_score as number) - (b.verification_score as number))
        .map((r) => ({
          page_id: r.page_id, footnote: r.footnote, url: r.url,
          claim_text: r.claim_text, verification_score: r.verification_score,
        }));
    }

    // --- citation_content: INSERT ... ON CONFLICT ---
    if (query.includes("INSERT INTO citation_content")) {
      const [url, pageId, footnote, fetchedAt, httpStatus, contentType,
        pageTitle, fullTextPreview, contentLength, contentHash] = values;
      const now = new Date().toISOString();
      const existing = contentStore.get(url as string);
      const row: Record<string, unknown> = {
        url, page_id: pageId, footnote, fetched_at: fetchedAt,
        http_status: httpStatus, content_type: contentType,
        page_title: pageTitle, full_text_preview: fullTextPreview,
        content_length: contentLength, content_hash: contentHash,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };
      contentStore.set(url as string, row);
      return [row];
    }

    // --- citation_content: SELECT * WHERE url ---
    if (query.includes("FROM citation_content") && query.includes("WHERE url")) {
      const url = values[0] as string;
      const row = contentStore.get(url);
      return row ? [row] : [];
    }

    // --- entity_ids fallbacks (from ids.test patterns) ---
    if (query.includes("SELECT COUNT(*)")) {
      return [{ count: 0 }];
    }

    return [];
  };

  mockSql.begin = async (fn: (tx: typeof mockSql) => Promise<void>) => {
    await fn(mockSql);
  };

  return mockSql;
}

// Mock the db module
vi.mock("../db.js", () => {
  const mockSql = createMockSql();
  return {
    getDb: () => mockSql,
    initDb: vi.fn(),
    closeDb: vi.fn(),
  };
});

const { createApp } = await import("../app.js");

// ---- Helpers ----

function postJson(app: Hono, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function upsertQuote(app: Hono, pageId: string, footnote: number, claimText = "Test claim") {
  return postJson(app, "/api/citations/quotes/upsert", {
    pageId,
    footnote,
    claimText,
    url: `https://example.com/${pageId}/${footnote}`,
  });
}

// ---- Tests ----

describe("Citation Server API", () => {
  let app: Hono;

  beforeEach(() => {
    resetStores();
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    app = createApp();
  });

  // ---- Quote Upsert ----

  describe("POST /api/citations/quotes/upsert", () => {
    it("creates a new quote and returns 200", async () => {
      const res = await upsertQuote(app, "test-page", 1);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pageId).toBe("test-page");
      expect(body.footnote).toBe(1);
      expect(body.id).toBe(1);
    });

    it("updates existing quote on conflict", async () => {
      await upsertQuote(app, "test-page", 1, "Original claim");
      const res = await postJson(app, "/api/citations/quotes/upsert", {
        pageId: "test-page",
        footnote: 1,
        claimText: "Updated claim",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pageId).toBe("test-page");
    });

    it("rejects missing claimText", async () => {
      const res = await postJson(app, "/api/citations/quotes/upsert", {
        pageId: "test-page",
        footnote: 1,
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("validation_error");
    });

    it("rejects invalid JSON", async () => {
      const res = await app.request("/api/citations/quotes/upsert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("invalid_json");
    });
  });

  // ---- Batch Upsert ----

  describe("POST /api/citations/quotes/upsert-batch", () => {
    it("creates multiple quotes in a batch", async () => {
      const res = await postJson(app, "/api/citations/quotes/upsert-batch", {
        items: [
          { pageId: "page-a", footnote: 1, claimText: "Claim 1" },
          { pageId: "page-a", footnote: 2, claimText: "Claim 2" },
          { pageId: "page-b", footnote: 1, claimText: "Claim 3" },
        ],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results).toHaveLength(3);
      expect(body.results[0].pageId).toBe("page-a");
      expect(body.results[2].pageId).toBe("page-b");
    });

    it("rejects empty batch", async () => {
      const res = await postJson(app, "/api/citations/quotes/upsert-batch", {
        items: [],
      });
      expect(res.status).toBe(400);
    });
  });

  // ---- Get Quotes ----

  describe("GET /api/citations/quotes", () => {
    it("returns quotes for a page", async () => {
      await upsertQuote(app, "my-page", 1, "Claim one");
      await upsertQuote(app, "my-page", 2, "Claim two");
      await upsertQuote(app, "other-page", 1, "Other claim");

      const res = await app.request("/api/citations/quotes?page_id=my-page");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.quotes).toHaveLength(2);
      expect(body.quotes[0].footnote).toBe(1);
      expect(body.quotes[1].footnote).toBe(2);
    });

    it("returns empty array for unknown page", async () => {
      const res = await app.request("/api/citations/quotes?page_id=nonexistent");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.quotes).toHaveLength(0);
    });

    it("requires page_id parameter", async () => {
      const res = await app.request("/api/citations/quotes");
      expect(res.status).toBe(400);
    });
  });

  // ---- Get All Quotes (paginated) ----

  describe("GET /api/citations/quotes/all", () => {
    it("returns paginated quotes", async () => {
      for (let i = 1; i <= 5; i++) {
        await upsertQuote(app, "page-x", i);
      }

      const res = await app.request("/api/citations/quotes/all?limit=3&offset=0");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.quotes).toHaveLength(3);
      expect(body.total).toBe(5);
      expect(body.limit).toBe(3);
      expect(body.offset).toBe(0);
    });
  });

  // ---- Mark Verified ----

  describe("POST /api/citations/quotes/mark-verified", () => {
    it("marks a quote as verified", async () => {
      await upsertQuote(app, "verify-page", 1);

      const res = await postJson(app, "/api/citations/quotes/mark-verified", {
        pageId: "verify-page",
        footnote: 1,
        method: "text-match",
        score: 0.95,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.updated).toBe(true);
    });

    it("returns 404 for nonexistent quote", async () => {
      const res = await postJson(app, "/api/citations/quotes/mark-verified", {
        pageId: "nonexistent",
        footnote: 99,
        method: "text-match",
        score: 0.5,
      });
      expect(res.status).toBe(404);
    });
  });

  // ---- Mark Accuracy ----

  describe("POST /api/citations/quotes/mark-accuracy", () => {
    it("marks accuracy verdict", async () => {
      await upsertQuote(app, "acc-page", 1);

      const res = await postJson(app, "/api/citations/quotes/mark-accuracy", {
        pageId: "acc-page",
        footnote: 1,
        verdict: "accurate",
        score: 0.9,
        issues: null,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.updated).toBe(true);
      expect(body.verdict).toBe("accurate");
    });

    it("rejects invalid verdict", async () => {
      const res = await postJson(app, "/api/citations/quotes/mark-accuracy", {
        pageId: "acc-page",
        footnote: 1,
        verdict: "maybe",
        score: 0.5,
      });
      expect(res.status).toBe(400);
    });
  });

  // ---- Stats ----

  describe("GET /api/citations/stats", () => {
    it("returns aggregate statistics", async () => {
      await upsertQuote(app, "stats-page", 1);
      await upsertQuote(app, "stats-page", 2);

      const res = await app.request("/api/citations/stats");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.totalQuotes).toBe(2);
      expect(body.totalPages).toBe(1);
      expect(body.verified).toBe(0);
      expect(body.unverified).toBe(2);
    });
  });

  // ---- Page Stats ----

  describe("GET /api/citations/page-stats", () => {
    it("returns per-page statistics", async () => {
      await upsertQuote(app, "page-a", 1);
      await upsertQuote(app, "page-a", 2);
      await upsertQuote(app, "page-b", 1);

      const res = await app.request("/api/citations/page-stats");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pages).toHaveLength(2);
      expect(body.pages[0].pageId).toBe("page-a");
      expect(body.pages[0].total).toBe(2);
      expect(body.pages[1].pageId).toBe("page-b");
      expect(body.pages[1].total).toBe(1);
    });
  });

  // ---- Accuracy Summary ----

  describe("GET /api/citations/accuracy-summary", () => {
    it("returns pages with accuracy data", async () => {
      await upsertQuote(app, "acc-page", 1);
      await upsertQuote(app, "acc-page", 2);
      await upsertQuote(app, "no-acc-page", 1);

      // Mark accuracy on one page
      await postJson(app, "/api/citations/quotes/mark-accuracy", {
        pageId: "acc-page", footnote: 1, verdict: "accurate", score: 0.9,
      });
      await postJson(app, "/api/citations/quotes/mark-accuracy", {
        pageId: "acc-page", footnote: 2, verdict: "inaccurate", score: 0.3,
      });

      const res = await app.request("/api/citations/accuracy-summary");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pages).toHaveLength(1);
      expect(body.pages[0].pageId).toBe("acc-page");
      expect(body.pages[0].accurate).toBe(1);
      expect(body.pages[0].inaccurate).toBe(1);
    });
  });

  // ---- Broken Quotes ----

  describe("GET /api/citations/broken", () => {
    it("returns verified quotes with low scores", async () => {
      await upsertQuote(app, "broken-page", 1);
      await upsertQuote(app, "broken-page", 2);

      // Mark one as verified with low score
      await postJson(app, "/api/citations/quotes/mark-verified", {
        pageId: "broken-page", footnote: 1, method: "text-match", score: 0.2,
      });
      // Mark one as verified with high score
      await postJson(app, "/api/citations/quotes/mark-verified", {
        pageId: "broken-page", footnote: 2, method: "text-match", score: 0.9,
      });

      const res = await app.request("/api/citations/broken");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.broken).toHaveLength(1);
      expect(body.broken[0].footnote).toBe(1);
      expect(body.broken[0].verificationScore).toBe(0.2);
    });
  });

  // ---- Content Upsert ----

  describe("POST /api/citations/content/upsert", () => {
    it("creates content entry", async () => {
      const res = await postJson(app, "/api/citations/content/upsert", {
        url: "https://example.com/article",
        pageId: "test-page",
        footnote: 1,
        fetchedAt: "2025-01-01T00:00:00Z",
        httpStatus: 200,
        contentType: "text/html",
        pageTitle: "Test Article",
        fullTextPreview: "Some content...",
        contentLength: 1234,
        contentHash: "abc123",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.url).toBe("https://example.com/article");
      expect(body.pageId).toBe("test-page");
    });

    it("rejects missing url", async () => {
      const res = await postJson(app, "/api/citations/content/upsert", {
        pageId: "test-page",
        footnote: 1,
        fetchedAt: "2025-01-01T00:00:00Z",
      });
      expect(res.status).toBe(400);
    });
  });

  // ---- Content Get ----

  describe("GET /api/citations/content", () => {
    it("returns content for a URL", async () => {
      await postJson(app, "/api/citations/content/upsert", {
        url: "https://example.com/article",
        pageId: "test-page",
        footnote: 1,
        fetchedAt: "2025-01-01T00:00:00Z",
        httpStatus: 200,
        pageTitle: "Test Article",
      });

      const res = await app.request(
        "/api/citations/content?url=https://example.com/article"
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.url).toBe("https://example.com/article");
      expect(body.pageTitle).toBe("Test Article");
      expect(body.httpStatus).toBe(200);
    });

    it("returns 404 for unknown URL", async () => {
      const res = await app.request(
        "/api/citations/content?url=https://example.com/unknown"
      );
      expect(res.status).toBe(404);
    });

    it("requires url parameter", async () => {
      const res = await app.request("/api/citations/content");
      expect(res.status).toBe(400);
    });
  });

  // ---- Bearer auth ----

  describe("Bearer auth for citation routes", () => {
    it("rejects unauthenticated requests when API key is set", async () => {
      process.env.LONGTERMWIKI_SERVER_API_KEY = "test-key";
      const authedApp = createApp();

      const res = await authedApp.request("/api/citations/stats");
      expect(res.status).toBe(401);

      delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    });

    it("accepts requests with correct token", async () => {
      process.env.LONGTERMWIKI_SERVER_API_KEY = "test-key";
      const authedApp = createApp();

      const res = await authedApp.request("/api/citations/stats", {
        headers: { Authorization: "Bearer test-key" },
      });
      expect(res.status).toBe(200);

      delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    });
  });
});
