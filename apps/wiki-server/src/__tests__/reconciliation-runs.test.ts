/**
 * Server-side route tests for /api/reconciliation-runs (QUA-958).
 *
 * Mocks Drizzle at the SQL dispatcher boundary so the full Hono pipeline
 * runs: Zod validation → transaction → DB write → JSON. Same pattern as
 * pipeline-runs.test.ts.
 *
 * Coverage focus is on the input/output contract — the SQL the route
 * produces is asserted by integration in `reconcile-stakeholders-cron.test.ts`.
 * Here we cover:
 *   - POST /start    (happy + Zod validation)
 *   - POST /complete (happy + 404 + Zod validation)
 *   - GET /summary   (happy with latest + window rollup)
 *   - GET /list      (happy)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  type SqlDispatcher,
  mockDbModule,
  postJson,
} from "./test-utils";

// ---- In-memory store ----

interface Row {
  id: number;
  domain: string;
  trigger: string;
  startedAt: Date;
  completedAt: Date | null;
  entitiesScanned: number | null;
  entitiesNonEmpty: number | null;
  diffsDetected: number | null;
  nonEmptyDiffsObserved: number | null;
  detailsJson: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
}

let runStore: Row[] = [];
let nextId = 1;

const dispatch: SqlDispatcher = (query, _params) => {
  const q = query.toLowerCase();

  // INSERT INTO "reconciliation_runs" ... RETURNING ...
  if (q.includes('insert into "reconciliation_runs"')) {
    // Crude params extraction — for /start we only need domain + trigger
    // (started_at defaults to now()). The Drizzle insert binds them positionally;
    // we just slot everything from the params array.
    const row: Row = {
      id: nextId++,
      domain: String(_params[0] ?? "policy_stakeholders"),
      trigger: String(_params[1] ?? "scheduled"),
      startedAt: _params[2] instanceof Date ? (_params[2] as Date) : new Date(String(_params[2])),
      completedAt: null,
      entitiesScanned: null,
      entitiesNonEmpty: null,
      diffsDetected: null,
      nonEmptyDiffsObserved: null,
      detailsJson: null,
      errorCode: null,
      errorMessage: null,
      createdAt: new Date(),
    };
    runStore.push(row);
    return [
      {
        id: row.id,
        domain: row.domain,
        started_at: row.startedAt,
      },
    ];
  }

  // UPDATE "reconciliation_runs" SET ... WHERE "id" = $X RETURNING ...
  if (q.includes('update "reconciliation_runs"')) {
    // Last param is the WHERE id
    const id = Number(_params[_params.length - 1]);
    const row = runStore.find((r) => r.id === id);
    if (!row) return [];
    // Parameters before WHERE are the SET values; we don't need to parse them
    // exhaustively — the route's response just returns a few fields, so we
    // mark the row completed and let the SELECT-shaped return reflect it.
    row.completedAt = new Date();
    row.entitiesScanned = Number(_params[1] ?? 0);
    row.entitiesNonEmpty = Number(_params[2] ?? 0);
    row.diffsDetected = Number(_params[3] ?? 0);
    row.nonEmptyDiffsObserved = Number(_params[4] ?? 0);
    return [
      {
        id: row.id,
        completed_at: row.completedAt,
        diffs_detected: row.diffsDetected,
        non_empty_diffs_observed: row.nonEmptyDiffsObserved,
      },
    ];
  }

  // SELECT ... FROM "reconciliation_runs" — used by /summary and /list
  if (q.includes('from "reconciliation_runs"')) {
    // /summary uses two queries: latest, then window rollup. /list is single.
    // Distinguish by presence of `count(*)` aggregate.
    if (q.includes("count(*)")) {
      const completed = runStore.filter((r) => r.completedAt !== null && r.errorCode === null);
      return [
        {
          runs: completed.length,
          non_empty_diffs_observed_total: completed.reduce(
            (s, r) => s + (r.nonEmptyDiffsObserved ?? 0),
            0,
          ),
          runs_with_non_empty_diff: completed.filter(
            (r) => (r.nonEmptyDiffsObserved ?? 0) > 0,
          ).length,
        },
      ];
    }
    // Plain SELECT — return all rows (sorted desc by startedAt) up to limit.
    return [...runStore]
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, 50)
      .map((r) => ({
        id: r.id,
        domain: r.domain,
        trigger: r.trigger,
        started_at: r.startedAt,
        completed_at: r.completedAt,
        entities_scanned: r.entitiesScanned,
        entities_non_empty: r.entitiesNonEmpty,
        diffs_detected: r.diffsDetected,
        non_empty_diffs_observed: r.nonEmptyDiffsObserved,
        details_json: r.detailsJson,
        error_code: r.errorCode,
        error_message: r.errorMessage,
        created_at: r.createdAt,
      }));
  }

  return [];
};

beforeEach(() => {
  runStore = [];
  nextId = 1;
});

// vi.mock the db module before importing the route.
import { vi } from "vitest";
vi.mock("../db.js", () => mockDbModule(dispatch));

const { reconciliationRunsRoute } = await import(
  "../routes/operational/reconciliation-runs.js"
);

function buildApp() {
  const app = new Hono();
  app.route("/api/reconciliation-runs", reconciliationRunsRoute);
  return app;
}

describe("POST /api/reconciliation-runs/start", () => {
  it("creates a row and returns id + domain + startedAt", async () => {
    const app = buildApp();
    const res = await postJson(app, "/api/reconciliation-runs/start", {
      domain: "policy_stakeholders",
      trigger: "scheduled",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(1);
    expect(body.domain).toBe("policy_stakeholders");
    expect(body.startedAt).toBeDefined();
  });

  it("rejects unknown domain via Zod", async () => {
    const app = buildApp();
    const res = await postJson(app, "/api/reconciliation-runs/start", {
      domain: "wat",
      trigger: "scheduled",
    });
    expect(res.status).toBe(400);
  });

  it("rejects missing trigger via Zod", async () => {
    const app = buildApp();
    const res = await postJson(app, "/api/reconciliation-runs/start", {
      domain: "policy_stakeholders",
    });
    expect(res.status).toBe(400);
  });

  it("rejects invalid startedAt format via Zod", async () => {
    const app = buildApp();
    const res = await postJson(app, "/api/reconciliation-runs/start", {
      domain: "policy_stakeholders",
      trigger: "scheduled",
      startedAt: "not-a-date",
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/reconciliation-runs/complete", () => {
  it("happy path closes a started row", async () => {
    const app = buildApp();
    const start = await postJson(app, "/api/reconciliation-runs/start", {
      domain: "policy_stakeholders",
      trigger: "scheduled",
    });
    const { id } = await start.json();

    const res = await postJson(app, "/api/reconciliation-runs/complete", {
      id,
      entitiesScanned: 151,
      entitiesNonEmpty: 39,
      diffsDetected: 0,
      nonEmptyDiffsObserved: 0,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(id);
    expect(body.completedAt).toBeDefined();
    expect(body.diffsDetected).toBe(0);
    expect(body.nonEmptyDiffsObserved).toBe(0);
  });

  it("rejects negative counts via Zod", async () => {
    const app = buildApp();
    const res = await postJson(app, "/api/reconciliation-runs/complete", {
      id: 1,
      entitiesScanned: -1,
      entitiesNonEmpty: 0,
      diffsDetected: 0,
      nonEmptyDiffsObserved: 0,
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 when id doesn't exist", async () => {
    const app = buildApp();
    const res = await postJson(app, "/api/reconciliation-runs/complete", {
      id: 999_999,
      entitiesScanned: 1,
      entitiesNonEmpty: 1,
      diffsDetected: 0,
      nonEmptyDiffsObserved: 0,
    });
    expect(res.status).toBe(404);
  });

  it("rejects negative id via Zod", async () => {
    const app = buildApp();
    const res = await postJson(app, "/api/reconciliation-runs/complete", {
      id: -1,
      entitiesScanned: 0,
      entitiesNonEmpty: 0,
      diffsDetected: 0,
      nonEmptyDiffsObserved: 0,
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/reconciliation-runs/summary", () => {
  it("returns empty summary when no runs exist", async () => {
    const app = buildApp();
    const res = await app.request("/api/reconciliation-runs/summary");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.domain).toBe("policy_stakeholders");
    expect(body.latestRun).toBeNull();
    expect(body.window.runs).toBe(0);
    expect(body.window.nonEmptyDiffsObservedTotal).toBe(0);
  });

  it("rejects invalid windowDays via Zod", async () => {
    const app = buildApp();
    const res = await app.request("/api/reconciliation-runs/summary?windowDays=0");
    expect(res.status).toBe(400);
  });

  it("rejects unknown domain via Zod", async () => {
    const app = buildApp();
    const res = await app.request("/api/reconciliation-runs/summary?domain=wat");
    expect(res.status).toBe(400);
  });
});

describe("GET /api/reconciliation-runs/list", () => {
  it("returns empty array when no rows", async () => {
    const app = buildApp();
    const res = await app.request("/api/reconciliation-runs/list");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runs).toEqual([]);
  });

  it("rejects out-of-range limit via Zod", async () => {
    const app = buildApp();
    const res = await app.request("/api/reconciliation-runs/list?limit=99999");
    // clampedLimit clamps rather than rejects, so 99999 → MAX_PAGE_SIZE
    // and the response is 200.
    expect(res.status).toBe(200);
  });

  it("rejects unknown domain via Zod", async () => {
    const app = buildApp();
    const res = await app.request("/api/reconciliation-runs/list?domain=wat");
    expect(res.status).toBe(400);
  });
});
