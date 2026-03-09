/**
 * Tests for GET /api/monitoring/extended and its helper functions:
 * - fetchIntegritySummary — dangling-ref counts
 * - fetchRecentSessions — active_agents query
 * - fetchCiStatus — GitHub API call
 *
 * These helpers use rawDb (tagged-template postgres) + getDrizzleDb (Drizzle).
 * We mock the db module with dispatchers that return controlled data.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mockDbModule, type SqlDispatcher } from "./test-utils.js";

// Mock logger and auth early to avoid pino dependency
// monitoring.ts → utils.ts → logger.ts → pino (not installed locally)
vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
  },
}));

vi.mock("../auth.js", () => ({
  validateApiKey: () => (c: unknown, next: () => Promise<void>) => next(),
}));

// ---------------------------------------------------------------------------
// Shared mock builder
// ---------------------------------------------------------------------------

interface MonitoringScenario {
  // fetchIntegritySummary results
  danglingFacts?: number;
  danglingSummaries?: number;
  danglingCitations?: number;
  danglingEditLogs?: number;

  // fetchRecentSessions rows
  sessionRows?: Array<{
    id: number;
    session_id: string;
    branch: string | null;
    task: string | null;
    status: string;
    issue_number: number | null;
    pr_number: number | null;
    started_at: string | null;
    completed_at: string | null;
    model: string | null;
  }>;

  // fetchGroundskeeperStats — empty by default (not tested in detail here)
  gkStats?: unknown[];

  // fetchAutoUpdateStats
  autoUpdateTotal?: number;
  autoUpdateRuns?: unknown[];

  // Monitoring service counts for /status
  pageCount?: number;
  entityCount?: number;
  factCount?: number;
}

function buildMonitoringDispatch(scenario: MonitoringScenario = {}): SqlDispatcher {
  const {
    danglingFacts = 0,
    danglingSummaries = 0,
    danglingCitations = 0,
    danglingEditLogs = 0,
    sessionRows = [],
    pageCount = 100,
    entityCount = 200,
    factCount = 500,
  } = scenario;

  return (query: string, _params: unknown[]) => {
    const q = query.toLowerCase();

    // Health check / sequence fallbacks
    if (q.includes("count(*)") && q.includes("entity_ids")) {
      return [{ count: 0 }];
    }
    if (q.includes("last_value")) {
      return [{ last_value: 0, is_called: false }];
    }
    // Ref-check pass-through
    if (q.includes("as id from") && q.includes("where") && q.includes(" in ")) {
      return _params.map((p) => ({ id: p }));
    }

    // fetchIntegritySummary — the 4-subquery SELECT
    if (
      q.includes("dangling_facts") &&
      q.includes("dangling_summaries")
    ) {
      return [
        {
          dangling_facts: danglingFacts,
          dangling_summaries: danglingSummaries,
          dangling_citations: danglingCitations,
          dangling_edit_logs: danglingEditLogs,
        },
      ];
    }

    // fetchRecentSessions — SELECT FROM active_agents WHERE status != 'stale'
    if (q.includes("active_agents") && q.includes("status") && q.includes("stale")) {
      return sessionRows;
    }

    // fetchGroundskeeperStats — groundskeeper_runs GROUP BY task_name
    if (q.includes("groundskeeper_runs") || q.includes("groundkeeper_runs")) {
      return scenario.gkStats ?? [];
    }

    // fetchAutoUpdateStats — total count
    if (q.includes("auto_update_runs") && q.includes("count(*)")) {
      return [{ count: scenario.autoUpdateTotal ?? 0 }];
    }
    // fetchAutoUpdateStats — recent runs
    if (q.includes("auto_update_runs") && q.includes("order by")) {
      return scenario.autoUpdateRuns ?? [];
    }

    // fetchGroundskeeperStats — groundskeeper_runs WHERE status = 'health-check'
    if (q.includes("groundskeeper_runs") && q.includes("health-check")) {
      return [];
    }

    // /status DB counts
    if (q.includes("pages") && q.includes("entities") && q.includes("facts")) {
      return [{ pages: pageCount, entities: entityCount, facts: factCount }];
    }

    // active_agents count (for /status)
    if (q.includes("active_agents") && q.includes("count(*)")) {
      return [{ count: 0 }];
    }

    // service_health_incidents (for /status)
    if (q.includes("service_health_incidents")) {
      return [];
    }

    // jobs (for /status)
    if (q.includes("jobs") && q.includes("status")) {
      return [];
    }

    return [];
  };
}

async function createMonitoringApp(dispatch: SqlDispatcher) {
  vi.resetModules();
  vi.doMock("../db.js", () => mockDbModule(dispatch));
  const { monitoringRoute } = await import("../routes/monitoring.js");
  const app = new Hono().route("/api/monitoring", monitoringRoute);
  return app;
}

// ---------------------------------------------------------------------------
// fetchIntegritySummary tests
// ---------------------------------------------------------------------------

describe("GET /api/monitoring/extended — fetchIntegritySummary", () => {
  beforeEach(() => {
    // Prevent fetchCiStatus from making real HTTP calls
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns clean status when all dangling counts are 0", async () => {
    const app = await createMonitoringApp(buildMonitoringDispatch());

    const res = await app.request("/api/monitoring/extended");
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    const integrity = body.integrity as Record<string, unknown>;

    expect(integrity).toBeDefined();
    expect(integrity.status).toBe("clean");
    expect(integrity.totalDanglingRefs).toBe(0);

    const breakdown = integrity.breakdown as Record<string, number>;
    expect(breakdown.facts).toBe(0);
    expect(breakdown.summaries).toBe(0);
    expect(breakdown.citations).toBe(0);
    expect(breakdown.editLogs).toBe(0);
  });

  it("returns issues_found status when any dangling count is non-zero", async () => {
    const app = await createMonitoringApp(
      buildMonitoringDispatch({ danglingFacts: 2 })
    );

    const res = await app.request("/api/monitoring/extended");
    const body = (await res.json()) as Record<string, unknown>;
    const integrity = body.integrity as Record<string, unknown>;

    expect(integrity.status).toBe("issues_found");
    expect(integrity.totalDanglingRefs).toBe(2);
  });

  it("sums all dangling types into totalDanglingRefs", async () => {
    const app = await createMonitoringApp(
      buildMonitoringDispatch({
        danglingFacts: 1,
        danglingSummaries: 3,
        danglingCitations: 4,
        danglingEditLogs: 5,
      })
    );

    const res = await app.request("/api/monitoring/extended");
    const body = (await res.json()) as Record<string, unknown>;
    const integrity = body.integrity as Record<string, unknown>;

    expect(integrity.totalDanglingRefs).toBe(13); // 1+3+4+5
    const breakdown = integrity.breakdown as Record<string, number>;
    expect(breakdown.facts).toBe(1);
    expect(breakdown.summaries).toBe(3);
    expect(breakdown.citations).toBe(4);
    expect(breakdown.editLogs).toBe(5);
  });

  it("returns breakdown with all required keys", async () => {
    const app = await createMonitoringApp(buildMonitoringDispatch());
    const res = await app.request("/api/monitoring/extended");
    const body = (await res.json()) as Record<string, unknown>;
    const integrity = body.integrity as Record<string, unknown>;
    const breakdown = integrity.breakdown as Record<string, unknown>;

    expect(breakdown).toHaveProperty("facts");
    expect(breakdown).toHaveProperty("summaries");
    expect(breakdown).toHaveProperty("citations");
    expect(breakdown).toHaveProperty("editLogs");
  });
});

// ---------------------------------------------------------------------------
// fetchRecentSessions tests
// ---------------------------------------------------------------------------

describe("GET /api/monitoring/extended — fetchRecentSessions", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns empty array when no sessions exist", async () => {
    const app = await createMonitoringApp(buildMonitoringDispatch({ sessionRows: [] }));

    const res = await app.request("/api/monitoring/extended");
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.recentSessions).toEqual([]);
  });

  it("maps session row fields to camelCase correctly", async () => {
    const app = await createMonitoringApp(
      buildMonitoringDispatch({
        sessionRows: [
          {
            id: 42,
            session_id: "sess-abc",
            branch: "claude/my-feature",
            task: "Fix bug #123",
            status: "active",
            issue_number: 123,
            pr_number: 456,
            started_at: "2026-02-28T10:00:00Z",
            completed_at: null,
            model: "claude-opus-4-6",
          },
        ],
      })
    );

    const res = await app.request("/api/monitoring/extended");
    const body = (await res.json()) as Record<string, unknown>;
    const sessions = body.recentSessions as Array<Record<string, unknown>>;

    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.id).toBe(42);
    expect(s.sessionId).toBe("sess-abc");
    expect(s.branch).toBe("claude/my-feature");
    expect(s.task).toBe("Fix bug #123");
    expect(s.status).toBe("active");
    expect(s.issueNumber).toBe(123);
    expect(s.prNumber).toBe(456);
    expect(s.startedAt).toBe("2026-02-28T10:00:00Z");
    expect(s.completedAt).toBeNull();
    expect(s.model).toBe("claude-opus-4-6");
  });

  it("handles null optional fields gracefully", async () => {
    const app = await createMonitoringApp(
      buildMonitoringDispatch({
        sessionRows: [
          {
            id: 1,
            session_id: "sess-minimal",
            branch: null,
            task: null,
            status: "completed",
            issue_number: null,
            pr_number: null,
            started_at: null,
            completed_at: null,
            model: null,
          },
        ],
      })
    );

    const res = await app.request("/api/monitoring/extended");
    const body = (await res.json()) as Record<string, unknown>;
    const sessions = body.recentSessions as Array<Record<string, unknown>>;

    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.branch).toBeNull();
    expect(s.task).toBeNull();
    expect(s.issueNumber).toBeNull();
    expect(s.prNumber).toBeNull();
    expect(s.model).toBeNull();
  });

  it("returns the correct shape for each session", async () => {
    const app = await createMonitoringApp(
      buildMonitoringDispatch({
        sessionRows: [
          {
            id: 1,
            session_id: "sess-x",
            branch: "main",
            task: "do thing",
            status: "active",
            issue_number: null,
            pr_number: null,
            started_at: null,
            completed_at: null,
            model: null,
          },
        ],
      })
    );

    const res = await app.request("/api/monitoring/extended");
    const body = (await res.json()) as Record<string, unknown>;
    const sessions = body.recentSessions as Array<Record<string, unknown>>;
    const s = sessions[0];

    // All expected fields must be present
    const expectedKeys = [
      "id", "sessionId", "branch", "task", "status",
      "issueNumber", "prNumber", "startedAt", "completedAt", "model",
    ];
    for (const key of expectedKeys) {
      expect(s).toHaveProperty(key);
    }
  });
});

// ---------------------------------------------------------------------------
// fetchCiStatus tests
// ---------------------------------------------------------------------------

describe("GET /api/monitoring/extended — fetchCiStatus", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GITHUB_TOKEN;
  });

  it("returns null for ci when GITHUB_TOKEN is not set", async () => {
    delete process.env.GITHUB_TOKEN;
    const app = await createMonitoringApp(buildMonitoringDispatch());

    const res = await app.request("/api/monitoring/extended");
    const body = (await res.json()) as Record<string, unknown>;

    // No token → ci should be null
    expect(body.ci).toBeNull();
  });

  it("returns null for ci when GitHub API returns non-ok response", async () => {
    process.env.GITHUB_TOKEN = "fake-token";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 403 })
    );

    const app = await createMonitoringApp(buildMonitoringDispatch());

    const res = await app.request("/api/monitoring/extended");
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.ci).toBeNull();
  });

  it("returns ci status object with correct shape when GitHub API succeeds", async () => {
    process.env.GITHUB_TOKEN = "fake-token";

    const mockBranchResponse = {
      ok: true,
      json: () =>
        Promise.resolve({ commit: { sha: "abc123def456" } }),
    };
    const mockChecksResponse = {
      ok: true,
      json: () =>
        Promise.resolve({
          total_count: 2,
          check_runs: [
            { name: "CI / build", status: "completed", conclusion: "success", completed_at: "2026-02-28" },
            { name: "CI / test", status: "completed", conclusion: "success", completed_at: "2026-02-28" },
          ],
        }),
    };

    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
      callCount++;
      return callCount === 1
        ? Promise.resolve(mockBranchResponse)
        : Promise.resolve(mockChecksResponse);
    }));

    const app = await createMonitoringApp(buildMonitoringDispatch());

    const res = await app.request("/api/monitoring/extended");
    const body = (await res.json()) as Record<string, unknown>;

    // CI should be populated (not null)
    expect(body.ci).not.toBeNull();
    const ci = body.ci as Record<string, unknown>;
    expect(ci.sha).toBe("abc123de"); // first 8 chars of "abc123def456"
    expect(ci.totalChecks).toBe(2);
    expect(ci.allCompleted).toBe(true);
    expect(ci.allPassed).toBe(true);
    expect(ci.anyFailed).toBe(false);
    expect(ci.checks).toHaveLength(2);
  });

  it("reports anyFailed=true when any check has failure conclusion", async () => {
    process.env.GITHUB_TOKEN = "fake-token";

    const mockBranchResponse = {
      ok: true,
      json: () => Promise.resolve({ commit: { sha: "deadbeef1234" } }),
    };
    const mockChecksResponse = {
      ok: true,
      json: () =>
        Promise.resolve({
          total_count: 2,
          check_runs: [
            { name: "CI / build", status: "completed", conclusion: "success", completed_at: null },
            { name: "CI / test", status: "completed", conclusion: "failure", completed_at: null },
          ],
        }),
    };

    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
      callCount++;
      return callCount === 1
        ? Promise.resolve(mockBranchResponse)
        : Promise.resolve(mockChecksResponse);
    }));

    const app = await createMonitoringApp(buildMonitoringDispatch());

    const res = await app.request("/api/monitoring/extended");
    const body = (await res.json()) as Record<string, unknown>;

    const ci = body.ci as Record<string, unknown>;
    expect(ci.anyFailed).toBe(true);
    expect(ci.allPassed).toBe(false);
  });

  it("reports allCompleted=false when any check is still in_progress", async () => {
    process.env.GITHUB_TOKEN = "fake-token";

    const mockBranchResponse = {
      ok: true,
      json: () => Promise.resolve({ commit: { sha: "aaaa1111bbbb" } }),
    };
    const mockChecksResponse = {
      ok: true,
      json: () =>
        Promise.resolve({
          total_count: 1,
          check_runs: [
            { name: "CI / build", status: "in_progress", conclusion: null, completed_at: null },
          ],
        }),
    };

    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
      callCount++;
      return callCount === 1
        ? Promise.resolve(mockBranchResponse)
        : Promise.resolve(mockChecksResponse);
    }));

    const app = await createMonitoringApp(buildMonitoringDispatch());

    const res = await app.request("/api/monitoring/extended");
    const body = (await res.json()) as Record<string, unknown>;

    const ci = body.ci as Record<string, unknown>;
    expect(ci.allCompleted).toBe(false);
    expect(ci.allPassed).toBe(false);
  });

  it("returns null for ci when fetch throws (e.g., network timeout)", async () => {
    process.env.GITHUB_TOKEN = "fake-token";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network timeout")));

    const app = await createMonitoringApp(buildMonitoringDispatch());

    const res = await app.request("/api/monitoring/extended");
    // Should not throw — fetchCiStatus failure is caught and logged
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ci).toBeNull();
  });

  it("extended response always has all required top-level fields", async () => {
    delete process.env.GITHUB_TOKEN;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));

    const app = await createMonitoringApp(buildMonitoringDispatch());

    const res = await app.request("/api/monitoring/extended");
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toHaveProperty("ci");
    expect(body).toHaveProperty("groundskeeperTasks");
    expect(body).toHaveProperty("integrity");
    expect(body).toHaveProperty("autoUpdate");
    expect(body).toHaveProperty("recentSessions");
  });
});
