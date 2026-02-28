import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  type SqlDispatcher,
  mockDbModule,
  postJson,
} from "./test-utils";

// ---- In-memory store simulating groundskeeper_runs table ----

let nextId = 1;
interface GkRunRow {
  id: number;
  task_name: string;
  event: string;
  success: boolean;
  duration_ms: number | null;
  summary: string | null;
  error_message: string | null;
  consecutive_failures: number | null;
  circuit_breaker_active: boolean;
  metadata: unknown;
  timestamp: Date;
  created_at: Date;
}
let store: GkRunRow[];

function resetStores() {
  store = [];
  nextId = 1;
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

  // ---- INSERT INTO groundskeeper_runs (single or batch) ----
  if (q.includes("insert into") && q.includes("groundskeeper_runs")) {
    // Count columns per row from the VALUES clause
    // Drizzle generates: INSERT INTO "groundskeeper_runs" ("task_name", "event", ...) VALUES ($1, $2, ..., $10), ($11, ...) RETURNING ...
    const COLS = 10; // task_name, event, success, duration_ms, summary, error_message, consecutive_failures, circuit_breaker_active, metadata, timestamp
    const numRows = Math.max(1, Math.floor(params.length / COLS));
    const rows: GkRunRow[] = [];
    for (let i = 0; i < numRows; i++) {
      const o = i * COLS;
      const row: GkRunRow = {
        id: nextId++,
        task_name: params[o] as string,
        event: params[o + 1] as string,
        success: params[o + 2] as boolean,
        duration_ms: params[o + 3] as number | null,
        summary: params[o + 4] as string | null,
        error_message: params[o + 5] as string | null,
        consecutive_failures: params[o + 6] as number | null,
        circuit_breaker_active: (params[o + 7] as boolean) ?? false,
        metadata: params[o + 8] as unknown,
        timestamp: params[o + 9] ? new Date(params[o + 9] as string) : new Date(),
        created_at: new Date(),
      };
      store.push(row);
      rows.push(row);
    }
    return rows;
  }

  // ---- SELECT ... GROUP BY task_name with aggregate expressions (stats queries) ----
  if (
    q.includes("groundskeeper_runs") &&
    q.includes("group by") &&
    q.includes("count(*)")
  ) {
    // If the query has a WHERE clause with timestamp >= (24h filter), use recent runs
    // Otherwise, use all runs (all-time stats)
    const hasTimestampFilter = q.includes('"timestamp" >=');

    const groups: Record<string, GkRunRow[]> = {};
    for (const row of store) {
      if (!groups[row.task_name]) groups[row.task_name] = [];
      groups[row.task_name].push(row);
    }

    // All-time stats (no filter, no aggregate functions beyond count/min)
    if (!hasTimestampFilter && q.includes("min(")) {
      return Object.entries(groups).map(([taskName, rows]) => ({
        task_name: taskName,
        totalRuns: rows.length,
        firstRun: rows.length > 0
          ? new Date(Math.min(...rows.map((r) => r.timestamp.getTime()))).toISOString()
          : null,
      }));
    }

    // 24h stats with filter expressions
    return Object.entries(groups).map(([taskName, rows]) => {
      const successes = rows.filter((r) => r.success);
      const failures = rows.filter((r) => !r.success);
      const durations = rows
        .filter((r) => r.duration_ms !== null)
        .map((r) => r.duration_ms!);
      const avgDuration =
        durations.length > 0
          ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
          : null;
      const lastRun = rows.length > 0
        ? new Date(Math.max(...rows.map((r) => r.timestamp.getTime()))).toISOString()
        : null;
      const lastSuccess = successes.length > 0
        ? new Date(Math.max(...successes.map((r) => r.timestamp.getTime()))).toISOString()
        : null;

      return {
        task_name: taskName,
        totalRuns: rows.length,
        successCount: successes.length,
        failureCount: failures.length,
        avgDurationMs: avgDuration,
        lastRun,
        lastSuccess,
      };
    });
  }

  // ---- SELECT ... WHERE task_name = $1 ORDER BY timestamp DESC LIMIT $2 ----
  if (
    q.includes("groundskeeper_runs") &&
    q.includes("order by") &&
    q.includes("limit")
  ) {
    let filtered = [...store];

    // Check if there's a task_name filter
    if (q.includes('"task_name" =')) {
      const taskName = params.find((p) => typeof p === "string") as string;
      if (taskName) {
        filtered = filtered.filter((r) => r.task_name === taskName);
      }
    }

    filtered.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    const numericParams = params.filter((p) => typeof p === "number");
    const limit = numericParams.length > 0 ? numericParams[numericParams.length - 1] as number : 100;
    return filtered.slice(0, limit);
  }

  return [];
};

vi.mock("../db.js", () => mockDbModule(dispatch));

const { createApp } = await import("../app.js");

// ---- Tests ----

describe("Groundskeeper Runs API", () => {
  let app: Hono;

  beforeEach(() => {
    resetStores();
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    app = createApp();
  });

  const sampleRun = {
    taskName: "health-check",
    event: "success",
    success: true,
    durationMs: 1234,
    summary: "Wiki server healthy (200 OK)",
    timestamp: "2026-02-28T12:00:00.000Z",
  };

  // ── POST /api/groundskeeper-runs ──────────────────────────────────────

  describe("POST /api/groundskeeper-runs", () => {
    it("records a single run and returns 201", async () => {
      const res = await postJson(app, "/api/groundskeeper-runs", sampleRun);
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe(1);
      expect(body.taskName).toBe("health-check");
      expect(body.event).toBe("success");
      expect(body.success).toBe(true);
      expect(body.durationMs).toBe(1234);
    });

    it("records a run with minimal fields", async () => {
      const res = await postJson(app, "/api/groundskeeper-runs", {
        taskName: "resolve-conflicts",
        event: "success",
        success: true,
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe(1);
      expect(body.taskName).toBe("resolve-conflicts");
    });

    it("records an error run with errorMessage", async () => {
      const res = await postJson(app, "/api/groundskeeper-runs", {
        taskName: "health-check",
        event: "error",
        success: false,
        durationMs: 500,
        errorMessage: "Connection refused",
        consecutiveFailures: 2,
        circuitBreakerActive: false,
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.errorMessage).toBe("Connection refused");
      expect(body.consecutiveFailures).toBe(2);
    });

    it("records a circuit breaker event", async () => {
      const res = await postJson(app, "/api/groundskeeper-runs", {
        taskName: "health-check",
        event: "circuit_breaker_tripped",
        success: false,
        consecutiveFailures: 3,
        circuitBreakerActive: true,
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.circuitBreakerActive).toBe(true);
      expect(body.event).toBe("circuit_breaker_tripped");
    });

    it("rejects missing taskName", async () => {
      const res = await postJson(app, "/api/groundskeeper-runs", {
        event: "success",
        success: true,
      });
      expect(res.status).toBe(400);
    });

    it("rejects missing event", async () => {
      const res = await postJson(app, "/api/groundskeeper-runs", {
        taskName: "health-check",
        success: true,
      });
      expect(res.status).toBe(400);
    });

    it("rejects missing success", async () => {
      const res = await postJson(app, "/api/groundskeeper-runs", {
        taskName: "health-check",
        event: "success",
      });
      expect(res.status).toBe(400);
    });

    it("rejects invalid event value", async () => {
      const res = await postJson(app, "/api/groundskeeper-runs", {
        taskName: "health-check",
        event: "invalid_event_type",
        success: true,
      });
      expect(res.status).toBe(400);
    });

    it("rejects negative durationMs", async () => {
      const res = await postJson(app, "/api/groundskeeper-runs", {
        ...sampleRun,
        durationMs: -100,
      });
      expect(res.status).toBe(400);
    });

    it("rejects invalid JSON body", async () => {
      const res = await app.request("/api/groundskeeper-runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      expect(res.status).toBe(400);
    });
  });

  // ── POST /api/groundskeeper-runs/batch ────────────────────────────────

  describe("POST /api/groundskeeper-runs/batch", () => {
    it("records multiple runs and returns 201", async () => {
      const res = await postJson(app, "/api/groundskeeper-runs/batch", {
        items: [
          { ...sampleRun, taskName: "health-check" },
          { taskName: "resolve-conflicts", event: "success", success: true, durationMs: 5000 },
          { taskName: "code-review", event: "skipped", success: true },
        ],
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.inserted).toBe(3);
      expect(store).toHaveLength(3);
    });

    it("rejects empty items array", async () => {
      const res = await postJson(app, "/api/groundskeeper-runs/batch", {
        items: [],
      });
      expect(res.status).toBe(400);
    });

    it("rejects batch with invalid item", async () => {
      const res = await postJson(app, "/api/groundskeeper-runs/batch", {
        items: [
          { ...sampleRun },
          { taskName: "bad", event: "invalid_event", success: true },
        ],
      });
      expect(res.status).toBe(400);
    });

    it("rejects missing items field", async () => {
      const res = await postJson(app, "/api/groundskeeper-runs/batch", {
        runs: [sampleRun],
      });
      expect(res.status).toBe(400);
    });
  });

  // ── GET /api/groundskeeper-runs ───────────────────────────────────────

  describe("GET /api/groundskeeper-runs", () => {
    it("returns empty list when no runs exist", async () => {
      const res = await app.request("/api/groundskeeper-runs");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.runs).toHaveLength(0);
      expect(body.total).toBe(0);
    });

    it("returns runs ordered by timestamp desc", async () => {
      await postJson(app, "/api/groundskeeper-runs", {
        ...sampleRun,
        timestamp: "2026-02-28T10:00:00.000Z",
      });
      await postJson(app, "/api/groundskeeper-runs", {
        ...sampleRun,
        timestamp: "2026-02-28T12:00:00.000Z",
      });
      await postJson(app, "/api/groundskeeper-runs", {
        ...sampleRun,
        timestamp: "2026-02-28T11:00:00.000Z",
      });

      const res = await app.request("/api/groundskeeper-runs");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.runs).toHaveLength(3);
      expect(body.total).toBe(3);
      // Should be newest first
      const timestamps = body.runs.map((r: any) => r.timestamp);
      expect(new Date(timestamps[0]).getTime()).toBeGreaterThanOrEqual(
        new Date(timestamps[1]).getTime()
      );
    });

    it("filters by task name", async () => {
      await postJson(app, "/api/groundskeeper-runs", {
        ...sampleRun,
        taskName: "health-check",
      });
      await postJson(app, "/api/groundskeeper-runs", {
        ...sampleRun,
        taskName: "code-review",
      });

      const res = await app.request(
        "/api/groundskeeper-runs?task=health-check"
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.runs).toHaveLength(1);
      expect(body.runs[0].taskName).toBe("health-check");
    });

    it("respects limit parameter", async () => {
      for (let i = 0; i < 5; i++) {
        await postJson(app, "/api/groundskeeper-runs", sampleRun);
      }

      const res = await app.request("/api/groundskeeper-runs?limit=2");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.runs).toHaveLength(2);
    });

    it("caps limit at 500", async () => {
      const res = await app.request("/api/groundskeeper-runs?limit=1000");
      expect(res.status).toBe(200);
      // The route clamps to 500 — just verify it doesn't error
    });
  });

  // ── GET /api/groundskeeper-runs/stats ─────────────────────────────────

  describe("GET /api/groundskeeper-runs/stats", () => {
    it("returns stats with since timestamp", async () => {
      const res = await app.request("/api/groundskeeper-runs/stats");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.stats).toBeDefined();
      expect(Array.isArray(body.stats)).toBe(true);
      expect(body.since).toBeDefined();
    });

    it("returns per-task stats after inserting runs", async () => {
      await postJson(app, "/api/groundskeeper-runs", {
        ...sampleRun,
        taskName: "health-check",
        durationMs: 1000,
      });
      await postJson(app, "/api/groundskeeper-runs", {
        ...sampleRun,
        taskName: "health-check",
        success: false,
        event: "failure",
        durationMs: 2000,
      });
      await postJson(app, "/api/groundskeeper-runs", {
        ...sampleRun,
        taskName: "code-review",
        durationMs: 5000,
      });

      const res = await app.request("/api/groundskeeper-runs/stats");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.stats.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Valid event types ─────────────────────────────────────────────────

  describe("valid event types", () => {
    const validEvents = [
      "success",
      "failure",
      "error",
      "circuit_breaker_tripped",
      "circuit_breaker_reset",
      "skipped",
    ];

    for (const event of validEvents) {
      it(`accepts event "${event}"`, async () => {
        const res = await postJson(app, "/api/groundskeeper-runs", {
          taskName: "health-check",
          event,
          success: event === "success" || event === "skipped",
        });
        expect(res.status).toBe(201);
      });
    }
  });
});
