import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  type SqlDispatcher,
  mockDbModule,
  createQueryResult,
  postJson,
} from "./test-utils";
import type { autoUpdateRuns, autoUpdateResults } from "../schema.js";

// ---- In-memory stores simulating the tables ----
// Store types are derived from the Drizzle schema so TypeScript catches column renames.

let nextSlugIntId = 1000;
const slugIntIdMap = new Map<string, number>();

function getIntIdForSlug(slug: string): number {
  if (!slugIntIdMap.has(slug)) {
    slugIntIdMap.set(slug, nextSlugIntId++);
  }
  return slugIntIdMap.get(slug)!;
}

function slugFromIntId(intId: number | null): string | null {
  if (intId === null) return null;
  for (const [slug, id] of slugIntIdMap.entries()) {
    if (id === intId) return slug;
  }
  return null;
}

let nextRunId = 1;
let nextResultId = 1;
// Types derived from Drizzle schema — TypeScript will catch column renames.
// pageSlug is a synthetic convenience field (not a real DB column).
type RunRow = typeof autoUpdateRuns.$inferSelect;
type ResultRow = typeof autoUpdateResults.$inferSelect & { pageSlug: string | null };
let runStore: Array<RunRow>;
let resultStore: Array<ResultRow>;

function resetStores() {
  runStore = [];
  resultStore = [];
  nextRunId = 1;
  nextResultId = 1;
  nextSlugIntId = 1000;
  slugIntIdMap.clear();
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

/** Convert a ResultRow (camelCase) to a raw SQL row (snake_case). */
function resultToSqlRow(r: ResultRow): Record<string, unknown> {
  return {
    id: r.id,
    run_id: r.runId,
    page_id_old: r.pageId,
    page_id_int: r.pageIdInt,
    status: r.status,
    tier: r.tier,
    duration_ms: r.durationMs,
    error_message: r.errorMessage,
  };
}

const dispatch: SqlDispatcher = (query, params) => {
  const q = query.toLowerCase();

  // ---- entity_ids (for health check) ----
  if (q.includes("count(*)") && q.includes("entity_ids")) {
    return [{ count: 0 }];
  }
  if (q.includes("last_value")) {
    return [{ last_value: 0, is_called: false }];
  }

  // ---- entity_ids: SELECT WHERE slug (for resolvePageIntIds) ----
  if (q.includes("entity_ids") && q.includes("where") && q.includes("slug")) {
    return params.map((p) => ({ numeric_id: getIntIdForSlug(String(p)), slug: p }));
  }

  // ---- TRUNCATE ----
  if (q.includes("truncate")) {
    if (q.includes("auto_update_results")) {
      resultStore = [];
      nextResultId = 1;
    }
    if (q.includes("auto_update_runs")) {
      runStore = [];
      nextRunId = 1;
    }
    return [];
  }

  // ---- INSERT INTO auto_update_runs (with ON CONFLICT DO NOTHING simulation) ----
  if (q.includes("insert into") && q.includes("auto_update_runs")) {
    const startedAt = new Date(params[1] as string);
    // Simulate ON CONFLICT (started_at) DO NOTHING
    if (q.includes("on conflict") && runStore.some((r) => r.startedAt.getTime() === startedAt.getTime())) {
      return [];
    }
    const row: RunRow = {
      id: nextRunId++,
      date: String(params[0]),
      startedAt: startedAt,
      completedAt: params[2] ? new Date(params[2] as string) : null,
      trigger: params[3] as string,
      budgetLimit: params[4] as number | null,
      budgetSpent: params[5] as number | null,
      sourcesChecked: params[6] as number | null,
      sourcesFailed: params[7] as number | null,
      itemsFetched: params[8] as number | null,
      itemsRelevant: params[9] as number | null,
      pagesPlanned: params[10] as number | null,
      pagesUpdated: params[11] as number | null,
      pagesFailed: params[12] as number | null,
      pagesSkipped: params[13] as number | null,
      newPagesCreated: params[14] as string | null,
      detailsJson: null,
      createdAt: new Date(),
    };
    runStore.push(row);
    return [runToSqlRow(row)];
  }

  // ---- INSERT INTO auto_update_results (supports multi-row) ----
  if (q.includes("insert into") && q.includes("auto_update_results")) {
    // Phase D2a: removed page_id_old — params: run_id, page_id_int, status, tier, duration_ms, error_message
    const COLS = 6;
    const numRows = params.length / COLS;
    const rows: ResultRow[] = [];
    for (let i = 0; i < numRows; i++) {
      const o = i * COLS;
      const pageIdInt = params[o + 1] as number | null;
      const pageSlug = slugFromIntId(pageIdInt);
      const row: ResultRow = {
        id: nextResultId++,
        runId: params[o] as number,
        pageId: null, // D2a: not written on insert (maps to page_id_old column)
        pageIdInt: pageIdInt,
        pageSlug: pageSlug,
        status: params[o + 2] as string,
        tier: params[o + 3] as string | null,
        durationMs: params[o + 4] as number | null,
        errorMessage: params[o + 5] as string | null,
      };
      resultStore.push(row);
      rows.push(row);
    }
    return rows.map(resultToSqlRow);
  }

  // ---- SELECT ... FROM auto_update_results WHERE run_id IN (...) ----
  // Phase D2a: query uses COALESCE + LEFT JOIN wiki_pages. extractColumns finds
  // "id" for the COALESCE expression, so we remap "id" to the page slug.
  if (
    q.includes("auto_update_results") &&
    q.includes("where") &&
    q.includes("run_id")
  ) {
    const runIds = params.map(Number);
    return resultStore
      .filter((r) => runIds.includes(r.runId))
      .map((r) => ({
        run_id: r.runId,
        // "id" is what extractColumns finds for coalesce(..., "wiki_pages"."id")
        // D2a COALESCE: page_id_old ?? wiki_pages.id (via int lookup)
        id: r.pageId ?? slugFromIntId(r.pageIdInt) ?? null,
        status: r.status,
        tier: r.tier,
        duration_ms: r.durationMs,
        error_message: r.errorMessage,
      }));
  }

  // ---- SELECT count(*) FROM auto_update_runs (not GROUP BY) ----
  if (
    q.includes("count(*)") &&
    q.includes("auto_update_runs") &&
    !q.includes("group by")
  ) {
    return [{ count: runStore.length }];
  }

  // ---- SUM queries on auto_update_runs ----
  if (q.includes("coalesce(sum(") && q.includes("auto_update_runs")) {
    if (q.includes("budget_spent")) {
      return [{ total: runStore.reduce((s, r) => s + (r.budgetSpent ?? 0), 0) }];
    }
    if (q.includes("pages_updated")) {
      return [{ total: runStore.reduce((s, r) => s + (r.pagesUpdated ?? 0), 0) }];
    }
    if (q.includes("pages_failed")) {
      return [{ total: runStore.reduce((s, r) => s + (r.pagesFailed ?? 0), 0) }];
    }
    return [{ total: 0 }];
  }

  // ---- GROUP BY trigger ----
  if (
    q.includes("auto_update_runs") &&
    q.includes("group by") &&
    q.includes('"trigger"')
  ) {
    const counts: Record<string, number> = {};
    for (const r of runStore) {
      counts[r.trigger] = (counts[r.trigger] || 0) + 1;
    }
    return Object.entries(counts).map(([trigger, count]) => ({
      trigger,
      count,
    }));
  }

  // ---- SELECT ... WHERE started_at = $1 (conflict fallback lookup) ----
  // Use '"started_at" =' to match only the WHERE clause, not the SELECT column list
  if (
    q.includes("auto_update_runs") &&
    q.includes('"started_at" =')
  ) {
    const startedAt = new Date(params[0] as string);
    return runStore
      .filter((r) => r.startedAt.getTime() === startedAt.getTime())
      .map(runToSqlRow);
  }

  // ---- SELECT ... WHERE id = $1 (single run) ----
  if (
    q.includes("auto_update_runs") &&
    q.includes("where") &&
    q.includes('"id"')
  ) {
    const id = params[0] as number;
    return runStore.filter((r) => r.id === id).map(runToSqlRow);
  }

  // ---- SELECT ... ORDER BY ... LIMIT ... (paginated runs) ----
  if (
    q.includes("auto_update_runs") &&
    q.includes("order by") &&
    q.includes("limit")
  ) {
    const limit = (params[0] as number) || 50;
    const offset = (params[1] as number) || 0;
    const sorted = [...runStore].sort(
      (a, b) => b.startedAt.getTime() - a.startedAt.getTime()
    );
    return sorted.slice(offset, offset + limit).map(runToSqlRow);
  }

  return [];
};

vi.mock("../db.js", () => mockDbModule(dispatch));

const { createApp } = await import("../app.js");

// ---- Tests ----

describe("Auto-Update Runs API", () => {
  let app: Hono;

  beforeEach(() => {
    resetStores();
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    app = createApp();
  });

  const sampleRun = {
    date: "2026-02-19",
    startedAt: "2026-02-19T06:56:17.789Z",
    completedAt: "2026-02-19T08:12:19.463Z",
    trigger: "scheduled" as const,
    budgetLimit: 30,
    budgetSpent: 28.5,
    sourcesChecked: 17,
    sourcesFailed: 3,
    itemsFetched: 1679,
    itemsRelevant: 1318,
    pagesPlanned: 5,
    pagesUpdated: 5,
    pagesFailed: 0,
    pagesSkipped: 0,
    newPagesCreated: [],
    results: [
      { pageId: "alignment", status: "success" as const, tier: "standard", durationMs: 1171112 },
      { pageId: "language-models", status: "success" as const, tier: "standard", durationMs: 417746 },
    ],
  };

  describe("POST /api/auto-update-runs", () => {
    it("records a run with results and returns 201", async () => {
      const res = await postJson(app, "/api/auto-update-runs", sampleRun);
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe(1);
      expect(body.resultsInserted).toBe(2);
    });

    it("records a run without results", async () => {
      const { results, ...runOnly } = sampleRun;
      const res = await postJson(app, "/api/auto-update-runs", runOnly);
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe(1);
      expect(body.resultsInserted).toBe(0);
    });

    it("is idempotent: duplicate startedAt returns existing run id", async () => {
      const res1 = await postJson(app, "/api/auto-update-runs", sampleRun);
      expect(res1.status).toBe(201);
      const body1 = await res1.json();
      expect(body1.id).toBe(1);
      expect(body1.resultsInserted).toBe(2);

      // Second call with same startedAt should return the existing run, not create a new one
      const res2 = await postJson(app, "/api/auto-update-runs", sampleRun);
      expect(res2.status).toBe(201);
      const body2 = await res2.json();
      expect(body2.id).toBe(1); // same id — not a new row
      expect(body2.resultsInserted).toBe(0); // no new results inserted

      // Only one run should exist in the store
      expect(runStore).toHaveLength(1);
    });

    it("rejects invalid trigger value", async () => {
      const res = await postJson(app, "/api/auto-update-runs", {
        ...sampleRun,
        trigger: "invalid",
      });
      expect(res.status).toBe(400);
    });

    it("rejects invalid date format", async () => {
      const res = await postJson(app, "/api/auto-update-runs", {
        ...sampleRun,
        date: "Feb 19, 2026",
      });
      expect(res.status).toBe(400);
    });

    it("rejects missing required fields", async () => {
      const res = await postJson(app, "/api/auto-update-runs", {
        date: "2026-02-19",
      });
      expect(res.status).toBe(400);
    });

    it("rejects invalid result status", async () => {
      const res = await postJson(app, "/api/auto-update-runs", {
        ...sampleRun,
        results: [{ pageId: "test", status: "invalid", tier: "standard" }],
      });
      expect(res.status).toBe(400);
    });
  });

  describe("newPagesCreated format handling", () => {
    it("stores newPagesCreated as JSON and parses it back", async () => {
      const res = await postJson(app, "/api/auto-update-runs", {
        ...sampleRun,
        newPagesCreated: ["new-page-1", "new-page-2"],
        results: [],
      });
      expect(res.status).toBe(201);

      // Verify stored as JSON string internally
      expect(runStore[0].newPagesCreated).toBe(
        '["new-page-1","new-page-2"]'
      );

      // Verify parsed back to array in GET response
      const getRes = await app.request("/api/auto-update-runs/1");
      const body = await getRes.json();
      expect(body.newPagesCreated).toEqual(["new-page-1", "new-page-2"]);
    });

    it("returns empty array when newPagesCreated is empty", async () => {
      const res = await postJson(app, "/api/auto-update-runs", {
        ...sampleRun,
        newPagesCreated: [],
        results: [],
      });
      expect(res.status).toBe(201);

      // Empty array should be stored as null in the DB
      expect(runStore[0].newPagesCreated).toBeNull();

      const getRes = await app.request("/api/auto-update-runs/1");
      const body = await getRes.json();
      expect(body.newPagesCreated).toEqual([]);
    });

    it("handles legacy comma-separated format gracefully", async () => {
      // Simulate legacy data by directly inserting a comma-separated string
      runStore.push({
        id: nextRunId++,
        date: "2026-02-19",
        startedAt: new Date("2026-02-19T06:00:00Z"),
        completedAt: new Date("2026-02-19T07:00:00Z"),
        trigger: "manual",
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
        newPagesCreated: "page-a,page-b,page-c",
        detailsJson: null,
        createdAt: new Date(),
      });

      const res = await app.request("/api/auto-update-runs/1");
      const body = await res.json();
      expect(body.newPagesCreated).toEqual(["page-a", "page-b", "page-c"]);
    });
  });

  describe("GET /api/auto-update-runs/all", () => {
    it("returns paginated runs", async () => {
      // Insert 3 runs
      for (let i = 0; i < 3; i++) {
        await postJson(app, "/api/auto-update-runs", {
          ...sampleRun,
          date: `2026-02-${String(17 + i).padStart(2, "0")}`,
          startedAt: `2026-02-${String(17 + i).padStart(2, "0")}T06:00:00.000Z`,
          completedAt: `2026-02-${String(17 + i).padStart(2, "0")}T07:00:00.000Z`,
          results: [],
        });
      }

      const res = await app.request(
        "/api/auto-update-runs/all?limit=2&offset=0"
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.entries).toHaveLength(2);
      expect(body.total).toBe(3);
      expect(body.limit).toBe(2);
      expect(body.offset).toBe(0);
    });

    it("returns empty array when no runs exist", async () => {
      const res = await app.request("/api/auto-update-runs/all");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.entries).toHaveLength(0);
      expect(body.total).toBe(0);
    });

    it("includes results in each run entry", async () => {
      await postJson(app, "/api/auto-update-runs", sampleRun);

      const res = await app.request("/api/auto-update-runs/all");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0].results).toHaveLength(2);
      expect(body.entries[0].results[0].pageId).toBe("alignment");
    });
  });

  describe("GET /api/auto-update-runs/stats", () => {
    it("returns aggregate statistics", async () => {
      await postJson(app, "/api/auto-update-runs", sampleRun);
      await postJson(app, "/api/auto-update-runs", {
        ...sampleRun,
        date: "2026-02-20",
        startedAt: "2026-02-20T06:00:00.000Z",
        completedAt: "2026-02-20T07:00:00.000Z",
        trigger: "manual",
        budgetSpent: 10,
        pagesUpdated: 2,
        pagesFailed: 1,
        results: [],
      });

      const res = await app.request("/api/auto-update-runs/stats");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.totalRuns).toBe(2);
      expect(body.totalBudgetSpent).toBe(38.5);
      expect(body.totalPagesUpdated).toBe(7);
      expect(body.totalPagesFailed).toBe(1);
      expect(body.byTrigger["scheduled"]).toBe(1);
      expect(body.byTrigger["manual"]).toBe(1);
    });

    it("returns zeros when no runs exist", async () => {
      const res = await app.request("/api/auto-update-runs/stats");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.totalRuns).toBe(0);
      expect(body.totalBudgetSpent).toBe(0);
      expect(body.totalPagesUpdated).toBe(0);
    });
  });

  describe("GET /api/auto-update-runs/:id", () => {
    it("returns a single run with results", async () => {
      await postJson(app, "/api/auto-update-runs", sampleRun);

      const res = await app.request("/api/auto-update-runs/1");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(1);
      expect(body.trigger).toBe("scheduled");
      expect(body.results).toHaveLength(2);
      expect(body.budgetSpent).toBe(28.5);
    });

    it("returns 404 for unknown run", async () => {
      const res = await app.request("/api/auto-update-runs/999");
      expect(res.status).toBe(404);
    });

    it("returns 400 for non-numeric id", async () => {
      const res = await app.request("/api/auto-update-runs/abc");
      expect(res.status).toBe(400);
    });
  });
});
