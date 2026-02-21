import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  type SqlDispatcher,
  mockDbModule,
  createQueryResult,
  postJson,
} from "./test-utils";

// ---- In-memory stores simulating the tables ----

let nextRunId = 1;
let nextResultId = 1;
let runStore: Array<{
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
}>;
let resultStore: Array<{
  id: number;
  run_id: number;
  page_id: string;
  status: string;
  tier: string | null;
  duration_ms: number | null;
  error_message: string | null;
}>;

function resetStores() {
  runStore = [];
  resultStore = [];
  nextRunId = 1;
  nextResultId = 1;
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

  // ---- INSERT INTO auto_update_runs ----
  if (q.includes("insert into") && q.includes("auto_update_runs")) {
    const row = {
      id: nextRunId++,
      date: String(params[0]),
      started_at: new Date(params[1] as string),
      completed_at: params[2] ? new Date(params[2] as string) : null,
      trigger: params[3] as string,
      budget_limit: params[4] as number | null,
      budget_spent: params[5] as number | null,
      sources_checked: params[6] as number | null,
      sources_failed: params[7] as number | null,
      items_fetched: params[8] as number | null,
      items_relevant: params[9] as number | null,
      pages_planned: params[10] as number | null,
      pages_updated: params[11] as number | null,
      pages_failed: params[12] as number | null,
      pages_skipped: params[13] as number | null,
      new_pages_created: params[14] as string | null,
      details_json: null,
      created_at: new Date(),
    };
    runStore.push(row);
    return [row];
  }

  // ---- INSERT INTO auto_update_results ----
  if (q.includes("insert into") && q.includes("auto_update_results")) {
    const row = {
      id: nextResultId++,
      run_id: params[0] as number,
      page_id: params[1] as string,
      status: params[2] as string,
      tier: params[3] as string | null,
      duration_ms: params[4] as number | null,
      error_message: params[5] as string | null,
    };
    resultStore.push(row);
    return [row];
  }

  // ---- SELECT ... FROM auto_update_results WHERE run_id = $1 ----
  if (
    q.includes("auto_update_results") &&
    q.includes("where") &&
    q.includes("run_id")
  ) {
    const runId = params[0] as number;
    return resultStore.filter((r) => r.run_id === runId);
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
      return [{ total: runStore.reduce((s, r) => s + (r.budget_spent ?? 0), 0) }];
    }
    if (q.includes("pages_updated")) {
      return [{ total: runStore.reduce((s, r) => s + (r.pages_updated ?? 0), 0) }];
    }
    if (q.includes("pages_failed")) {
      return [{ total: runStore.reduce((s, r) => s + (r.pages_failed ?? 0), 0) }];
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

  // ---- SELECT ... WHERE id = $1 (single run) ----
  if (
    q.includes("auto_update_runs") &&
    q.includes("where") &&
    q.includes('"id"')
  ) {
    const id = params[0] as number;
    return runStore.filter((r) => r.id === id);
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
      (a, b) => b.started_at.getTime() - a.started_at.getTime()
    );
    return sorted.slice(offset, offset + limit);
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
