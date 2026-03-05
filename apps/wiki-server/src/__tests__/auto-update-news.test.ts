import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  type SqlDispatcher,
  mockDbModule,
  createQueryResult,
  postJson,
} from "./test-utils";
import type { autoUpdateRuns, autoUpdateNewsItems } from "../schema.js";

// ---- In-memory stores ----
// Store types are derived from the Drizzle schema so TypeScript catches column renames.

let nextRunId = 1;
let nextNewsId = 1;

// Types derived from Drizzle schema — TypeScript will catch column renames.
// pageSlug/routedToPageSlug are synthetic convenience fields (not real DB columns).
type RunRow = typeof autoUpdateRuns.$inferSelect;
// routedToPageSlug is synthetic — not a real DB column, derived from routed_to_page_id_int JOIN
type NewsRow = typeof autoUpdateNewsItems.$inferSelect & { routedToPageSlug: string | null };

let runStore: RunRow[];
let newsStore: NewsRow[];

let nextSlugIntId = 1000;
const slugIntIdMap = new Map<string, number>();

function getIntIdForSlug(slug: string): number {
  if (!slugIntIdMap.has(slug)) {
    slugIntIdMap.set(slug, nextSlugIntId++);
  }
  return slugIntIdMap.get(slug)!;
}

/** Reverse-lookup: recover slug from integer ID. */
function slugFromIntId(intId: number | null): string | null {
  if (intId === null) return null;
  for (const [slug, id] of slugIntIdMap.entries()) {
    if (id === intId) return slug;
  }
  return null;
}

function resetStores() {
  runStore = [];
  newsStore = [];
  nextRunId = 1;
  nextNewsId = 1;
  nextSlugIntId = 1000;
  slugIntIdMap.clear();
}

function resetNewsStore() {
  newsStore = [];
  nextNewsId = 1;
}

/** Convert a RunRow (camelCase) to a raw SQL row (snake_case). */
function runToSqlRow(r: RunRow): Record<string, unknown> {
  return {
    id: r.id,
    date: r.date,
    started_at: r.startedAt,
    completed_at: r.completedAt,
    trigger: r.trigger,
    budget_limit: r.budgetLimit,
    budget_spent: r.budgetSpent,
    sources_checked: r.sourcesChecked,
    sources_failed: r.sourcesFailed,
    items_fetched: r.itemsFetched,
    items_relevant: r.itemsRelevant,
    pages_planned: r.pagesPlanned,
    pages_updated: r.pagesUpdated,
    pages_failed: r.pagesFailed,
    pages_skipped: r.pagesSkipped,
    new_pages_created: r.newPagesCreated,
    details_json: r.detailsJson,
    created_at: r.createdAt,
  };
}

function makeRun(overrides: Partial<RunRow> = {}): RunRow {
  const { id: overrideId, ...rest } = overrides;
  const id = overrideId ?? nextRunId++;
  // Ensure auto-id counter stays ahead of any explicitly-supplied id so that
  // future auto-id calls never collide with explicit ones.
  if (overrideId !== undefined) nextRunId = Math.max(nextRunId, overrideId + 1);
  return {
    id,
    date: "2026-02-21",
    startedAt: new Date("2026-02-21T06:00:00Z"),
    completedAt: new Date("2026-02-21T07:00:00Z"),
    trigger: "scheduled",
    budgetLimit: null,
    budgetSpent: null,
    sourcesChecked: null,
    sourcesFailed: null,
    itemsFetched: null,
    itemsRelevant: null,
    pagesPlanned: null,
    pagesUpdated: null,
    pagesFailed: null,
    pagesSkipped: null,
    newPagesCreated: null,
    detailsJson: null,
    createdAt: new Date(),
    ...rest,
  };
}

function makeNews(runId: number, overrides: Partial<NewsRow> = {}): NewsRow {
  const base: NewsRow = {
    id: nextNewsId++,
    runId: runId,
    title: "Test News Item",
    url: "https://example.com/news",
    sourceId: "test-source",
    publishedAt: null,
    summary: null,
    relevanceScore: 50,
    topicsJson: null,
    entitiesJson: null,
    routedToPageId: null,   // page_id_old column — null in D2a
    routedToPageIdInt: null,
    routedToPageSlug: null, // synthetic convenience field
    routedToPageTitle: null,
    routedTier: null,
    createdAt: new Date(),
    ...overrides,
  };
  // Auto-populate routedToPageIdInt and routedToPageSlug from routedToPageSlug if not explicitly set
  if (base.routedToPageSlug) {
    if (base.routedToPageIdInt === null) {
      base.routedToPageIdInt = getIntIdForSlug(base.routedToPageSlug);
    }
  } else if (base.routedToPageIdInt !== null) {
    base.routedToPageSlug = slugFromIntId(base.routedToPageIdInt);
  }
  return base;
}

/** Convert a NewsRow (camelCase) to a raw SQL row (snake_case) for dispatch returns. */
function newsToSqlRow(r: NewsRow): Record<string, unknown> {
  return {
    id: r.id,
    run_id: r.runId,
    title: r.title,
    url: r.url,
    source_id: r.sourceId,
    published_at: r.publishedAt,
    summary: r.summary,
    relevance_score: r.relevanceScore,
    topics_json: r.topicsJson,
    entities_json: r.entitiesJson,
    routed_to_page_id_old: r.routedToPageId,
    routed_to_page_id_int: r.routedToPageIdInt,
    routed_to_page_title: r.routedToPageTitle,
    routed_tier: r.routedTier,
    created_at: r.createdAt,
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
    ...newsToSqlRow(news),
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

  // ---- entity_ids: SELECT WHERE slug (for resolvePageIntId/resolvePageIntIds) ----
  if (q.includes("entity_ids") && q.includes("where") && q.includes("slug")) {
    // Allocating on first use mirrors production where all page slugs have entity_ids.
    // Phase C verified zero NULLs, so every slug encountered here will have an ID.
    return params.map((p) => ({ numeric_id: getIntIdForSlug(String(p)), slug: p }));
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
    // Phase D2a: removed routed_to_page_id (page_id_old) — 12 columns:
    //   run_id, title, url, source_id, published_at, summary,
    //   relevance_score, topics_json, entities_json, routed_to_page_id_int,
    //   routed_to_page_title, routed_tier
    const COLS = 12;
    const numRows = params.length / COLS;
    const rows: NewsRow[] = [];
    for (let i = 0; i < numRows; i++) {
      const o = i * COLS;
      const routedIntId = params[o + 9] as number | null;
      const routedSlug = slugFromIntId(routedIntId);
      const row: NewsRow = {
        id: nextNewsId++,
        runId: params[o] as number,
        title: params[o + 1] as string,
        url: params[o + 2] as string,
        sourceId: params[o + 3] as string,
        publishedAt: params[o + 4] as string | null,
        summary: params[o + 5] as string | null,
        relevanceScore: params[o + 6] as number | null,
        topicsJson: params[o + 7] as string[] | null,
        entitiesJson: params[o + 8] as string[] | null,
        routedToPageId: null, // D2a: not written on insert (page_id_old column)
        routedToPageIdInt: routedIntId,
        routedToPageSlug: routedSlug, // synthetic convenience field for tests
        routedToPageTitle: params[o + 10] as string | null,
        routedTier: params[o + 11] as string | null,
        createdAt: new Date(),
      };
      newsStore.push(row);
      rows.push(row);
    }
    return rows.map(newsToSqlRow);
  }

  // ---- SELECT count(*) FROM auto_update_news_items ----
  // Used by the /recent endpoint for the total count.
  if (q.includes("count(*)") && q.includes("auto_update_news_items")) {
    return [{ count: newsStore.length }];
  }

  // ---- SELECT FROM auto_update_news_items WHERE run_id IN ($1, $2, ...)  ----
  // Used by GET /dashboard (Drizzle inArray() generates `in (` syntax, not `any(`;
  // the `any(` branch is omitted deliberately as it is dead code with inArray).
  if (
    q.includes("auto_update_news_items") &&
    q.includes(" in (") &&
    q.includes("run_id")
  ) {
    const ids = params.map(Number);
    return newsStore
      .filter((r) => ids.includes(r.runId))
      .sort((a, b) => (b.relevanceScore ?? -1) - (a.relevanceScore ?? -1))
      .map(newsToSqlRow);
  }

  // ---- SELECT FROM auto_update_news_items INNER JOIN auto_update_runs
  //      WHERE routed_to_page_id_int = $1  (GET /by-page, Phase 4b)  ----
  // The WHERE clause distinguishes this from /recent, which has no WHERE.
  if (
    q.includes("auto_update_news_items") &&
    q.includes("inner join") &&
    q.includes("where")
  ) {
    const intId = params[0] as number;
    return newsStore
      .filter((r) => r.routedToPageIdInt === intId)
      .map((r) => {
        const run = runStore.find((run) => run.id === r.runId);
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
        const run = runStore.find((run) => run.id === r.runId);
        return run ? joinNewsWithRun(r, run) : null;
      })
      .filter(Boolean) as ReturnType<typeof joinNewsWithRun>[];
    return joined.slice(offset, offset + limit);
  }

  // ---- SELECT FROM auto_update_news_items WHERE run_id = $1  (GET /by-run) ----
  // Phase D2a: query now uses LEFT JOIN wiki_pages + COALESCE for routedToPageSlug.
  // The SELECT expands all 15 schema columns + 1 COALESCE at position 15.
  // extractColumns returns null for the COALESCE (identifiers inside parens),
  // so .values() uses Object.values(row)[15] for that position.
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
      .filter((r) => r.runId === runId)
      .sort((a, b) => (b.relevanceScore ?? -1) - (a.relevanceScore ?? -1))
      .map((r) => {
        // Strip routedToPageSlug (synthetic field — not a real SQL column)
        // then append the COALESCE result so it lands at position 15.
        // D2a COALESCE: routed_to_page_id_old ?? wiki_pages.id (via int lookup)
        const { routedToPageSlug: _slug, ...rest } = r;
        return {
          ...newsToSqlRow({ ...r }),
          _coalesce_result:
            r.routedToPageId ??
            slugFromIntId(r.routedToPageIdInt) ??
            null,
        };
      });
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
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, limit)
      .map(runToSqlRow);
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
      newsStore.push(makeNews(1, { title: "Item A", relevanceScore: 90 }));
      newsStore.push(makeNews(1, { title: "Item B", relevanceScore: 70 }));
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
      resetNewsStore();
      newsStore.push(
        makeNews(1, {
          topicsJson: ["alignment", "safety"],
          entitiesJson: ["anthropic"],
          routedToPageSlug: "alignment",
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
      resetNewsStore();
      newsStore.push(makeNews(1, { topicsJson: null, entitiesJson: null }));
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
      newsStore.push(makeNews(1, { title: "Recent", relevanceScore: 80 }));
      newsStore.push(makeNews(2, { title: "Older", relevanceScore: 60 }));
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
        makeNews(1, { title: "Routed", routedToPageSlug: "alignment" })
      );
      newsStore.push(
        makeNews(1, { title: "Other Page", routedToPageSlug: "interpretability" })
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
          startedAt: new Date("2026-02-21T06:00:00Z"),
        })
      );
      runStore.push(
        makeRun({
          id: 2,
          date: "2026-02-20",
          startedAt: new Date("2026-02-20T06:00:00Z"),
        })
      );
      newsStore.push(makeNews(1, { title: "Latest Run Item", relevanceScore: 90 }));
      newsStore.push(makeNews(2, { title: "Older Run Item", relevanceScore: 70 }));
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

    it("accepts runs=50 (boundary of maximum)", async () => {
      const res = await app.request("/api/auto-update-news/dashboard?runs=50");
      expect(res.status).toBe(200);
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
          startedAt: new Date("2026-02-21T08:00:00Z"),
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
