// /status is not unit-tested here — the mock doesn't model
// pg_stat_all_tables column types.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { type SqlDispatcher, mockDbModule, postJson } from "./test-utils";

// ---- Mock state ----

let refreshCallCount = 0;
let refreshShouldError: string | null = null;
let mvRowCount = 12345;
let mvTotalBytes = 40 * 1024 * 1024;

function resetStores() {
  refreshCallCount = 0;
  refreshShouldError = null;
  mvRowCount = 12345;
  mvTotalBytes = 40 * 1024 * 1024;
}

const dispatch: SqlDispatcher = (query) => {
  const q = query.toLowerCase();

  // ---- REFRESH MATERIALIZED VIEW CONCURRENTLY things_search ----
  if (q.includes("refresh materialized view") && q.includes("things_search")) {
    refreshCallCount++;
    if (refreshShouldError) {
      throw new Error(refreshShouldError);
    }
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
    it("runs REFRESH MATERIALIZED VIEW CONCURRENTLY and returns stats", async () => {
      const res = await postJson(app, "/api/things-search/refresh", {});
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.rowCount).toBe(mvRowCount);
      expect(body.totalBytes).toBe(mvTotalBytes);
      expect(typeof body.durationMs).toBe("number");
      expect(body.durationMs).toBeGreaterThanOrEqual(0);
      expect(refreshCallCount).toBe(1);
    });

    it("returns 500 when the REFRESH call errors", async () => {
      refreshShouldError = "deadlock detected";
      const res = await postJson(app, "/api/things-search/refresh", {});
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.success).toBe(false);
      // Drizzle wraps the driver error with its own prefix; we only assert
      // the presence of a non-empty error string, not its exact format.
      expect(typeof body.error).toBe("string");
      expect(body.error.length).toBeGreaterThan(0);
      expect(typeof body.durationMs).toBe("number");
      // Refresh call was attempted (and failed)
      expect(refreshCallCount).toBe(1);
    });

    it("handles 'MV not populated' error from Postgres cleanly", async () => {
      refreshShouldError =
        "CONCURRENTLY cannot be used when the materialized view is not populated";
      const res = await postJson(app, "/api/things-search/refresh", {});
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(typeof body.error).toBe("string");
    });
  });
});
