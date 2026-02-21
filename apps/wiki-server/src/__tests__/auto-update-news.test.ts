import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  type SqlDispatcher,
  mockDbModule,
  createQueryResult,
  postJson,
} from "./test-utils";

// ---- In-memory stores ----

let nextRunId = 1;
let nextNewsId = 1;

type RunRow = {
  id: number;
  date: string;
  started_at: Date;
  completed_at: Date | null;
  trigger: string;
  budget_limit: number | null;
  budget_spent: number | null;
  sources_checked: number | null;
  sources_failed: number | null;
  items_fetched: number | null;
  items_relevant: number | null;
  pages_planned: number | null;
  pages_updated: number | null;
  pages_failed: number | null;
  pages_skipped: number | null;
  new_pages_created: string | null;
  details_json: unknown;
  created_at: Date;
};

type NewsRow = {
  id: number;
  run_id: number;
  title: string;
  url: string;
  source_id: string;
  published_at: string | null;
  summary: string | null;
  relevance_score: number | null;
  topics_json: string[] | null;
  entities_json: string[] | null;
  routed_to_page_id: string | null;
  routed_to_page_title: string | null;
  routed_tier: string | null;
  created_at: Date;
};

let runStore: RunRow[];
let newsStore: NewsRow[];

function resetStores() {
  runStore = [];
  newsStore = [];
  nextRunId = 1;
  nextNewsId = 1;
}

function makeRun(overrides: Partial<RunRow> = {}): RunRow {
  const { id: overrideId, ...rest } = overrides;
  const id = overrideId ?? nextRunId++;
  return {
    id,
    date: "2026-02-21",
    started_at: new Date("2026-02-21T06:00:00Z"),
    completed_at: new Date("2026-02-21T07:00:00Z"),
    trigger: "scheduled",
    budget_limit: null,
    budget_spent: null,
    sources_checked: null,
    sources_failed: null,
    items_fetched: null,
    items_relevant: null,
    pages_planned: null,
    pages_updated: null,
    pages_failed: null,
    pages_skipped: null,
    new_pages_created: null,
    details_json: null,
    created_at: new Date(),
    ...rest,
  };
}

function makeNews(runId: number, overrides: Partial<NewsRow> = {}): NewsRow {
  return {
    id: nextNewsId++,
    run_id: runId,
    title: "Test News Item",
    url: "https://example.com/news",
    source_id: "test-source",
    published_at: null,
    summary: null,
    relevance_score: 50,
    topics_json: null,
    entities_json: null,
    routed_to_page_id: null,
    routed_to_page_title: null,
    routed_tier: null,
    created_at: new Date(),
    ...overrides,
  };
}

/**
 * Build a flat row combining all news item columns plus `date` from the
 * joined run. The column order / names must match what Drizzle's SELECT
 * clause produces so that `extractColumns` + `values()` in test-utils
 * correctly maps positional arrays back to objects.
 */
function joinNewsWithRun(news: NewsRow, run: RunRow) {
  return {
    id: news.id,
    run_id: news.run_id,
    title: news.title,
    url: news.url,
    source_id: news.source_id,
    published_at: news.published_at,
    summary: news.summary,
    relevance_score: news.relevance_score,
    topics_json: news.topics_json,
    entities_json: news.entities_json,
    routed_to_page_id: news.routed_to_page_id,
    routed_to_page_title: news.routed_to_page_title,
    routed_tier: news.routed_tier,
    created_at: news.created_at,
    date: run.date,
  };
}

const dispatch: SqlDispatcher = (query, params) => {
  const q = query.toLowerCase();

  // ---- Health / entity_ids ----
  if (q.includes("count(*)") && q.includes("entity_ids")) {
    return [{ count: 0 }];
  }
  if (q.includes("last_value")) {
    return [{ last_value: 0, is_called: false }];
  }

  // ---- TRUNCATE ----
  if (q.includes("truncate")) {
    if (q.includes("auto_update_news_items")) {
      newsStore = [];
      nextNewsId = 1;
    }
    if (q.includes("auto_update_runs")) {
      runStore = [];
      nextRunId = 1;
    }
    return [];
  }

  // ---- INSERT INTO auto_update_news_items ----
  if (q.includes("insert into") && q.includes("auto_update_news_items")) {
    // Drizzle inserts: run_id, title, url, source_id, published_at, summary,
    //   relevance_score, topics_json, entities_json, routed_to_page_id,
    //   routed_to_page_title, routed_tier  (12 columns)
    const COLS = 12;
    const numRows = params.length / COLS;
    const rows: NewsRow[] = [];
    for (let i = 0; i < numRows; i++) {
      const o = i * COLS;
      const row: NewsRow = {
        id: nextNewsId++,
        run_id: params[o] as number,
        title: params[o + 1] as string,
        url: params[o + 2] as string,
        source_id: params[o + 3] as string,
        published_at: params[o + 4] as string | null,
        summary: params[o + 5] as string | null,
        relevance_score: params[o + 6] as number | null,
        topics_json: params[o + 7] as string[] | null,
        entities_json: params[o + 8] as string[] | null,
        routed_to_page_id: params[o + 9] as string | null,
        routed_to_page_title: params[o + 10] as string | null,
        routed_tier: params[o + 11] as string | null,
        created_at: new Date(),
      };
      newsStore.push(row);
      rows.push(row);
    }
    return rows;
  }

  // ---- SELECT count(*) FROM auto_update_news_items ----
  // Used by the /recent endpoint for the total count.
  if (q.includes("count(*)") && q.includes("auto_update_news_items")) {
    return [{ count: newsStore.length }];
  }

  // ---- SELECT FROM auto_update_news_items WHERE run_id IN ($1, $2, ...)  ----
  // Used by GET /dashboard (Drizzle inArray spreads params individually).
  if (
    q.includes("auto_update_news_items") &&
    (q.includes(" in (") || q.includes("any(")) &&
    q.includes("run_id")
  ) {
    const ids = params.map(Number);
    return newsStore
      .filter((r) => ids.includes(r.run_id))
      .sort((a, b) => (b.relevance_score ?? -1) - (a.relevance_score ?? -1));
  }

  // ---- SELECT FROM auto_update_news_items INNER JOIN auto_update_runs
  //      WHERE routed_to_page_id = $1  (GET /by-page)  ----
  // The WHERE clause distinguishes this from /recent, which has no WHERE.
  if (
    q.includes("auto_update_news_items") &&
    q.includes("inner join") &&
    q.includes("where")
  ) {
    const pageId = params[0] as string;
    return newsStore
      .filter((r) => r.routed_to_page_id === pageId)
      .map((r) => {
        const run = runStore.find((run) => run.id === r.run_id);
        return run ? joinNewsWithRun(r, run) : null;
      })
      .filter(Boolean) as ReturnType<typeof joinNewsWithRun>[];
  }

  // ---- SELECT FROM auto_update_news_items INNER JOIN auto_update_runs
  //      ORDER BY ... LIMIT ... OFFSET ...  (GET /recent)  ----
  // No standalone WHERE clause — the only ON clause is part of the JOIN.
  if (
    q.includes("auto_update_news_items") &&
    q.includes("inner join") &&
    !q.includes("where") &&
    q.includes("limit")
  ) {
    const limit = (params[0] as number) || 100;
    const offset = (params[1] as number) || 0;
    const joined = newsStore
      .map((r) => {
        const run = runStore.find((run) => run.id === r.run_id);
        return run ? joinNewsWithRun(r, run) : null;
      })
      .filter(Boolean) as ReturnType<typeof joinNewsWithRun>[];
    return joined.slice(offset, offset + limit);
  }

  // ---- SELECT FROM auto_update_news_items WHERE run_id = $1  (GET /by-run) ----
  // Note: the SELECT clause also contains routed_to_page_id as a column, so we
  // cannot use that string to distinguish this query – we rely on the absence
  // of `inner join` and `in (` instead.
  if (
    q.includes("auto_update_news_items") &&
    !q.includes("inner join") &&
    !q.includes(" in (") &&
    !q.includes("any(") &&
    q.includes("where") &&
    q.includes("run_id")
  ) {
    const runId = params[0] as number;
    return newsStore
      .filter((r) => r.run_id === runId)
      .sort((a, b) => (b.relevance_score ?? -1) - (a.relevance_score ?? -1));
  }

  // ---- SELECT FROM auto_update_runs ORDER BY started_at LIMIT N
  //      (GET /dashboard — fetch last N runs)  ----
  if (
    q.includes("auto_update_runs") &&
    q.includes("order by") &&
    q.includes("started_at") &&
    q.includes("limit")
  ) {
    const limit = (params[0] as number) || 10;
    return [...runStore]
      .sort((a, b) => b.started_at.getTime() - a.started_at.getTime())
      .slice(0, limit);
  }

  return [];
};

vi.mock("../db.js", () => mockDbModule(dispatch));

const { createApp } = await import("../app.js");

// ---- Tests ----

describe("Auto-Update News API", () => {
  let app: Hono;

  beforeEach(() => {
    resetStores();
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    app = createApp();
  });

  const sampleItem = {
    title: "AI Safety Breakthrough",
    url: "https://example.com/ai-safety",
    sourceId: "arxiv",
    publishedAt: "2026-02-21",
    summary: "A major breakthrough in AI safety research.",
    relevanceScore: 85,
    topics: ["alignment", "interpretability"],
    entities: ["anthropic"],
    routedToPageId: "alignment",
    routedToPageTitle: "Alignment",
    routedTier: "standard",
  };

  // ---- POST /batch ----

  describe("POST /api/auto-update-news/batch", () => {
    beforeEach(() => {
      runStore.push(makeRun({ id: 1 }));
    });

    it("inserts news items and returns 201 with count", async () => {
      const res = await postJson(app, "/api/auto-update-news/batch", {
        runId: 1,
        items: [sampleItem],
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.inserted).toBe(1);
      expect(newsStore).toHaveLength(1);
      expect(newsStore[0].title).toBe("AI Safety Breakthrough");
    });

    it("inserts multiple items in one batch", async () => {
      const res = await postJson(app, "/api/auto-update-news/batch", {
        runId: 1,
        items: [
          sampleItem,
          { ...sampleItem, title: "Second Item", url: "https://example.com/2" },
        ],
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.inserted).toBe(2);
    });

    it("rejects missing required field (title)", async () => {
      const { title: _title, ...noTitle } = sampleItem;
      const res = await postJson(app, "/api/auto-update-news/batch", {
        runId: 1,
        items: [noTitle],
      });
      expect(res.status).toBe(400);
    });

    it("rejects empty items array", async () => {
      const res = await postJson(app, "/api/auto-update-news/batch", {
        runId: 1,
        items: [],
      });
      expect(res.status).toBe(400);
    });

    it("rejects invalid JSON body", async () => {
      const res = await app.request("/api/auto-update-news/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      });
      expect(res.status).toBe(400);
    });

    it("rejects relevanceScore out of range (>100)", async () => {
      const res = await postJson(app, "/api/auto-update-news/batch", {
        runId: 1,
        items: [{ ...sampleItem, relevanceScore: 101 }],
      });
      expect(res.status).toBe(400);
    });
  });

  // ---- GET /by-run/:runId ----

  describe("GET /api/auto-update-news/by-run/:runId", () => {
    beforeEach(() => {
      runStore.push(makeRun({ id: 1 }));
      runStore.push(makeRun({ id: 2 }));
      newsStore.push(makeNews(1, { title: "Item A", relevance_score: 90 }));
      newsStore.push(makeNews(1, { title: "Item B", relevance_score: 70 }));
      newsStore.push(makeNews(2, { title: "Other Run Item" }));
    });

    it("returns items for the specified run", async () => {
      const res = await app.request("/api/auto-update-news/by-run/1");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toHaveLength(2);
      expect(body.items.every((i: any) => i.runId === 1)).toBe(true);
    });

    it("returns items in descending relevance order", async () => {
      const res = await app.request("/api/auto-update-news/by-run/1");
      const body = await res.json();
      expect(body.items[0].title).toBe("Item A");
      expect(body.items[1].title).toBe("Item B");
    });

    it("returns empty items array for a run with no news", async () => {
      const res = await app.request("/api/auto-update-news/by-run/99");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toHaveLength(0);
    });

    it("returns 400 for non-numeric runId", async () => {
      const res = await app.request("/api/auto-update-news/by-run/abc");
      expect(res.status).toBe(400);
    });

    it("maps topics and entities to arrays (not null)", async () => {
      newsStore.length = 0;
      nextNewsId = 1;
      newsStore.push(
        makeNews(1, {
          topics_json: ["alignment", "safety"],
          entities_json: ["anthropic"],
          routed_to_page_id: "alignment",
        })
      );
      const res = await app.request("/api/auto-update-news/by-run/1");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toHaveLength(1);
      expect(body.items[0].topics).toEqual(["alignment", "safety"]);
      expect(body.items[0].entities).toEqual(["anthropic"]);
      expect(body.items[0].routedToPageId).toBe("alignment");
    });

    it("returns empty arrays for null topics/entities", async () => {
      newsStore.length = 0;
      nextNewsId = 1;
      newsStore.push(makeNews(1, { topics_json: null, entities_json: null }));
      const res = await app.request("/api/auto-update-news/by-run/1");
      const body = await res.json();
      expect(body.items[0].topics).toEqual([]);
      expect(body.items[0].entities).toEqual([]);
    });
  });

  // ---- GET /recent ----

  describe("GET /api/auto-update-news/recent", () => {
    beforeEach(() => {
      runStore.push(makeRun({ id: 1, date: "2026-02-21" }));
      runStore.push(makeRun({ id: 2, date: "2026-02-20" }));
      newsStore.push(makeNews(1, { title: "Recent", relevance_score: 80 }));
      newsStore.push(makeNews(2, { title: "Older", relevance_score: 60 }));
    });

    it("returns items with total, limit, and offset", async () => {
      const res = await app.request("/api/auto-update-news/recent");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toBeDefined();
      expect(body.total).toBe(2);
      expect(body.limit).toBe(100);
      expect(body.offset).toBe(0);
    });

    it("respects limit and offset query params", async () => {
      const res = await app.request(
        "/api/auto-update-news/recent?limit=1&offset=0"
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toHaveLength(1);
      expect(body.limit).toBe(1);
    });

    it("rejects limit=0 as invalid", async () => {
      const res = await app.request("/api/auto-update-news/recent?limit=0");
      expect(res.status).toBe(400);
    });

    it("rejects limit above MAX_PAGE_SIZE (1000)", async () => {
      const res = await app.request("/api/auto-update-news/recent?limit=9999");
      expect(res.status).toBe(400);
    });

    it("returns empty result when no news exists", async () => {
      newsStore.length = 0;
      const res = await app.request("/api/auto-update-news/recent");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toHaveLength(0);
      expect(body.total).toBe(0);
    });
  });

  // ---- GET /by-page/:pageId ----

  describe("GET /api/auto-update-news/by-page/:pageId", () => {
    beforeEach(() => {
      runStore.push(makeRun({ id: 1, date: "2026-02-21" }));
      newsStore.push(
        makeNews(1, { title: "Routed", routed_to_page_id: "alignment" })
      );
      newsStore.push(
        makeNews(1, { title: "Other Page", routed_to_page_id: "interpretability" })
      );
    });

    it("returns only items routed to the specified page", async () => {
      const res = await app.request("/api/auto-update-news/by-page/alignment");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toHaveLength(1);
      expect(body.items[0].routedToPageId).toBe("alignment");
    });

    it("returns empty array for a page with no routed items", async () => {
      const res = await app.request("/api/auto-update-news/by-page/nonexistent");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toHaveLength(0);
    });

    it("includes runDate in the response", async () => {
      const res = await app.request("/api/auto-update-news/by-page/alignment");
      const body = await res.json();
      expect(body.items[0].runDate).toBe("2026-02-21");
    });
  });

  // ---- GET /dashboard ----

  describe("GET /api/auto-update-news/dashboard", () => {
    beforeEach(() => {
      runStore.push(
        makeRun({
          id: 1,
          date: "2026-02-21",
          started_at: new Date("2026-02-21T06:00:00Z"),
        })
      );
      runStore.push(
        makeRun({
          id: 2,
          date: "2026-02-20",
          started_at: new Date("2026-02-20T06:00:00Z"),
        })
      );
      newsStore.push(makeNews(1, { title: "Latest Run Item", relevance_score: 90 }));
      newsStore.push(makeNews(2, { title: "Older Run Item", relevance_score: 70 }));
    });

    it("returns items and runDates for the default last 10 runs", async () => {
      const res = await app.request("/api/auto-update-news/dashboard");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toHaveLength(2);
      expect(body.runDates).toBeDefined();
    });

    it("respects the runs query param to limit how many runs are included", async () => {
      const res = await app.request("/api/auto-update-news/dashboard?runs=1");
      expect(res.status).toBe(200);
      const body = await res.json();
      // Only items from the most recent run
      expect(body.items).toHaveLength(1);
      expect(body.items[0].title).toBe("Latest Run Item");
    });

    it("returns empty items and runDates when no runs exist", async () => {
      runStore.length = 0;
      newsStore.length = 0;
      const res = await app.request("/api/auto-update-news/dashboard");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toHaveLength(0);
      expect(body.runDates).toHaveLength(0);
    });

    it("rejects runs=0 as invalid", async () => {
      const res = await app.request("/api/auto-update-news/dashboard?runs=0");
      expect(res.status).toBe(400);
    });

    it("rejects runs=abc (NaN guard via Zod)", async () => {
      const res = await app.request("/api/auto-update-news/dashboard?runs=abc");
      expect(res.status).toBe(400);
    });

    it("rejects runs above the maximum of 50", async () => {
      const res = await app.request("/api/auto-update-news/dashboard?runs=51");
      expect(res.status).toBe(400);
    });

    it("attaches runDate to each item", async () => {
      const res = await app.request("/api/auto-update-news/dashboard");
      const body = await res.json();
      const item = body.items.find((i: any) => i.title === "Latest Run Item");
      expect(item?.runDate).toBe("2026-02-21");
    });

    it("deduplicates runDates in the response", async () => {
      // Two runs on the same date
      runStore.push(
        makeRun({
          id: 3,
          date: "2026-02-21",
          started_at: new Date("2026-02-21T08:00:00Z"),
        })
      );
      newsStore.push(makeNews(3, { title: "Same Date" }));

      const res = await app.request("/api/auto-update-news/dashboard");
      const body = await res.json();
      const feb21Count = body.runDates.filter(
        (d: string) => d === "2026-02-21"
      ).length;
      expect(feb21Count).toBe(1);
    });
  });
});
