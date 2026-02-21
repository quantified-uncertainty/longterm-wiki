import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { mockDbModule, postJson } from "./test-utils.js";

// ---- In-memory stores simulating Postgres tables ----

let nextQuoteId = 1;
let nextSnapshotId = 1;
let quotesStore: Map<string, Record<string, unknown>>; // key: `${page_id}:${footnote}`
let contentStore: Map<string, Record<string, unknown>>; // key: url
let snapshotStore: Array<Record<string, unknown>>;

function resetStores() {
  nextQuoteId = 1;
  nextSnapshotId = 1;
  quotesStore = new Map();
  contentStore = new Map();
  snapshotStore = [];
}

function quoteKey(pageId: string, footnote: number) {
  return `${pageId}:${footnote}`;
}

function dispatch(query: string, params: unknown[]): unknown[] {
  const q = query.toLowerCase();

  // --- citation_quotes: INSERT ... ON CONFLICT DO UPDATE (supports multi-row) ---
  if (q.includes("insert into") && q.includes("citation_quotes") && q.includes("do update")) {
    const COLS = 14;
    const numRows = params.length / COLS;
    const rows: Record<string, unknown>[] = [];
    const now = new Date();
    for (let i = 0; i < numRows; i++) {
      const o = i * COLS;
      const pageId = params[o] as string;
      const footnote = params[o + 1] as number;
      const url = params[o + 2];
      const resourceId = params[o + 3];
      const claimText = params[o + 4] as string;
      const claimContext = params[o + 5];
      const sourceQuote = params[o + 6];
      const sourceLocation = params[o + 7];
      const quoteVerified = params[o + 8] ?? false;
      const verificationMethod = params[o + 9];
      const verificationScore = params[o + 10];
      const sourceTitle = params[o + 11];
      const sourceType = params[o + 12];
      const extractionModel = params[o + 13];

      const key = quoteKey(pageId, footnote);
      const existing = quotesStore.get(key);

      if (existing) {
        const updated = {
          ...existing,
          page_id: pageId, footnote, url, resource_id: resourceId,
          claim_text: claimText, claim_context: claimContext,
          source_quote: sourceQuote, source_location: sourceLocation,
          quote_verified: quoteVerified, verification_method: verificationMethod,
          verification_score: verificationScore, source_title: sourceTitle,
          source_type: sourceType, extraction_model: extractionModel,
          updated_at: now,
        };
        quotesStore.set(key, updated);
        rows.push(updated);
      } else {
        const row: Record<string, unknown> = {
          id: nextQuoteId++,
          page_id: pageId, footnote, url, resource_id: resourceId,
          claim_text: claimText, claim_context: claimContext,
          source_quote: sourceQuote, source_location: sourceLocation,
          quote_verified: quoteVerified, verification_method: verificationMethod,
          verification_score: verificationScore,
          verified_at: null, source_title: sourceTitle, source_type: sourceType,
          extraction_model: extractionModel,
          accuracy_verdict: null, accuracy_issues: null, accuracy_score: null,
          accuracy_checked_at: null, accuracy_supporting_quotes: null,
          verification_difficulty: null,
          created_at: now, updated_at: now,
        };
        quotesStore.set(key, row);
        rows.push(row);
      }
    }
    return rows;
  }

  // --- citation_quotes: UPDATE ... accuracy_verdict ---
  if (q.startsWith("update") && q.includes("citation_quotes") && q.includes("accuracy_verdict")) {
    const verdict = params[0];
    const score = params[1];
    const issues = params[2];
    const supportingQuotes = params[3];
    const difficulty = params[4];
    const pageId = params[5] as string;
    const footnote = params[6] as number;
    const key = quoteKey(pageId, footnote);
    const existing = quotesStore.get(key);
    if (!existing) return [];
    existing.accuracy_verdict = verdict;
    existing.accuracy_score = score;
    existing.accuracy_issues = issues;
    existing.accuracy_supporting_quotes = supportingQuotes;
    existing.verification_difficulty = difficulty;
    existing.accuracy_checked_at = new Date();
    existing.updated_at = new Date();
    return [existing];
  }

  // --- citation_quotes: UPDATE ... quote_verified ---
  if (q.startsWith("update") && q.includes("citation_quotes") && q.includes("quote_verified")) {
    const method = params[1];
    const score = params[2];
    const pageId = params[3] as string;
    const footnote = params[4] as number;
    const key = quoteKey(pageId, footnote);
    const existing = quotesStore.get(key);
    if (!existing) return [];
    existing.quote_verified = true;
    existing.verification_method = method;
    existing.verification_score = score;
    existing.verified_at = new Date();
    existing.updated_at = new Date();
    return [existing];
  }

  // --- citation_quotes: Broken quotes (WHERE quote_verified AND verification_score IS NOT NULL AND < threshold) ---
  if (q.includes("citation_quotes") && q.includes("is not null") && q.includes("where") && !q.includes("update") && !q.includes("insert")) {
    const threshold = (params[1] as number) ?? 0.5;
    return Array.from(quotesStore.values())
      .filter((r) => r.quote_verified === true && r.verification_score != null && (r.verification_score as number) < threshold)
      .sort((a, b) => (a.verification_score as number) - (b.verification_score as number))
      .map((r) => ({
        page_id: r.page_id, footnote: r.footnote, url: r.url,
        claim_text: r.claim_text, verification_score: r.verification_score,
      }));
  }

  // --- citation_quotes: SELECT * ... WHERE ... ORDER BY footnote ---
  if (q.includes("citation_quotes") && q.includes("where") && q.includes("order by") && !q.includes("group by")) {
    const pageId = params[0] as string;
    return Array.from(quotesStore.values())
      .filter((r) => r.page_id === pageId)
      .sort((a, b) => (a.footnote as number) - (b.footnote as number));
  }

  // --- citation_quotes: SELECT WHERE (no ORDER BY, no COUNT, no GROUP BY) ---
  if (q.includes("citation_quotes") && q.includes("where") && !q.includes("count(*)") && !q.includes("group by") && !q.includes("order by") && !q.includes("limit")) {
    if (params.length === 1) {
      const pageId = params[0] as string;
      return Array.from(quotesStore.values())
        .filter((r) => r.page_id === pageId)
        .sort((a, b) => (a.footnote as number) - (b.footnote as number));
    }
    return [];
  }

  // --- citation_quotes: SELECT * ORDER BY ... LIMIT (paginated all) ---
  if (q.includes("citation_quotes") && q.includes("order by") && q.includes("limit") && !q.includes("where") && !q.includes("count(*)") && !q.includes("group by")) {
    const limit = (params[0] as number) || 100;
    const offset = (params[1] as number) || 0;
    const all = Array.from(quotesStore.values()).sort((a, b) => {
      const pc = (a.page_id as string).localeCompare(b.page_id as string);
      return pc !== 0 ? pc : (a.footnote as number) - (b.footnote as number);
    });
    return all.slice(offset, offset + limit);
  }

  // --- citation_quotes: Stats aggregation (count + count(case) without group by) ---
  if (q.includes("citation_quotes") && q.includes("count") && q.includes("case") && !q.includes("group by")) {
    const all = Array.from(quotesStore.values());
    const withQuotes = all.filter((r) => r.source_quote != null).length;
    const verified = all.filter((r) => r.quote_verified === true).length;
    const scores = all.filter((r) => r.verification_score != null).map((r) => r.verification_score as number);
    const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
    const pages = new Set(all.map((r) => r.page_id));
    return [{
      count: all.length,
      with_quotes: withQuotes,
      verified,
      unverified: all.length - verified,
      total_pages: pages.size,
      avg: avgScore,
    }];
  }

  // --- citation_quotes: COUNT(*) (simple count, no group by) ---
  if (q.includes("count(*)") && q.includes("citation_quotes") && !q.includes("group by")) {
    return [{ count: quotesStore.size }];
  }

  // --- citation_quotes: Accuracy summary (GROUP BY + HAVING) ---
  if (q.includes("citation_quotes") && q.includes("group by") && q.includes("having")) {
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

  // --- citation_quotes: Page stats (GROUP BY without HAVING) ---
  if (q.includes("citation_quotes") && q.includes("group by") && !q.includes("having")) {
    const byPage = new Map<string, Record<string, unknown>[]>();
    for (const r of quotesStore.values()) {
      const arr = byPage.get(r.page_id as string) || [];
      arr.push(r);
      byPage.set(r.page_id as string, arr);
    }
    return Array.from(byPage.entries())
      .map(([pageId, rows]) => ({
        page_id: pageId,
        count: rows.length,
        with_quotes: rows.filter((r) => r.source_quote != null).length,
        verified: rows.filter((r) => r.quote_verified === true).length,
        avg: null,
        accuracy_checked: rows.filter((r) => r.accuracy_verdict != null).length,
        accurate: rows.filter((r) => r.accuracy_verdict === "accurate").length,
        inaccurate: rows.filter((r) => r.accuracy_verdict === "inaccurate").length,
      }))
      .sort((a, b) => a.page_id.localeCompare(b.page_id));
  }

  // --- citation_accuracy_snapshots: INSERT (supports multi-row) ---
  if (q.includes("insert into") && q.includes("citation_accuracy_snapshots")) {
    const COLS = 9;
    const numRows = params.length / COLS;
    const rows: Record<string, unknown>[] = [];
    const now = new Date();
    for (let i = 0; i < numRows; i++) {
      const o = i * COLS;
      const row = {
        id: nextSnapshotId++,
        page_id: params[o] as string,
        total_citations: params[o + 1] as number,
        checked_citations: params[o + 2] as number,
        accurate_count: params[o + 3] as number,
        minor_issues_count: params[o + 4] as number,
        inaccurate_count: params[o + 5] as number,
        unsupported_count: params[o + 6] as number,
        not_verifiable_count: params[o + 7] as number,
        average_score: params[o + 8],
        snapshot_at: now,
      };
      snapshotStore.push(row);
      rows.push(row);
    }
    return rows;
  }

  // --- citation_accuracy_snapshots: SELECT with WHERE ---
  if (q.includes("citation_accuracy_snapshots") && q.includes("where") && !q.includes("group by")) {
    const pageId = params[0] as string;
    return snapshotStore
      .filter((r) => r.page_id === pageId)
      .sort((a, b) => new Date(b.snapshot_at as string).getTime() - new Date(a.snapshot_at as string).getTime());
  }

  // --- citation_accuracy_snapshots: SELECT with GROUP BY (global trends) ---
  if (q.includes("citation_accuracy_snapshots") && q.includes("group by")) {
    // Group by snapshot_at
    const byTime = new Map<string, Record<string, unknown>[]>();
    for (const r of snapshotStore) {
      const key = String(r.snapshot_at);
      const arr = byTime.get(key) || [];
      arr.push(r);
      byTime.set(key, arr);
    }
    return Array.from(byTime.entries()).map(([key, rows]) => ({
      snapshot_at: rows[0].snapshot_at,
      count: rows.length,
      total_citations: rows.reduce((s, r) => s + (r.total_citations as number), 0),
      checked_citations: rows.reduce((s, r) => s + (r.checked_citations as number), 0),
      accurate_count: rows.reduce((s, r) => s + (r.accurate_count as number), 0),
      minor_issues_count: rows.reduce((s, r) => s + (r.minor_issues_count as number), 0),
      inaccurate_count: rows.reduce((s, r) => s + (r.inaccurate_count as number), 0),
      unsupported_count: rows.reduce((s, r) => s + (r.unsupported_count as number), 0),
      not_verifiable_count: rows.reduce((s, r) => s + (r.not_verifiable_count as number), 0),
      average_score: null,
    }));
  }

  // --- citation_quotes: SELECT * ORDER BY ... (no LIMIT, no WHERE — for accuracy-dashboard) ---
  if (q.includes("citation_quotes") && q.includes("order by") && !q.includes("where") && !q.includes("count(*)") && !q.includes("group by") && !q.includes("limit")) {
    return Array.from(quotesStore.values()).sort((a, b) => {
      const pc = (a.page_id as string).localeCompare(b.page_id as string);
      return pc !== 0 ? pc : (a.footnote as number) - (b.footnote as number);
    });
  }

  // --- citation_content: INSERT ... ON CONFLICT DO UPDATE ---
  if (q.includes("insert into") && q.includes("citation_content")) {
    const url = params[0] as string;
    const pageId = params[1];
    const footnote = params[2];
    const fetchedAt = params[3];
    const httpStatus = params[4];
    const contentType = params[5];
    const pageTitle = params[6];
    const fullTextPreview = params[7];
    const contentLength = params[8];
    const contentHash = params[9];
    const now = new Date();
    const existing = contentStore.get(url);
    const row: Record<string, unknown> = {
      url, page_id: pageId, footnote, fetched_at: fetchedAt,
      http_status: httpStatus, content_type: contentType,
      page_title: pageTitle, full_text_preview: fullTextPreview,
      content_length: contentLength, content_hash: contentHash,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    contentStore.set(url, row);
    return [row];
  }

  // --- citation_content: SELECT * WHERE url ---
  if (q.includes("citation_content") && q.includes("where")) {
    const url = params[0] as string;
    const row = contentStore.get(url);
    return row ? [row] : [];
  }

  // --- entity_ids fallbacks (for health check count) ---
  if (q.includes("count(*)")) {
    return [{ count: 0 }];
  }

  // --- sequence health check ---
  if (q.includes("last_value")) {
    return [{ last_value: 0, is_called: true }];
  }

  return [];
}

// Mock the db module
vi.mock("../db.js", () => mockDbModule(dispatch));

const { createApp } = await import("../app.js");

// ---- Helpers ----

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

      await postJson(app, "/api/citations/quotes/mark-verified", {
        pageId: "broken-page", footnote: 1, method: "text-match", score: 0.2,
      });
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

  // ---- Mark Accuracy Batch ----

  describe("POST /api/citations/quotes/mark-accuracy-batch", () => {
    it("marks accuracy for multiple citations", async () => {
      await upsertQuote(app, "batch-acc", 1);
      await upsertQuote(app, "batch-acc", 2);
      await upsertQuote(app, "batch-acc", 3);

      const res = await postJson(app, "/api/citations/quotes/mark-accuracy-batch", {
        items: [
          { pageId: "batch-acc", footnote: 1, verdict: "accurate", score: 0.95 },
          { pageId: "batch-acc", footnote: 2, verdict: "inaccurate", score: 0.3, issues: "Wrong number" },
          { pageId: "batch-acc", footnote: 3, verdict: "minor_issues", score: 0.7, verificationDifficulty: "easy" },
        ],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.updated).toBe(3);
      expect(body.results).toHaveLength(3);
      expect(body.results[1].verdict).toBe("inaccurate");
    });

    it("rejects invalid verdict in batch", async () => {
      const res = await postJson(app, "/api/citations/quotes/mark-accuracy-batch", {
        items: [
          { pageId: "batch-acc", footnote: 1, verdict: "maybe", score: 0.5 },
        ],
      });
      expect(res.status).toBe(400);
    });

    it("rejects empty batch", async () => {
      const res = await postJson(app, "/api/citations/quotes/mark-accuracy-batch", {
        items: [],
      });
      expect(res.status).toBe(400);
    });
  });

  // ---- Accuracy Snapshot ----

  describe("POST /api/citations/accuracy-snapshot", () => {
    it("creates snapshots for pages with accuracy data", async () => {
      await upsertQuote(app, "snap-page", 1);
      await upsertQuote(app, "snap-page", 2);

      await postJson(app, "/api/citations/quotes/mark-accuracy", {
        pageId: "snap-page", footnote: 1, verdict: "accurate", score: 0.9,
      });
      await postJson(app, "/api/citations/quotes/mark-accuracy", {
        pageId: "snap-page", footnote: 2, verdict: "inaccurate", score: 0.3,
      });

      const res = await postJson(app, "/api/citations/accuracy-snapshot", {});
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.snapshotCount).toBe(1);
      expect(body.pages).toContain("snap-page");
    });
  });

  // ---- Accuracy Trends ----

  describe("GET /api/citations/accuracy-trends", () => {
    it("returns trends for a specific page", async () => {
      await upsertQuote(app, "trend-page", 1);
      await postJson(app, "/api/citations/quotes/mark-accuracy", {
        pageId: "trend-page", footnote: 1, verdict: "accurate", score: 0.9,
      });
      await postJson(app, "/api/citations/accuracy-snapshot", {});

      const res = await app.request("/api/citations/accuracy-trends?page_id=trend-page");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pageId).toBe("trend-page");
      expect(body.snapshots).toHaveLength(1);
    });

    it("returns global trends when no page_id", async () => {
      const res = await app.request("/api/citations/accuracy-trends");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.snapshots).toBeDefined();
    });
  });

  // ---- Accuracy Dashboard ----

  describe("GET /api/citations/accuracy-dashboard", () => {
    it("returns full dashboard data", async () => {
      await upsertQuote(app, "dash-page", 1, "First claim");
      await upsertQuote(app, "dash-page", 2, "Second claim");

      await postJson(app, "/api/citations/quotes/mark-accuracy", {
        pageId: "dash-page", footnote: 1, verdict: "accurate", score: 0.9,
      });
      await postJson(app, "/api/citations/quotes/mark-accuracy", {
        pageId: "dash-page", footnote: 2, verdict: "inaccurate", score: 0.3,
        issues: "Wrong number",
      });

      const res = await app.request("/api/citations/accuracy-dashboard");
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.summary).toBeDefined();
      expect(body.summary.totalCitations).toBe(2);
      expect(body.summary.checkedCitations).toBe(2);
      expect(body.summary.accurateCitations).toBe(1);
      expect(body.summary.inaccurateCitations).toBe(1);

      expect(body.pages).toHaveLength(1);
      expect(body.pages[0].pageId).toBe("dash-page");

      expect(body.flaggedCitations).toHaveLength(1);
      expect(body.flaggedCitations[0].verdict).toBe("inaccurate");
    });

    it("returns empty dashboard when no quotes", async () => {
      const res = await app.request("/api/citations/accuracy-dashboard");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.summary.totalCitations).toBe(0);
      expect(body.pages).toHaveLength(0);
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
