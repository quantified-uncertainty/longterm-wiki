import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { mockDbModule, postJson } from "./test-utils.js";

// ---- In-memory store simulating the hallucination_risk_snapshots table ----

let nextId = 1;
let nextSlugIntId = 1000;
const slugIntIdMap = new Map<string, number>();
let riskStore: Array<{
  id: number;
  page_id: string;
  page_id_int: number | null;
  score: number;
  level: string;
  factors: string[] | null;
  integrity_issues: string[] | null;
  computed_at: Date;
}>;

/** Whether to simulate the materialized view existing. */
let simulateMatView = false;

/** Count how many times pg_matviews is actually queried (for caching tests). */
let pgMatviewsQueryCount = 0;

function getIntIdForSlug(slug: string): number {
  if (!slugIntIdMap.has(slug)) {
    slugIntIdMap.set(slug, nextSlugIntId++);
  }
  return slugIntIdMap.get(slug)!;
}

/** Non-allocating lookup — returns undefined for slugs not yet in the map. */
function lookupIntIdForSlug(slug: string): number | undefined {
  return slugIntIdMap.get(slug);
}

function resetStore() {
  riskStore = [];
  nextId = 1;
  nextSlugIntId = 1000;
  slugIntIdMap.clear();
  simulateMatView = false;
  pgMatviewsQueryCount = 0;
}

/** Get latest snapshot per page (shared logic for stats/latest mock queries). */
function getLatestByPage() {
  const latestByPage = new Map<string, (typeof riskStore)[0]>();
  for (const r of riskStore) {
    const existing = latestByPage.get(r.page_id);
    if (!existing || r.computed_at > existing.computed_at) {
      latestByPage.set(r.page_id, r);
    }
  }
  return latestByPage;
}

function dispatch(query: string, params: unknown[]): unknown[] {
  const q = query.toLowerCase();

  // ---- pg_matviews check (materialized view existence) ----
  if (q.includes("pg_matviews") && q.includes("hallucination_risk_latest")) {
    pgMatviewsQueryCount++;
    return [{ exists: simulateMatView }];
  }

  // ---- REFRESH MATERIALIZED VIEW (no-op in tests) ----
  if (q.includes("refresh materialized view")) {
    return [];
  }

  // ---- pg_class.reltuples (approximate count for stats) ----
  if (q.includes("reltuples") && q.includes("pg_class") && q.includes("hallucination_risk_snapshots")) {
    return [{ reltuples: riskStore.length }];
  }

  // ---- entity_ids (for health check) ----
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

  // ---- INSERT INTO hallucination_risk_snapshots ----
  if (
    q.includes("insert into") &&
    q.includes("hallucination_risk_snapshots")
  ) {
    const PARAMS_PER_ROW = 6; // Phase 4a: +1 for page_id_int
    const rowCount = Math.max(1, Math.floor(params.length / PARAMS_PER_ROW));
    const results: (typeof riskStore)[number][] = [];

    for (let i = 0; i < rowCount; i++) {
      const off = i * PARAMS_PER_ROW;
      const row = {
        id: nextId++,
        page_id: params[off] as string,
        page_id_int: params[off + 1] as number | null,
        score: params[off + 2] as number,
        level: params[off + 3] as string,
        factors: params[off + 4] as string[] | null,
        integrity_issues: params[off + 5] as string[] | null,
        computed_at: new Date(),
      };
      riskStore.push(row);
      results.push(row);
    }
    return results;
  }

  // ---- Queries against hallucination_risk_latest materialized view ----

  // Stats from matview: SELECT count(*)::int AS count FROM hallucination_risk_latest
  if (
    q.includes("count(*)") &&
    q.includes("hallucination_risk_latest") &&
    !q.includes("group by")
  ) {
    const latestByPage = getLatestByPage();
    return [{ count: latestByPage.size }];
  }

  // Level distribution from matview: SELECT level, count(...) FROM hallucination_risk_latest GROUP BY level
  if (
    q.includes("hallucination_risk_latest") &&
    q.includes("group by") &&
    q.includes("level")
  ) {
    const latestByPage = getLatestByPage();
    const counts: Record<string, number> = {};
    for (const r of latestByPage.values()) {
      counts[r.level] = (counts[r.level] || 0) + 1;
    }
    return Object.entries(counts)
      .map(([level, count]) => ({ level, count }))
      .sort((a, b) => b.count - a.count);
  }

  // Latest from matview: SELECT ... FROM hallucination_risk_latest WHERE/ORDER BY
  if (
    q.includes("hallucination_risk_latest") &&
    q.includes("order by") &&
    q.includes("score")
  ) {
    const latestByPage = getLatestByPage();
    let results = [...latestByPage.values()];

    const levelParam = params.find(
      (p) => p === "high" || p === "medium" || p === "low"
    );
    if (levelParam) {
      results = results.filter((r) => r.level === levelParam);
    }

    results.sort((a, b) => b.score - a.score);

    const numParams = params.filter((p) => typeof p === "number") as number[];
    const limit = numParams[0] || 50;
    const offset = numParams[1] || 0;
    return results.slice(offset, offset + limit);
  }

  // ---- SELECT count(distinct page_id) FROM hallucination_risk_snapshots ----
  if (
    q.includes("count(distinct") &&
    q.includes("page_id") &&
    q.includes("hallucination_risk_snapshots")
  ) {
    const uniquePages = new Set(riskStore.map((e) => e.page_id));
    return [{ page_id: uniquePages.size }];
  }

  // ---- Cleanup dry-run: total count (SELECT count(*)::int AS total) ----
  if (
    q.includes("count(*)") &&
    q.includes("as total") &&
    q.includes("hallucination_risk_snapshots")
  ) {
    return [{ total: riskStore.length }];
  }

  // ---- SELECT count(*) FROM hallucination_risk_snapshots (not GROUP BY) ----
  if (
    q.includes("count(*)") &&
    q.includes("hallucination_risk_snapshots") &&
    !q.includes("group by") &&
    !q.includes("not in")
  ) {
    return [{ count: riskStore.length }];
  }

  // ---- Stats: DISTINCT ON level distribution (raw SQL tagged template) ----
  // Matches: SELECT level, count(*)::int AS count FROM (SELECT DISTINCT ON ...
  if (
    q.includes("distinct on") &&
    q.includes("group by") &&
    q.includes("level")
  ) {
    const latestByPage = getLatestByPage();
    const counts: Record<string, number> = {};
    for (const r of latestByPage.values()) {
      counts[r.level] = (counts[r.level] || 0) + 1;
    }
    return Object.entries(counts)
      .map(([level, count]) => ({ level, count }))
      .sort((a, b) => b.count - a.count);
  }

  // ---- Latest: DISTINCT ON per page (raw SQL tagged template) ----
  // Matches: SELECT page_id, score, level, ... FROM (SELECT DISTINCT ON (page_id) ...
  if (
    q.includes("distinct on") &&
    q.includes("order by") &&
    q.includes("score") &&
    !q.includes("group by")
  ) {
    const latestByPage = getLatestByPage();
    let results = [...latestByPage.values()];

    // Check for level filter
    const levelParam = params.find(
      (p) => p === "high" || p === "medium" || p === "low"
    );
    if (levelParam) {
      results = results.filter((r) => r.level === levelParam);
    }

    results.sort((a, b) => b.score - a.score);

    // Extract limit/offset from params (numbers)
    const numParams = params.filter((p) => typeof p === "number") as number[];
    const limit = numParams[0] || 50;
    const offset = numParams[1] || 0;
    return results.slice(offset, offset + limit);
  }

  // ---- SELECT ... WHERE page_id_int = $1 ORDER BY computed_at DESC LIMIT (Phase 4b) ----
  if (
    q.includes("hallucination_risk_snapshots") &&
    q.includes("where") &&
    q.includes("page_id_int") &&
    !q.includes("distinct on") &&
    !q.includes("not in")
  ) {
    const intId = params[0] as number;
    const limit = (params[1] as number) || 50;
    return riskStore
      .filter((e) => e.page_id_int === intId)
      .sort((a, b) => b.computed_at.getTime() - a.computed_at.getTime())
      .slice(0, limit);
  }

  // ---- Cleanup dry-run: count rows that would be deleted ----
  if (
    q.includes("count(*)") &&
    q.includes("not in") &&
    q.includes("row_number")
  ) {
    const keep = params[0] as number;
    // Group by page_id, count rows beyond the keep threshold
    const byPage = new Map<string, typeof riskStore>();
    for (const r of riskStore) {
      const arr = byPage.get(r.page_id) || [];
      arr.push(r);
      byPage.set(r.page_id, arr);
    }
    let wouldDelete = 0;
    for (const rows of byPage.values()) {
      rows.sort(
        (a, b) => b.computed_at.getTime() - a.computed_at.getTime()
      );
      if (rows.length > keep) {
        wouldDelete += rows.length - keep;
      }
    }
    return [{ count: wouldDelete }];
  }

  // ---- Cleanup actual delete ----
  if (
    q.includes("delete") &&
    q.includes("hallucination_risk_snapshots") &&
    q.includes("not in") &&
    q.includes("row_number")
  ) {
    const keep = params[0] as number;
    const byPage = new Map<string, typeof riskStore>();
    for (const r of riskStore) {
      const arr = byPage.get(r.page_id) || [];
      arr.push(r);
      byPage.set(r.page_id, arr);
    }
    const toDelete = new Set<number>();
    for (const rows of byPage.values()) {
      rows.sort(
        (a, b) => b.computed_at.getTime() - a.computed_at.getTime()
      );
      for (let i = keep; i < rows.length; i++) {
        toDelete.add(rows[i].id);
      }
    }
    const deletedCount = toDelete.size;
    riskStore = riskStore.filter((r) => !toDelete.has(r.id));
    // Tagged template handler sets result.count = rows.length,
    // so return an array with length equal to deleted count
    return new Array(deletedCount).fill({});
  }

  return [];
}

// Mock the db module before importing routes
vi.mock("../db.js", () => mockDbModule(dispatch));

const { createApp } = await import("../app.js");
const { clearMatViewCache } = await import(
  "../routes/hallucination-risk.js"
);

// ---- Tests ----

describe("Hallucination Risk API", () => {
  let app: Hono;

  beforeEach(() => {
    resetStore();
    clearMatViewCache();
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    app = createApp();
  });

  describe("POST /api/hallucination-risk", () => {
    it("records a single snapshot and returns 201", async () => {
      const res = await postJson(app, "/api/hallucination-risk", {
        pageId: "open-philanthropy",
        score: 55,
        level: "medium",
        factors: ["biographical-claims", "low-citation-density"],
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe(1);
      expect(body.pageId).toBe("open-philanthropy");
      expect(body.score).toBe(55);
      expect(body.level).toBe("medium");
    });

    it("rejects invalid level", async () => {
      const res = await postJson(app, "/api/hallucination-risk", {
        pageId: "test",
        score: 50,
        level: "critical",
        factors: [],
      });
      expect(res.status).toBe(400);
    });

    it("rejects score out of range", async () => {
      const res = await postJson(app, "/api/hallucination-risk", {
        pageId: "test",
        score: 150,
        level: "high",
      });
      expect(res.status).toBe(400);
    });

    it("accepts entries without optional fields", async () => {
      const res = await postJson(app, "/api/hallucination-risk", {
        pageId: "test-page",
        score: 30,
        level: "low",
      });
      expect(res.status).toBe(201);
    });
  });

  describe("POST /api/hallucination-risk/batch", () => {
    it("inserts multiple snapshots", async () => {
      const res = await postJson(app, "/api/hallucination-risk/batch", {
        snapshots: [
          {
            pageId: "page-a",
            score: 70,
            level: "high",
            factors: ["no-citations"],
          },
          {
            pageId: "page-b",
            score: 25,
            level: "low",
            factors: ["well-cited"],
          },
        ],
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.inserted).toBe(2);
    });

    it("rejects empty batch", async () => {
      const res = await postJson(app, "/api/hallucination-risk/batch", {
        snapshots: [],
      });
      expect(res.status).toBe(400);
    });

    it("auto-refreshes materialized view when it exists", async () => {
      simulateMatView = true;
      const res = await postJson(app, "/api/hallucination-risk/batch", {
        snapshots: [
          { pageId: "page-a", score: 70, level: "high" },
        ],
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.inserted).toBe(1);
    });
  });

  describe("POST /api/hallucination-risk/refresh", () => {
    it("returns refreshed:false when matview does not exist", async () => {
      simulateMatView = false;
      const res = await app.request("/api/hallucination-risk/refresh", {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.refreshed).toBe(false);
    });

    it("returns refreshed:true when matview exists", async () => {
      simulateMatView = true;
      const res = await app.request("/api/hallucination-risk/refresh", {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.refreshed).toBe(true);
    });
  });

  describe("GET /api/hallucination-risk/history?page_id=X", () => {
    it("returns history for a page", async () => {
      for (const entry of [
        {
          pageId: "my-page",
          score: 60,
          level: "medium",
          factors: ["no-citations"],
        },
        {
          pageId: "my-page",
          score: 45,
          level: "medium",
          factors: ["low-citation-density"],
        },
        { pageId: "other-page", score: 20, level: "low" },
      ]) {
        await postJson(app, "/api/hallucination-risk", entry);
      }

      const res = await app.request(
        "/api/hallucination-risk/history?page_id=my-page"
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pageId).toBe("my-page");
      expect(body.snapshots).toHaveLength(2);
    });

    it("returns empty for unknown page", async () => {
      const res = await app.request(
        "/api/hallucination-risk/history?page_id=nonexistent"
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.snapshots).toHaveLength(0);
    });

    it("returns 400 without page_id", async () => {
      const res = await app.request("/api/hallucination-risk/history");
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/hallucination-risk/stats", () => {
    it("returns aggregate statistics (fallback path)", async () => {
      simulateMatView = false;
      for (const entry of [
        { pageId: "page-a", score: 70, level: "high" },
        { pageId: "page-b", score: 25, level: "low" },
        { pageId: "page-c", score: 45, level: "medium" },
      ]) {
        await postJson(app, "/api/hallucination-risk", entry);
      }

      const res = await app.request("/api/hallucination-risk/stats");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.totalSnapshots).toBe(3);
      expect(body.uniquePages).toBe(3);
    });

    it("returns aggregate statistics (matview path)", async () => {
      simulateMatView = true;
      for (const entry of [
        { pageId: "page-a", score: 70, level: "high" },
        { pageId: "page-b", score: 25, level: "low" },
        { pageId: "page-c", score: 45, level: "medium" },
      ]) {
        await postJson(app, "/api/hallucination-risk", entry);
      }

      const res = await app.request("/api/hallucination-risk/stats");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.totalSnapshots).toBe(3);
      expect(body.uniquePages).toBe(3);
    });

    it("returns zeros when no snapshots exist", async () => {
      const res = await app.request("/api/hallucination-risk/stats");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.totalSnapshots).toBe(0);
      expect(body.uniquePages).toBe(0);
    });
  });

  describe("GET /api/hallucination-risk/latest", () => {
    it("returns 200 with pages array (fallback path)", async () => {
      simulateMatView = false;
      for (const entry of [
        {
          pageId: "page-a",
          score: 70,
          level: "high",
          factors: ["no-citations"],
        },
        {
          pageId: "page-b",
          score: 25,
          level: "low",
          factors: ["well-cited"],
        },
      ]) {
        await postJson(app, "/api/hallucination-risk", entry);
      }

      const res = await app.request("/api/hallucination-risk/latest");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pages).toBeDefined();
      expect(Array.isArray(body.pages)).toBe(true);
    });

    it("returns 200 with pages array (matview path)", async () => {
      simulateMatView = true;
      for (const entry of [
        {
          pageId: "page-a",
          score: 70,
          level: "high",
          factors: ["no-citations"],
        },
        {
          pageId: "page-b",
          score: 25,
          level: "low",
          factors: ["well-cited"],
        },
      ]) {
        await postJson(app, "/api/hallucination-risk", entry);
      }

      const res = await app.request("/api/hallucination-risk/latest");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pages).toBeDefined();
      expect(Array.isArray(body.pages)).toBe(true);
      expect(body.pages).toHaveLength(2);
    });
  });

  describe("DELETE /api/hallucination-risk/cleanup", () => {
    it("dry run reports what would be deleted", async () => {
      // Insert 5 snapshots for page-a (should keep latest 2)
      for (let i = 0; i < 5; i++) {
        await postJson(app, "/api/hallucination-risk", {
          pageId: "page-a",
          score: 50 + i,
          level: "medium",
        });
      }

      const res = await app.request(
        "/api/hallucination-risk/cleanup?keep=2&dry_run=true",
        { method: "DELETE" }
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.dryRun).toBe(true);
      expect(body.keep).toBe(2);
      expect(body.totalSnapshots).toBe(5);
      expect(body.wouldDelete).toBe(3);
      expect(body.wouldRetain).toBe(2);
    });

    it("actually deletes old snapshots", async () => {
      // Insert 4 snapshots for page-a
      for (let i = 0; i < 4; i++) {
        await postJson(app, "/api/hallucination-risk", {
          pageId: "page-a",
          score: 50 + i,
          level: "medium",
        });
      }
      // Insert 2 for page-b
      for (let i = 0; i < 2; i++) {
        await postJson(app, "/api/hallucination-risk", {
          pageId: "page-b",
          score: 30 + i,
          level: "low",
        });
      }

      const res = await app.request(
        "/api/hallucination-risk/cleanup?keep=2",
        { method: "DELETE" }
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      // page-a: 4 snapshots, keep 2 → delete 2
      // page-b: 2 snapshots, keep 2 → delete 0
      expect(body.deleted).toBe(2);
      expect(body.keep).toBe(2);
      expect(riskStore).toHaveLength(4); // 2 + 2 remaining
    });

    it("defaults to keeping 30 snapshots per page", async () => {
      const res = await app.request(
        "/api/hallucination-risk/cleanup?dry_run=true",
        { method: "DELETE" }
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.keep).toBe(30);
    });
  });

  describe("matViewExists() caching", () => {
    it("caches pg_matviews result across multiple requests", async () => {
      simulateMatView = true;

      // First request — should query pg_matviews
      await app.request("/api/hallucination-risk/stats");
      const firstCount = pgMatviewsQueryCount;
      expect(firstCount).toBe(1);

      // Second request — should use cached result, no new pg_matviews query
      await app.request("/api/hallucination-risk/stats");
      expect(pgMatviewsQueryCount).toBe(1); // unchanged — cache hit

      // Third request to a different endpoint — still uses cache
      await app.request("/api/hallucination-risk/latest");
      expect(pgMatviewsQueryCount).toBe(1); // still unchanged
    });

    it("re-queries pg_matviews after cache is cleared", async () => {
      simulateMatView = false;

      // First request — queries pg_matviews, caches false
      await app.request("/api/hallucination-risk/stats");
      expect(pgMatviewsQueryCount).toBe(1);

      // Clear cache, change simulated state
      clearMatViewCache();
      simulateMatView = true;

      // Next request — should re-query pg_matviews since cache was cleared
      await app.request("/api/hallucination-risk/stats");
      expect(pgMatviewsQueryCount).toBe(2);
    });

    it("re-queries pg_matviews after TTL expires", async () => {
      simulateMatView = true;

      // First request — populates cache
      await app.request("/api/hallucination-risk/stats");
      expect(pgMatviewsQueryCount).toBe(1);

      // Advance time past TTL (5 minutes = 300000ms)
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 300_001);

      // Next request — TTL expired, should re-query
      await app.request("/api/hallucination-risk/stats");
      expect(pgMatviewsQueryCount).toBe(2);

      vi.useRealTimers();
    });
  });
});
