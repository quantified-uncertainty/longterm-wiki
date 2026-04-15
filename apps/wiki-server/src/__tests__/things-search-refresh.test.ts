// /status is not unit-tested here — the mock doesn't model
// pg_stat_all_tables column types.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { type SqlDispatcher, mockDbModule, postJson } from "./test-utils";

// ---- Mock state ----

let refreshCallCount = 0;
let analyzeCallCount = 0;
let refreshShouldError: string | null = null;
let analyzeShouldError: string | null = null;
let mvRowCount = 12345;
let mvTotalBytes = 40 * 1024 * 1024;

function resetStores() {
  refreshCallCount = 0;
  analyzeCallCount = 0;
  refreshShouldError = null;
  analyzeShouldError = null;
  mvRowCount = 12345;
  mvTotalBytes = 40 * 1024 * 1024;
}

// Throw a plain Error; Drizzle wraps it into DrizzleQueryError with .cause
// pointing at whatever we throw. The route's unwrapError walks e.cause to
// recover the real message.
const dispatch: SqlDispatcher = (query) => {
  const q = query.toLowerCase();

  // ---- ANALYZE things_search ----
  if (q.startsWith("analyze") && q.includes("things_search")) {
    analyzeCallCount++;
    if (analyzeShouldError) throw new Error(analyzeShouldError);
    return [];
  }

  // ---- REFRESH MATERIALIZED VIEW CONCURRENTLY things_search ----
  if (q.includes("refresh materialized view") && q.includes("things_search")) {
    refreshCallCount++;
    if (refreshShouldError) throw new Error(refreshShouldError);
    return [];
  }

  // Transaction / SET LOCAL — no-op
  if (q.startsWith("set local") || q.startsWith("begin") || q.startsWith("commit") || q.startsWith("rollback")) {
    return [];
  }

  // ---- Row-count / size query after refresh ----
  if (
    q.includes("count(*) from things_search") ||
    (q.includes("pg_total_relation_size") && q.includes("things_search"))
  ) {
    return [
      {
        row_count: String(mvRowCount),
        total_bytes: String(mvTotalBytes),
      },
    ];
  }

  // ---- entity_ids health check (noise) ----
  if (q.includes("count(*)") && q.includes("entity_ids")) {
    return [{ count: 0 }];
  }
  if (q.includes("last_value")) {
    return [{ last_value: 0, is_called: false }];
  }

  return [];
};

vi.mock("../db.js", () => mockDbModule(dispatch));

const { createApp } = await import("../app.js");

// ---- Tests ----

describe("things_search refresh", () => {
  let app: Hono;

  beforeEach(() => {
    resetStores();
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    app = createApp();
  });

  describe("POST /api/things-search/refresh", () => {
    it("runs REFRESH + ANALYZE in a transaction and returns stats", async () => {
      const res = await postJson(app, "/api/things-search/refresh", {});
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.rowCount).toBe(mvRowCount);
      expect(body.totalBytes).toBe(mvTotalBytes);
      expect(typeof body.durationMs).toBe("number");
      expect(body.durationMs).toBeGreaterThanOrEqual(0);
      expect(refreshCallCount).toBe(1);
      expect(analyzeCallCount).toBe(1);
    });

    it("unwraps DrizzleQueryError.cause so the real PG error reaches the client", async () => {
      refreshShouldError = "deadlock detected";
      const res = await postJson(app, "/api/things-search/refresh", {});
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.success).toBe(false);
      // Regression: the pre-fix code returned the Drizzle wrapper message
      // "Failed query: REFRESH..." — strengthen the assertion to catch that.
      expect(body.error).toContain("deadlock detected");
      expect(body.error).not.toContain("Failed query");
    });

    it("handles 'MV not populated' error with unwrapped message", async () => {
      refreshShouldError =
        "CONCURRENTLY cannot be used when the materialized view is not populated";
      const res = await postJson(app, "/api/things-search/refresh", {});
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toContain("not populated");
    });

    it("rolls back REFRESH when ANALYZE fails (atomic transaction)", async () => {
      analyzeShouldError = "canceling statement due to lock timeout";
      const res = await postJson(app, "/api/things-search/refresh", {});
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toContain("lock timeout");
      // Both statements attempted; both rolled back together.
      expect(refreshCallCount).toBe(1);
      expect(analyzeCallCount).toBe(1);
    });
  });
});
