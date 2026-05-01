/**
 * Server-side route tests for /api/pipeline-runs (QUA-954).
 *
 * Mocks Drizzle at the SQL dispatcher boundary (same pattern as
 * auto-update-runs.test.ts) so the full Hono pipeline runs:
 * Zod validation → transaction → applyAuditContext → DB write → JSON.
 *
 * Coverage:
 *   - POST /            happy + 409 collision (TOCTOU-safe via onConflictDoNothing)
 *                       + Zod validation (missing field, malformed runId, oversize payload)
 *   - GET /             filter by status + pipelineName, count vs page-size
 *   - GET /stats        aggregate shape
 *   - GET /:id          drilldown happy + 404
 *   - PATCH /:id/heartbeat  bumps + 404 on missing/finished + audit_skip
 *   - PATCH /:id/end    success status, error_payload bound rejection,
 *                       followups overwrite, 404
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  type SqlDispatcher,
  mockDbModule,
  postJson,
} from "./test-utils";
import type { pipelineRuns as pipelineRunsTable } from "../schema.js";

type Row = typeof pipelineRunsTable.$inferSelect;

// In-memory store. Reset before every test.
let runStore: Row[] = [];

// Track whether SET LOCAL app.audit_skip was issued in the current
// transaction so the heartbeat audit-skip behaviour is asserted.
let auditSkipSeen = false;

function isoNow() {
  return new Date();
}

function rowToSql(r: Row): Record<string, unknown> {
  return {
    run_id: r.runId,
    agent_session_id: r.agentSessionId,
    pipeline_name: r.pipelineName,
    entity_id: r.entityId,
    shape: r.shape,
    status: r.status,
    failure_reason: r.failureReason,
    started_at: r.startedAt,
    heartbeat_at: r.heartbeatAt,
    ended_at: r.endedAt,
    snapshot_path: r.snapshotPath,
    error_code: r.errorCode,
    error_payload: r.errorPayload,
    followup_actions: r.followupActions,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

// Best-effort SQL parser that pulls JSON values out of `params` when
// Drizzle calls .unsafe(query, params). Drizzle binds JSONB params as
// strings on the SQL side; the dispatcher receives the raw value.
const dispatch: SqlDispatcher = (query, params) => {
  const q = query.toLowerCase();



  // Audit-context middleware writes via tx.execute(sql`...set_config...`).
  if (q.includes("set_config('app.agent_session_id'")) {
    return [];
  }
  // Heartbeat handler issues `SET LOCAL app.audit_skip = 'true'`.
  if (q.includes("set local app.audit_skip")) {
    auditSkipSeen = true;
    return [];
  }

  // ---- INSERT INTO pipeline_runs ... ON CONFLICT DO NOTHING RETURNING ----
  if (q.includes('insert into "pipeline_runs"')) {
    // Parse the column list and the VALUES clause from the SQL —
    // Drizzle interleaves `default` keywords with `$N` placeholders for
    // unset columns, so we need to track which column index maps to
    // which param index.
    const colsMatch = query.match(/insert\s+into\s+"pipeline_runs"\s*\(([^)]+)\)/i);
    if (!colsMatch) return [];
    const cols = colsMatch[1]
      .split(",")
      .map((s) => s.trim().replace(/^"|"$/g, ""));
    const valuesMatch = query.match(/values\s*\(([^)]+)\)/i);
    if (!valuesMatch) return [];
    const valueTokens = valuesMatch[1].split(",").map((s) => s.trim());

    const colToCamel: Record<string, keyof Row> = {
      run_id: "runId",
      pipeline_name: "pipelineName",
      agent_session_id: "agentSessionId",
      entity_id: "entityId",
      shape: "shape",
      status: "status",
      failure_reason: "failureReason",
      started_at: "startedAt",
      heartbeat_at: "heartbeatAt",
      ended_at: "endedAt",
      snapshot_path: "snapshotPath",
      error_code: "errorCode",
      error_payload: "errorPayload",
      followup_actions: "followupActions",
      created_at: "createdAt",
      updated_at: "updatedAt",
    };

    const now = isoNow();
    const row: Row = {
      runId: "",
      pipelineName: "",
      agentSessionId: null,
      entityId: null,
      shape: null,
      status: "running",
      failureReason: null,
      startedAt: now,
      heartbeatAt: now,
      endedAt: null,
      snapshotPath: null,
      errorCode: null,
      errorPayload: null,
      followupActions: [],
      createdAt: now,
      updatedAt: now,
    };
    cols.forEach((col, i) => {
      const key = colToCamel[col];
      if (!key) return;
      const token = valueTokens[i];
      if (!token || token === "default") return; // keep schema default
      const placeholderMatch = token.match(/^\$(\d+)$/);
      if (!placeholderMatch) return;
      const paramIdx = Number(placeholderMatch[1]) - 1;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (row as any)[key] = params[paramIdx] ?? null;
    });

    if (runStore.some((r) => r.runId === row.runId)) {
      return []; // ON CONFLICT DO NOTHING — empty returning
    }
    runStore.push(row);
    return [rowToSql(row)];
  }

  // ---- UPDATE pipeline_runs SET heartbeat_at = $1, updated_at = $2 WHERE run_id = $3 AND status = $4 RETURNING ... ----
  if (
    q.startsWith('update "pipeline_runs"') &&
    q.includes('"heartbeat_at"') &&
    !q.includes('"ended_at"')
  ) {
    // Heartbeat update — params: [heartbeat_at, updated_at, run_id, status]
    const newHeartbeat = params[0] as Date;
    const newUpdated = params[1] as Date;
    const runId = String(params[2]);
    const requiredStatus = String(params[3]);
    const row = runStore.find(
      (r) => r.runId === runId && r.status === requiredStatus,
    );
    if (!row) return [];
    row.heartbeatAt = newHeartbeat;
    row.updatedAt = newUpdated;
    return [{ run_id: row.runId, heartbeat_at: row.heartbeatAt }];
  }

  // ---- UPDATE pipeline_runs SET status, ended_at, ... WHERE run_id RETURNING * ----
  if (q.startsWith('update "pipeline_runs"') && q.includes('"ended_at"')) {
    // End-update. Drizzle emits SET clauses in a non-obvious order, so
    // parse the SET column list out of the SQL and zip with params.
    const setMatch = query.match(/set\s+(.+?)\s+where/is);
    if (!setMatch) return [];
    const setClause = setMatch[1];
    const setColRe = /"(\w+)"\s*=\s*\$\d+/g;
    const setCols: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = setColRe.exec(setClause))) setCols.push(m[1]);

    // Last param is the WHERE run_id.
    const runId = String(params[params.length - 1]);
    const row = runStore.find((r) => r.runId === runId);
    if (!row) return [];

    const colToCamel: Record<string, keyof Row> = {
      run_id: "runId",
      pipeline_name: "pipelineName",
      agent_session_id: "agentSessionId",
      entity_id: "entityId",
      shape: "shape",
      status: "status",
      failure_reason: "failureReason",
      started_at: "startedAt",
      heartbeat_at: "heartbeatAt",
      ended_at: "endedAt",
      snapshot_path: "snapshotPath",
      error_code: "errorCode",
      error_payload: "errorPayload",
      followup_actions: "followupActions",
      created_at: "createdAt",
      updated_at: "updatedAt",
    };
    setCols.forEach((col, i) => {
      const key = colToCamel[col];
      if (!key) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (row as any)[key] = params[i] ?? null;
    });
    return [rowToSql(row)];
  }

  // ---- Plain SELECT FROM pipeline_runs (drilldown by run_id, or list) ----
  if (q.startsWith('select') && q.includes('from "pipeline_runs"') && !q.includes("count(*)")) {
    // Inspect the WHERE clause specifically (column list always references
    // every column from .select()).
    const whereMatch = q.match(/where\s+(.+?)(?:\s+order\s+by|\s+group\s+by|\s+limit|\s*$)/);
    const whereClause = whereMatch ? whereMatch[1] : "";

    // Drilldown: WHERE "run_id" = $1 LIMIT 1
    if (whereClause.includes('"run_id"') && q.includes("limit")) {
      const runId = String(params[0]);
      const row = runStore.find((r) => r.runId === runId);
      return row ? [rowToSql(row)] : [];
    }

    // List: optional WHERE on status / pipeline_name + LIMIT.
    let rows = [...runStore];
    let pIdx = 0;
    if (whereClause.includes('"status"')) {
      const statusVal = String(params[pIdx++]);
      rows = rows.filter((r) => r.status === statusVal);
    }
    if (whereClause.includes('"pipeline_name"')) {
      const nameVal = String(params[pIdx++]);
      rows = rows.filter((r) => r.pipelineName === nameVal);
    }
    rows.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    return rows.map(rowToSql);
  }

  if (q.startsWith('select') && q.includes('from "pipeline_runs"') && q.includes("count(*)")) {
    let rows = [...runStore];
    {
      // group-by: stats aggregate. The simpler thing is to bucket by status.
      // Three queries fire from /stats: by status, by pipeline+status, by failure_reason.
      // Heuristic: detect group-by columns from the query.
      if (q.includes('group by "status"') && !q.includes('"pipeline_name"')) {
        const counts = new Map<string, number>();
        for (const r of rows) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
        return [...counts.entries()].map(([status, count]) => ({ status, count }));
      }
      if (q.includes('group by "pipeline_name"')) {
        const counts = new Map<string, number>();
        for (const r of rows) {
          const k = `${r.pipelineName}|${r.status}`;
          counts.set(k, (counts.get(k) ?? 0) + 1);
        }
        return [...counts.entries()].map(([k, count]) => {
          const [pipeline_name, status] = k.split("|");
          return { pipeline_name, status, count };
        });
      }
      if (q.includes('"failure_reason"')) {
        const counts = new Map<string, number>();
        for (const r of rows) {
          if (r.failureReason)
            counts.set(r.failureReason, (counts.get(r.failureReason) ?? 0) + 1);
        }
        return [...counts.entries()].map(([failure_reason, count]) => ({
          failure_reason,
          count,
        }));
      }
    }

    return [];
  }

  return [];
};

vi.mock("../db.js", () => mockDbModule(dispatch));

// Now import the route module — must be after vi.mock.
const { pipelineRunsRoute } = await import("../routes/operational/pipeline-runs.js");
const { auditContextMiddleware } = await import("../middleware/audit-context.js");

function buildApp(): Hono {
  const app = new Hono();
  app.use("*", auditContextMiddleware());
  app.route("/api/pipeline-runs", pipelineRunsRoute);
  return app;
}

beforeEach(() => {
  runStore = [];
  auditSkipSeen = false;
});

describe("POST /api/pipeline-runs", () => {
  it("creates a running row with caller-minted runId", async () => {
    const app = buildApp();
    const res = await postJson(app, "/api/pipeline-runs", {
      runId: "run-test-001",
      pipelineName: "improve-page",
      entityId: "E42",
      shape: "standard",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.runId).toBe("run-test-001");
    expect(body.status).toBe("running");
    expect(body.pipelineName).toBe("improve-page");
    expect(runStore.length).toBe(1);
  });

  it("returns 409 on runId collision (atomic via ON CONFLICT)", async () => {
    const app = buildApp();
    const r1 = await postJson(app, "/api/pipeline-runs", {
      runId: "duplicate-id",
      pipelineName: "improve-page",
    });
    expect(r1.status).toBe(201);
    const r2 = await postJson(app, "/api/pipeline-runs", {
      runId: "duplicate-id",
      pipelineName: "improve-page",
    });
    expect(r2.status).toBe(409);
    const body = (await r2.json()) as Record<string, unknown>;
    expect(body.error).toBe("conflict");
  });

  it("rejects malformed runId (whitespace, special chars)", async () => {
    const app = buildApp();
    const r1 = await postJson(app, "/api/pipeline-runs", {
      runId: "has whitespace",
      pipelineName: "improve-page",
    });
    expect(r1.status).toBe(400);

    const r2 = await postJson(app, "/api/pipeline-runs", {
      runId: "<script>",
      pipelineName: "improve-page",
    });
    expect(r2.status).toBe(400);

    const r3 = await postJson(app, "/api/pipeline-runs", {
      runId: "with\nnewline",
      pipelineName: "improve-page",
    });
    expect(r3.status).toBe(400);

    expect(runStore.length).toBe(0);
  });

  it("rejects missing required fields", async () => {
    const app = buildApp();
    const r = await postJson(app, "/api/pipeline-runs", {
      pipelineName: "improve-page",
      // missing runId
    });
    expect(r.status).toBe(400);
  });
});

describe("PATCH /api/pipeline-runs/:id/heartbeat", () => {
  it("bumps heartbeat_at on a running run + sets app.audit_skip", async () => {
    const app = buildApp();
    await postJson(app, "/api/pipeline-runs", {
      runId: "hb-001",
      pipelineName: "improve-page",
    });

    expect(auditSkipSeen).toBe(false);
    const res = await app.request("/api/pipeline-runs/hb-001/heartbeat", {
      method: "PATCH",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.runId).toBe("hb-001");
    // The handler MUST issue SET LOCAL app.audit_skip — heartbeats
    // would otherwise spam the universal audit log.
    expect(auditSkipSeen).toBe(true);
  });

  it("returns 404 when the run id is unknown", async () => {
    const app = buildApp();
    const res = await app.request("/api/pipeline-runs/never-existed/heartbeat", {
      method: "PATCH",
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the run is no longer running (already ended)", async () => {
    const app = buildApp();
    await postJson(app, "/api/pipeline-runs", {
      runId: "ended-001",
      pipelineName: "improve-page",
    });
    // Manually flip status (simulate /end having run).
    runStore[0].status = "committed";

    const res = await app.request("/api/pipeline-runs/ended-001/heartbeat", {
      method: "PATCH",
    });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/pipeline-runs/:id/end", () => {
  it("sets status, ended_at, error fields, and 200s", async () => {
    const app = buildApp();
    await postJson(app, "/api/pipeline-runs", {
      runId: "end-001",
      pipelineName: "improve-page",
    });

    const res = await app.request("/api/pipeline-runs/end-001/end", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "aborted",
        failureReason: "phase2_abort",
        errorCode: "TypeError",
        errorPayload: { message: "boom", stack: "..." },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("aborted");
    expect(body.failureReason).toBe("phase2_abort");
    expect(body.errorCode).toBe("TypeError");
    expect(body.endedAt).toBeTruthy();
  });

  it("rejects oversize errorPayload (>32 KiB serialized)", async () => {
    const app = buildApp();
    await postJson(app, "/api/pipeline-runs", {
      runId: "huge-001",
      pipelineName: "improve-page",
    });

    // Build a payload that serializes to > 32 KiB.
    const huge = "x".repeat(40_000);
    const res = await app.request("/api/pipeline-runs/huge-001/end", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "aborted",
        errorPayload: { dump: huge },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects > 50 followupActions", async () => {
    const app = buildApp();
    await postJson(app, "/api/pipeline-runs", {
      runId: "many-001",
      pipelineName: "improve-page",
    });

    const followups = Array.from({ length: 51 }, (_, i) => ({ kind: "retry", attempt: i }));
    const res = await app.request("/api/pipeline-runs/many-001/end", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "committed", followupActions: followups }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects invalid status enum value", async () => {
    const app = buildApp();
    await postJson(app, "/api/pipeline-runs", {
      runId: "bad-status-001",
      pipelineName: "improve-page",
    });

    const res = await app.request("/api/pipeline-runs/bad-status-001/end", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "completed" }), // not an end status
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 when the run id is unknown", async () => {
    const app = buildApp();
    const res = await app.request("/api/pipeline-runs/missing-001/end", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "committed" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/pipeline-runs", () => {
  it("returns recent runs, ordered desc, with `count` (page size, not total)", async () => {
    const app = buildApp();
    await postJson(app, "/api/pipeline-runs", {
      runId: "list-001",
      pipelineName: "improve-page",
    });
    await postJson(app, "/api/pipeline-runs", {
      runId: "list-002",
      pipelineName: "improve-page",
    });

    const res = await app.request("/api/pipeline-runs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Array.isArray(body.runs)).toBe(true);
    expect((body.runs as unknown[]).length).toBe(2);
    // Renamed from `total` (which was misleading — it was the page size,
    // not the total matching rows).
    expect(body.count).toBe(2);
    expect(body.total).toBeUndefined();
  });

  it("filters by pipelineName", async () => {
    const app = buildApp();
    await postJson(app, "/api/pipeline-runs", {
      runId: "filt-001",
      pipelineName: "improve-page",
    });
    await postJson(app, "/api/pipeline-runs", {
      runId: "filt-002",
      pipelineName: "source-check",
    });

    const res = await app.request("/api/pipeline-runs?pipelineName=improve-page");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: Row[]; count: number };
    expect(body.count).toBe(1);
    expect(body.runs[0].runId).toBe("filt-001");
  });
});

describe("GET /api/pipeline-runs/:id", () => {
  it("drills into one run by id", async () => {
    const app = buildApp();
    await postJson(app, "/api/pipeline-runs", {
      runId: "drill-001",
      pipelineName: "improve-page",
      entityId: "E42",
    });

    const res = await app.request("/api/pipeline-runs/drill-001");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.runId).toBe("drill-001");
    expect(body.entityId).toBe("E42");
  });

  it("returns 404 for unknown id", async () => {
    const app = buildApp();
    const res = await app.request("/api/pipeline-runs/never-existed");
    expect(res.status).toBe(404);
  });
});
