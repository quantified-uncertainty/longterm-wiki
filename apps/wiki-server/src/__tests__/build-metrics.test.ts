import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { mockDbModule, postJson } from "./test-utils.js";

// ---- In-memory stores ----

let nextSlugIntId = 1000;
const slugIntIdMap = new Map<string, number>();

// wiki_pages rows (simplified for testing)
interface WikiPageRow {
  integer_id: number;
  coverage_passing: number | null;
  coverage_total: number | null;
  coverage_items: string | null;
  update_frequency: number | null;
  days_since_update: number | null;
  days_until_due: number | null;
  staleness: number | null;
  update_priority: number | null;
  reader_rank: number | null;
  research_rank: number | null;
  recommended_score: number | null;
}

let wikiPagesStore: Map<number, WikiPageRow>;

// similarity rows
interface SimilarityRow {
  id: number;
  page_id_int: number;
  similar_page_id_int: number;
  similarity: number;
  rank: number;
}

let similarityStore: SimilarityRow[];
let nextSimilarityId = 1;

function getIntIdForSlug(slug: string): number {
  if (!slugIntIdMap.has(slug)) {
    slugIntIdMap.set(slug, nextSlugIntId++);
  }
  return slugIntIdMap.get(slug)!;
}

function resetStores() {
  nextSlugIntId = 1000;
  slugIntIdMap.clear();
  wikiPagesStore = new Map();
  similarityStore = [];
  nextSimilarityId = 1;
}

// ---- SQL dispatcher ----

function dispatch(query: string, params: unknown[]): unknown[] {
  const q = query.toLowerCase();

  // ---- entity_ids slug resolution (Drizzle SELECT) ----
  if (q.includes('"entity_ids"') && q.includes('"slug"') && q.includes('"wiki_id"')) {
    const results: Array<{ slug: string; wiki_id: number }> = [];
    for (const p of params) {
      if (typeof p === "string" && slugIntIdMap.has(p)) {
        results.push({ slug: p, wiki_id: slugIntIdMap.get(p)! });
      }
    }
    return results;
  }

  // ---- Advisory lock (no-op in tests) ----
  if (q.includes("pg_advisory_xact_lock")) {
    return [];
  }

  // ---- UPDATE wiki_pages (coverage, schedule, rankings) ----
  if (q.includes("update wiki_pages") && q.includes("jsonb_to_recordset")) {
    const jsonStr = typeof params[0] === "string" ? params[0] : JSON.stringify(params[0]);
    const values = JSON.parse(jsonStr) as Array<Record<string, unknown>>;

    for (const v of values) {
      const intId = v.intId as number;
      const row = wikiPagesStore.get(intId);
      if (!row) continue;

      if ("passing" in v) {
        row.coverage_passing = v.passing as number;
        row.coverage_total = v.total as number;
        row.coverage_items = v.items as string;
      }
      if ("updateFrequency" in v) {
        row.update_frequency = v.updateFrequency as number;
        row.days_since_update = v.daysSinceUpdate as number;
        row.days_until_due = v.daysUntilDue as number;
        row.staleness = v.staleness as number;
        row.update_priority = v.priority as number;
      }
      if ("readerRank" in v) {
        row.reader_rank = v.readerRank as number | null;
        row.research_rank = v.researchRank as number | null;
        row.recommended_score = v.recommendedScore as number | null;
      }
    }

    return [];
  }

  // ---- DELETE similarity ----
  if (q.includes("delete from wikibase_page_similarity")) {
    similarityStore = [];
    return [];
  }

  // ---- INSERT similarity ----
  if (q.includes("insert into wikibase_page_similarity") && q.includes("jsonb_to_recordset")) {
    const jsonStr = typeof params[0] === "string" ? params[0] : JSON.stringify(params[0]);
    const values = JSON.parse(jsonStr) as Array<{
      pageIdInt: number;
      similarPageIdInt: number;
      similarity: number;
      rank: number;
    }>;

    for (const v of values) {
      const existing = similarityStore.find(
        (r) => r.page_id_int === v.pageIdInt && r.rank === v.rank
      );
      if (existing) {
        existing.similar_page_id_int = v.similarPageIdInt;
        existing.similarity = v.similarity;
      } else {
        similarityStore.push({
          id: nextSimilarityId++,
          page_id_int: v.pageIdInt,
          similar_page_id_int: v.similarPageIdInt,
          similarity: v.similarity,
          rank: v.rank,
        });
      }
    }

    return [];
  }

  // ---- Stats queries ----
  if (q.includes("count") && q.includes("coverage_passing") && q.includes("wiki_pages")) {
    const pages = [...wikiPagesStore.values()];
    const withCoverage = pages.filter((p) => p.coverage_passing != null);
    return [{
      total: pages.length,
      with_coverage: withCoverage.length,
      avg_passing: withCoverage.length > 0
        ? (withCoverage.reduce((s, p) => s + (p.coverage_passing ?? 0), 0) / withCoverage.length).toFixed(1)
        : "0",
      avg_total: "12.0",
    }];
  }

  if (q.includes("count") && q.includes("update_frequency") && !q.includes("coverage")) {
    const scheduled = [...wikiPagesStore.values()].filter((p) => p.update_frequency != null);
    return [{
      with_schedule: scheduled.length,
      overdue: scheduled.filter((p) => (p.days_until_due ?? 0) < 0).length,
      avg_staleness: "0.5",
    }];
  }

  if (q.includes("wikibase_page_similarity") && q.includes("count")) {
    const uniquePages = new Set(similarityStore.map((r) => r.page_id_int));
    return [{
      total_pairs: similarityStore.length,
      unique_pages: uniquePages.size,
      avg_similarity: "25.0",
    }];
  }

  throw new Error(`Unhandled query: ${query.slice(0, 200)}`);
}

// ---- Mock wiring ----

vi.mock("../db.js", () => mockDbModule(dispatch));
vi.mock("../auth.js", () => ({
  validateApiKey: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

// ---- App setup ----

let app: Hono;

beforeEach(async () => {
  resetStores();

  for (const slug of ["page-alpha", "page-beta", "page-gamma"]) {
    const intId = getIntIdForSlug(slug);
    wikiPagesStore.set(intId, {
      integer_id: intId,
      coverage_passing: null,
      coverage_total: null,
      coverage_items: null,
      update_frequency: null,
      days_since_update: null,
      days_until_due: null,
      staleness: null,
      update_priority: null,
      reader_rank: null,
      research_rank: null,
      recommended_score: null,
    });
  }

  const { buildMetricsRoute } = await import(
    "../routes/operational/build-metrics.js"
  );
  app = new Hono();
  app.route("/api/build-metrics", buildMetricsRoute);
});

// ---- Tests ----

describe("POST /api/build-metrics/coverage", () => {
  it("updates coverage for known pages", async () => {
    const res = await postJson(app, "/api/build-metrics/coverage", {
      coverage: [
        { pageId: "page-alpha", passing: 8, total: 12, items: { llmSummary: "green", entity: "red" } },
        { pageId: "page-beta", passing: 5, total: 12, items: { llmSummary: "amber" } },
      ],
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(2);

    const alphaId = slugIntIdMap.get("page-alpha")!;
    const alphaRow = wikiPagesStore.get(alphaId)!;
    expect(alphaRow.coverage_passing).toBe(8);
    expect(alphaRow.coverage_total).toBe(12);
  });

  it("rejects empty coverage array", async () => {
    const res = await postJson(app, "/api/build-metrics/coverage", {
      coverage: [],
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/build-metrics/schedule", () => {
  it("updates schedule for known pages", async () => {
    const res = await postJson(app, "/api/build-metrics/schedule", {
      items: [
        {
          pageId: "page-alpha",
          updateFrequency: 30,
          daysSinceUpdate: 45,
          daysUntilDue: -15,
          staleness: 1.5,
          priority: 0.75,
        },
      ],
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(1);

    const alphaId = slugIntIdMap.get("page-alpha")!;
    const alphaRow = wikiPagesStore.get(alphaId)!;
    expect(alphaRow.update_frequency).toBe(30);
    expect(alphaRow.days_until_due).toBe(-15);
  });
});

describe("POST /api/build-metrics/rankings", () => {
  it("updates rankings for known pages", async () => {
    const res = await postJson(app, "/api/build-metrics/rankings", {
      rankings: [
        { pageId: "page-alpha", readerRank: 1, researchRank: 5, recommendedScore: 42.5 },
        { pageId: "page-beta", readerRank: 2, researchRank: null, recommendedScore: 38.1 },
      ],
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(2);

    const alphaId = slugIntIdMap.get("page-alpha")!;
    const alphaRow = wikiPagesStore.get(alphaId)!;
    expect(alphaRow.reader_rank).toBe(1);
    expect(alphaRow.research_rank).toBe(5);
    expect(alphaRow.recommended_score).toBe(42.5);
  });
});

describe("POST /api/build-metrics/similarity", () => {
  it("inserts similarity pairs with replace=true", async () => {
    const res1 = await postJson(app, "/api/build-metrics/similarity", {
      pairs: [
        { pageId: "page-alpha", similarPageId: "page-beta", similarity: 45, rank: 1 },
        { pageId: "page-alpha", similarPageId: "page-gamma", similarity: 30, rank: 2 },
      ],
      replace: true,
    });

    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    expect(body1.upserted).toBe(2);
    expect(similarityStore).toHaveLength(2);

    // Replace with new data
    const res2 = await postJson(app, "/api/build-metrics/similarity", {
      pairs: [
        { pageId: "page-beta", similarPageId: "page-gamma", similarity: 60, rank: 1 },
      ],
      replace: true,
    });

    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.upserted).toBe(1);
    expect(similarityStore).toHaveLength(1);
    expect(similarityStore[0].similarity).toBe(60);
  });

  it("clears all rows when pairs is empty and replace=true", async () => {
    // Pre-populate similarity store
    const seedRes = await postJson(app, "/api/build-metrics/similarity", {
      pairs: [
        { pageId: "page-alpha", similarPageId: "page-beta", similarity: 45, rank: 1 },
        { pageId: "page-alpha", similarPageId: "page-gamma", similarity: 30, rank: 2 },
      ],
      replace: false,
    });
    expect(seedRes.status).toBe(200);
    expect(similarityStore).toHaveLength(2);

    // Send empty replace — should clear the table
    const res = await postJson(app, "/api/build-metrics/similarity", {
      pairs: [],
      replace: true,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.upserted).toBe(0);
    expect(similarityStore).toHaveLength(0);
  });
});

describe("GET /api/build-metrics/stats", () => {
  it("returns aggregate stats", async () => {
    const alphaId = slugIntIdMap.get("page-alpha")!;
    const alphaRow = wikiPagesStore.get(alphaId)!;
    alphaRow.coverage_passing = 8;
    alphaRow.coverage_total = 12;
    alphaRow.update_frequency = 30;
    alphaRow.days_until_due = -5;

    const res = await app.request("/api/build-metrics/stats", {
      method: "GET",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.coverage).toBeDefined();
    expect(body.coverage.totalPages).toBeGreaterThanOrEqual(0);
    expect(body.schedule).toBeDefined();
    expect(body.similarity).toBeDefined();
  });
});
