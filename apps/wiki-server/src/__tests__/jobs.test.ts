import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  type SqlDispatcher,
  mockDbModule,
  postJson,
} from "./test-utils";

// ---- In-memory store simulating the jobs table ----

let nextJobId = 1;
interface JobRow {
  id: number;
  type: string;
  status: string;
  params: unknown;
  result: unknown;
  error: string | null;
  priority: number;
  retries: number;
  max_retries: number;
  created_at: Date;
  claimed_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  worker_id: string | null;
  dedup_key: string | null;
  parent_job_id: number | null;
  run_after: Date | null;
  cost_usd: string | null;
}
let jobStore: JobRow[];

function resetStores() {
  jobStore = [];
  nextJobId = 1;
}

function makeJob(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: nextJobId++,
    type: "ping",
    status: "pending",
    params: null,
    result: null,
    error: null,
    priority: 0,
    retries: 0,
    max_retries: 3,
    created_at: new Date(),
    claimed_at: null,
    started_at: null,
    completed_at: null,
    worker_id: null,
    dedup_key: null,
    parent_job_id: null,
    run_after: null,
    cost_usd: null,
    ...overrides,
  };
}

const STATUSES = new Set(["pending", "claimed", "running", "completed", "failed", "cancelled"]);

const dispatch: SqlDispatcher = (query, params) => {
  const q = query.toLowerCase();

  // ---- entity_ids (for health check) ----
  if (q.includes("count(*)") && q.includes("entity_ids")) {
    return [{ count: 0 }];
  }
  if (q.includes("last_value")) {
    return [{ last_value: 0, is_called: false }];
  }

  // ---- INSERT INTO jobs ----
  if (q.includes("insert into") && q.includes('"jobs"')) {
    const hasOnConflict = q.includes("on conflict");

    // Extract param-to-column mapping from the VALUES clause.
    // Drizzle lists ALL columns but uses DEFAULT for unset ones.
    // Raw SQL (dedup path) lists only the columns with params.
    // Parse the VALUES to find which columns have $N placeholders.
    const colListMatch = query.match(/\(([^)]+)\)\s*values/i);
    const valuesMatch = query.match(/values\s*\(([^)]+)\)/i);

    if (colListMatch && valuesMatch) {
      // Parse column names from both quoted ("col") and unquoted (col) formats
      const colNames = colListMatch[1].split(',').map(c => c.trim().replace(/"/g, ''));
      const valueSlots = valuesMatch[1].split(',').map(v => v.trim());
      // Build a map of param index -> column name (only for $N slots, skip DEFAULT)
      const paramColMap: string[] = [];
      for (let si = 0; si < valueSlots.length; si++) {
        if (valueSlots[si].startsWith('$')) {
          paramColMap.push(colNames[si]);
        }
      }
      // Number of params per row
      const colsPerRow = paramColMap.length;
      const numRows = Math.max(1, Math.floor(params.length / colsPerRow));
      const rows: JobRow[] = [];
      for (let i = 0; i < numRows; i++) {
        const o = i * colsPerRow;
        const overrides: Partial<JobRow> = {};
        for (let ci = 0; ci < colsPerRow; ci++) {
          const col = paramColMap[ci];
          const val = params[o + ci];
          switch (col) {
            case 'type': overrides.type = val as string; break;
            case 'params': overrides.params = val != null ? (typeof val === "string" ? JSON.parse(val as string) : val) : null; break;
            case 'priority': overrides.priority = (val as number) ?? 0; break;
            case 'max_retries': overrides.max_retries = (val as number) ?? 3; break;
            case 'dedup_key': overrides.dedup_key = (val as string) ?? null; break;
            case 'parent_job_id': overrides.parent_job_id = (val as number) ?? null; break;
            case 'run_after': overrides.run_after = val != null ? new Date(val as string | number) : null; break;
          }
        }

        // ON CONFLICT DO NOTHING: check for active duplicate by dedup_key
        if (hasOnConflict && overrides.dedup_key) {
          const activeStatuses = new Set(["pending", "claimed", "running"]);
          const existing = jobStore.find(
            (j) => j.dedup_key === overrides.dedup_key && activeStatuses.has(j.status)
          );
          if (existing) {
            // Simulate DO NOTHING — return empty (0 rows)
            continue;
          }
        }

        const row = makeJob(overrides);
        jobStore.push(row);
        rows.push(row);
      }
      return rows;
    }

    // Fallback: simple 4-column layout (type, params, priority, max_retries)
    const numRows = Math.max(1, Math.floor(params.length / 4));
    const rows: JobRow[] = [];
    for (let i = 0; i < numRows; i++) {
      const o = i * 4;
      const row = makeJob({
        type: params[o] as string,
        params: params[o + 1] != null ? (typeof params[o + 1] === "string" ? JSON.parse(params[o + 1] as string) : params[o + 1]) : null,
        priority: (params[o + 2] as number) ?? 0,
        max_retries: (params[o + 3] as number) ?? 3,
      });
      jobStore.push(row);
      rows.push(row);
    }
    return rows;
  }

  // ---- UPDATE jobs (claim via raw SQL with FOR UPDATE SKIP LOCKED) ----
  if (q.includes("update") && q.includes('"jobs"') && q.includes("for update skip locked")) {
    const workerId = params[0] as string;
    // Support both single type string and types array (ANY($2::text[]))
    let typeFilter: string | null = null;
    let typesFilter: string[] | null = null;
    if (params.length >= 2) {
      if (Array.isArray(params[1])) {
        typesFilter = params[1] as string[];
      } else {
        typeFilter = params[1] as string;
      }
    }
    const pending = jobStore
      .filter((j) => {
        if (j.status !== "pending") return false;
        // Respect run_after: skip jobs not yet ready
        if (j.run_after && j.run_after.getTime() > Date.now()) return false;
        if (typesFilter) return typesFilter.includes(j.type);
        if (typeFilter) return j.type === typeFilter;
        return true;
      })
      .sort((a, b) => b.priority - a.priority || a.created_at.getTime() - b.created_at.getTime());

    if (pending.length === 0) return [];

    const job = pending[0];
    job.status = "claimed";
    job.claimed_at = new Date();
    job.worker_id = workerId;
    return [job];
  }

  // ---- FAIL (atomic UPDATE with CASE WHEN, via pgClient.unsafe) ----
  // params: [$1=error, $2=id]
  if (q.includes("update") && q.includes('"jobs"') && q.includes("case when") && q.includes("max_retries")) {
    const errorMsg = params[0] as string;
    const jobId = params[1] as number;
    const job = jobStore.find(
      (j) => j.id === jobId && (j.status === "running" || j.status === "claimed")
    );
    if (!job) return [];
    const newRetries = job.retries + 1;
    const shouldRetry = newRetries < job.max_retries;
    job.retries = newRetries;
    job.status = shouldRetry ? "pending" : "failed";
    job.error = errorMsg;
    job.completed_at = shouldRetry ? null : new Date();
    job.claimed_at = shouldRetry ? null : job.claimed_at;
    job.started_at = shouldRetry ? null : job.started_at;
    job.worker_id = shouldRetry ? null : job.worker_id;
    return [job];
  }

  // ---- UPDATE jobs SET (Drizzle query builder) ----
  if (q.includes("update") && q.includes('"jobs"') && q.includes("set")) {
    // Drizzle generates: UPDATE "jobs" SET "col1" = $1, "col2" = $2 WHERE ... RETURNING ...
    // SET params come first, then WHERE params.
    // The first param is always the new status value.
    const newStatus = params[0] as string;

    // ---- START: params = ['running', timestamp, jobId, 'claimed'] ----
    if (newStatus === "running" && q.includes('"started_at"')) {
      const jobId = params[2] as number;
      const job = jobStore.find((j) => j.id === jobId && j.status === "claimed");
      if (!job) return [];
      job.status = "running";
      job.started_at = new Date(params[1] as string);
      return [job];
    }

    // ---- COMPLETE ----
    // Without cost: params = ['completed', result_json, timestamp, jobId, 'running']
    // With cost:    params = ['completed', result_json, cost_usd, timestamp, jobId, 'running']
    if (newStatus === "completed" && q.includes('"result"')) {
      // Check SET clause only (before WHERE) for cost_usd — RETURNING always lists all columns
      const setClause = q.split('where')[0];
      const hasCost = setClause.includes('"cost_usd"');
      if (hasCost) {
        const jobId = params[4] as number;
        const job = jobStore.find((j) => j.id === jobId && j.status === "running");
        if (!job) return [];
        job.status = "completed";
        job.result = params[1] != null ? (typeof params[1] === "string" ? JSON.parse(params[1] as string) : params[1]) : null;
        job.cost_usd = params[2] as string;
        job.completed_at = new Date(params[3] as string);
        return [job];
      } else {
        const jobId = params[3] as number;
        const job = jobStore.find((j) => j.id === jobId && j.status === "running");
        if (!job) return [];
        job.status = "completed";
        job.result = params[1] != null ? (typeof params[1] === "string" ? JSON.parse(params[1] as string) : params[1]) : null;
        job.completed_at = new Date(params[2] as string);
        return [job];
      }
    }

    // ---- CANCEL: params = ['cancelled', timestamp, jobId] ----
    // Uses raw SQL for status check: IN ('pending', 'claimed')
    if (newStatus === "cancelled") {
      const jobId = params[2] as number;
      const job = jobStore.find(
        (j) => j.id === jobId && (j.status === "pending" || j.status === "claimed")
      );
      if (!job) return [];
      job.status = "cancelled";
      job.completed_at = new Date(params[1] as string);
      return [job];
    }

    // ---- FAIL with retry: params = ['pending', error, retries, null, null, null, null, jobId] ----
    if (newStatus === "pending" && q.includes('"error"') && q.includes('"retries"')) {
      const jobId = params[params.length - 1] as number;
      const job = jobStore.find((j) => j.id === jobId);
      if (!job) return [];
      job.status = "pending";
      job.error = params[1] as string;
      job.retries = params[2] as number;
      job.completed_at = null;
      job.claimed_at = null;
      job.started_at = null;
      job.worker_id = null;
      return [job];
    }

    // ---- FAIL without retry: params = ['failed', error, retries, timestamp, jobId] ----
    if (newStatus === "failed" && q.includes('"error"') && q.includes('"retries"')) {
      const jobId = params[params.length - 1] as number;
      const job = jobStore.find((j) => j.id === jobId);
      if (!job) return [];
      job.status = "failed";
      job.error = params[1] as string;
      job.retries = params[2] as number;
      job.completed_at = new Date(params[3] as string);
      return [job];
    }

    // ---- SWEEP: uses interval in WHERE ----
    if (q.includes("interval")) {
      const stale = jobStore.filter(
        (j) =>
          (j.status === "claimed" || j.status === "running") &&
          j.claimed_at &&
          Date.now() - j.claimed_at.getTime() > 60 * 60 * 1000
      );
      for (const j of stale) {
        j.status = "pending";
        j.claimed_at = null;
        j.started_at = null;
        j.worker_id = null;
      }
      return stale.map((j) => ({ id: j.id, type: j.type }));
    }

    return [];
  }

  // ---- SELECT * FROM jobs WHERE dedup_key = $1 (dedup lookup) ----
  if (q.includes("select") && q.includes('"jobs"') && q.includes("where") && q.includes("dedup_key =") && !q.includes("insert")) {
    const dedupKey = params[0] as string;
    const activeStatuses = new Set(["pending", "claimed", "running"]);
    const match = jobStore.find((j) => j.dedup_key === dedupKey && activeStatuses.has(j.status));
    return match ? [match] : [];
  }

  // ---- SELECT count(*) FROM jobs ----
  if (q.includes("count(*)") && q.includes('"jobs"') && !q.includes("group by")) {
    let filtered = jobStore;
    for (const p of params) {
      if (typeof p === "string" && STATUSES.has(p)) {
        filtered = filtered.filter((j) => j.status === p);
      }
    }
    return [{ count: filtered.length }];
  }

  // ---- SELECT ... GROUP BY status WHERE parent_job_id (children) ----
  if (q.includes("jobs") && q.includes("group by") && q.includes("parent_job_id")) {
    const parentId = params[0] as number;
    const children = jobStore.filter((j) => j.parent_job_id === parentId);
    const groups: Record<string, number> = {};
    for (const j of children) {
      groups[j.status] = (groups[j.status] || 0) + 1;
    }
    return Object.entries(groups).map(([status, count]) => ({ status, count }));
  }

  // ---- SELECT ... GROUP BY type, status (stats) ----
  if (q.includes('"jobs"') && q.includes("group by") && q.includes('"type"') && q.includes('"status"')) {
    const groups: Record<string, Record<string, number>> = {};
    for (const j of jobStore) {
      if (!groups[j.type]) groups[j.type] = {};
      groups[j.type][j.status] = (groups[j.type][j.status] || 0) + 1;
    }
    const rows = [];
    for (const [type, statuses] of Object.entries(groups)) {
      for (const [status, count] of Object.entries(statuses)) {
        rows.push({ type, status, count });
      }
    }
    return rows;
  }

  // ---- SELECT avg/sum GROUP BY type ----
  if ((q.includes("avg(") || q.includes("sum(")) && q.includes('"jobs"')) {
    return [];
  }

  // ---- SELECT ... WHERE id = (single job by ID) ----
  if (q.includes('"jobs"') && q.includes("where") && q.includes('"id"') && !q.includes("update")) {
    const id = params[0] as number;
    return jobStore.filter((j) => j.id === id);
  }

  // ---- SELECT ... ORDER BY ... LIMIT ... (paginated list) ----
  if (q.includes('"jobs"') && q.includes("order by") && q.includes("limit")) {
    let filtered = [...jobStore];
    for (const p of params) {
      if (typeof p === "string" && STATUSES.has(p)) {
        filtered = filtered.filter((j) => j.status === p);
      }
    }
    filtered.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
    // Drizzle puts limit as the last numeric param, and offset (if non-zero) after it.
    // When offset=0, Drizzle omits it entirely, so params may have just [limit].
    const numericParams = params.filter((p) => typeof p === "number");
    const hasOffset = q.includes("offset");
    let limit = 50;
    let offset = 0;
    if (hasOffset && numericParams.length >= 2) {
      limit = numericParams[numericParams.length - 2] as number;
      offset = numericParams[numericParams.length - 1] as number;
    } else if (numericParams.length >= 1) {
      limit = numericParams[numericParams.length - 1] as number;
    }
    return filtered.slice(offset, offset + limit);
  }

  return [];
};

vi.mock("../db.js", () => mockDbModule(dispatch));

const { createApp } = await import("../app.js");

// ---- Tests ----

describe("Jobs API", () => {
  let app: Hono;

  beforeEach(() => {
    resetStores();
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    app = createApp();
  });

  describe("POST /api/jobs (create)", () => {
    it("creates a single job and returns 201", async () => {
      const res = await postJson(app, "/api/jobs", {
        type: "ping",
        priority: 5,
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe(1);
      expect(body.type).toBe("ping");
      expect(body.status).toBe("pending");
      expect(body.priority).toBe(5);
    });

    it("creates a batch of jobs and returns 201 with dedupExisting", async () => {
      const res = await postJson(app, "/api/jobs", [
        { type: "ping" },
        { type: "citation-verify", params: { pageId: "ai-safety" } },
      ]);
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(2);
      expect(body[0].type).toBe("ping");
      expect(body[0].dedupExisting).toBe(false);
      expect(body[1].type).toBe("citation-verify");
      expect(body[1].dedupExisting).toBe(false);
    });

    it("rejects missing type", async () => {
      const res = await postJson(app, "/api/jobs", { priority: 1 });
      expect(res.status).toBe(400);
    });

    it("rejects empty type string", async () => {
      const res = await postJson(app, "/api/jobs", { type: "" });
      expect(res.status).toBe(400);
    });

    it("rejects priority out of range", async () => {
      const res = await postJson(app, "/api/jobs", {
        type: "ping",
        priority: 9999,
      });
      expect(res.status).toBe(400);
    });

    it("rejects empty batch array", async () => {
      const res = await postJson(app, "/api/jobs", []);
      expect(res.status).toBe(400);
    });

    it("returns camelCase keys in response", async () => {
      const res = await postJson(app, "/api/jobs", { type: "ping", maxRetries: 5 });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body).toHaveProperty("maxRetries");
      expect(body).toHaveProperty("createdAt");
      expect(body).toHaveProperty("workerId");
      expect(body).not.toHaveProperty("max_retries");
      expect(body).not.toHaveProperty("created_at");
      expect(body).not.toHaveProperty("worker_id");
    });

    it("creates a job with dedupKey", async () => {
      const res = await postJson(app, "/api/jobs", { type: "ping", dedupKey: "test-dedup" });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.dedupKey).toBe("test-dedup");
    });

    it("creates a job with parentJobId", async () => {
      // Create parent first
      const parent = await postJson(app, "/api/jobs", { type: "batch-commit" });
      const parentBody = await parent.json();

      const res = await postJson(app, "/api/jobs", { type: "ping", parentJobId: parentBody.id });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.parentJobId).toBe(parentBody.id);
    });

    it("creates a job with runAfter", async () => {
      const future = new Date(Date.now() + 3600_000).toISOString();
      const res = await postJson(app, "/api/jobs", { type: "ping", runAfter: future });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.runAfter).toBeTruthy();
    });

    it("creates a batch with dedupKey per job", async () => {
      const res = await postJson(app, "/api/jobs", [
        { type: "ping", dedupKey: "batch-dup-1" },
        { type: "ping", dedupKey: "batch-dup-2" },
      ]);
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body).toHaveLength(2);
      expect(body[0].dedupKey).toBe("batch-dup-1");
      expect(body[0].dedupExisting).toBe(false);
      expect(body[1].dedupKey).toBe("batch-dup-2");
      expect(body[1].dedupExisting).toBe(false);
    });

    it("deduplicates batch jobs against existing active jobs", async () => {
      // Create an existing job with a dedup key
      await postJson(app, "/api/jobs", { type: "ping", dedupKey: "existing-key" });

      // Batch with one duplicate and one new
      const res = await postJson(app, "/api/jobs", [
        { type: "ping", dedupKey: "existing-key" },
        { type: "ping", dedupKey: "new-key" },
      ]);
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body).toHaveLength(2);
      // First job should be the existing one (dedup hit)
      expect(body[0].dedupKey).toBe("existing-key");
      expect(body[0].dedupExisting).toBe(true);
      // Second job should be newly created
      expect(body[1].dedupKey).toBe("new-key");
      expect(body[1].dedupExisting).toBe(false);
    });

    it("allows batch with mix of dedup and non-dedup jobs", async () => {
      const res = await postJson(app, "/api/jobs", [
        { type: "ping", dedupKey: "dk1" },
        { type: "citation-verify" },
      ]);
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body).toHaveLength(2);
      expect(body[0].dedupKey).toBe("dk1");
      expect(body[0].dedupExisting).toBe(false);
      expect(body[1].dedupKey).toBeNull();
      expect(body[1].dedupExisting).toBe(false);
    });
  });

  describe("GET /api/jobs (list)", () => {
    it("returns paginated jobs", async () => {
      for (let i = 0; i < 3; i++) {
        await postJson(app, "/api/jobs", { type: "ping" });
      }

      const res = await app.request("/api/jobs?limit=2&offset=0");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.entries).toHaveLength(2);
      expect(body.total).toBe(3);
    });

    it("returns empty list when no jobs exist", async () => {
      const res = await app.request("/api/jobs");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.entries).toHaveLength(0);
      expect(body.total).toBe(0);
    });
  });

  describe("POST /api/jobs/claim", () => {
    it("claims the highest priority pending job", async () => {
      await postJson(app, "/api/jobs", { type: "ping", priority: 1 });
      await postJson(app, "/api/jobs", { type: "ping", priority: 10 });

      const res = await postJson(app, "/api/jobs/claim", {
        workerId: "test-worker-1",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.job).not.toBeNull();
      expect(body.job.status).toBe("claimed");
      expect(body.job.workerId).toBe("test-worker-1");
    });

    it("returns null when no pending jobs", async () => {
      const res = await postJson(app, "/api/jobs/claim", {
        workerId: "test-worker-1",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.job).toBeNull();
    });

    it("claims by type filter", async () => {
      await postJson(app, "/api/jobs", { type: "ping", priority: 10 });
      await postJson(app, "/api/jobs", { type: "citation-verify", priority: 1 });

      const res = await postJson(app, "/api/jobs/claim", {
        workerId: "w1",
        type: "citation-verify",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.job).not.toBeNull();
      expect(body.job.type).toBe("citation-verify");
    });

    it("returns null when type filter matches no pending jobs", async () => {
      await postJson(app, "/api/jobs", { type: "ping" });

      const res = await postJson(app, "/api/jobs/claim", {
        workerId: "w1",
        type: "nonexistent-type",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.job).toBeNull();
    });

    it("rejects missing workerId", async () => {
      const res = await postJson(app, "/api/jobs/claim", {});
      expect(res.status).toBe(400);
    });

    it("claims with types array", async () => {
      // Create jobs of different types
      await postJson(app, "/api/jobs", { type: "page-improve" });
      await postJson(app, "/api/jobs", { type: "ping" });

      const res = await postJson(app, "/api/jobs/claim", {
        workerId: "test-worker",
        types: ["ping", "citation-verify"],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.job).not.toBeNull();
      expect(body.job.type).toBe("ping");
    });

    it("returns null when no jobs match types", async () => {
      await postJson(app, "/api/jobs", { type: "page-improve" });

      const res = await postJson(app, "/api/jobs/claim", {
        workerId: "test-worker",
        types: ["citation-verify"],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.job).toBeNull();
    });
  });

  describe("POST /api/jobs/:id/start", () => {
    it("marks a claimed job as running", async () => {
      await postJson(app, "/api/jobs", { type: "ping" });
      await postJson(app, "/api/jobs/claim", { workerId: "w1" });

      const res = await postJson(app, "/api/jobs/1/start", {});
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("running");
    });
  });

  describe("POST /api/jobs/:id/complete", () => {
    it("marks a running job as completed with result", async () => {
      await postJson(app, "/api/jobs", { type: "ping" });
      await postJson(app, "/api/jobs/claim", { workerId: "w1" });
      await postJson(app, "/api/jobs/1/start", {});

      const res = await postJson(app, "/api/jobs/1/complete", {
        result: { ok: true },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("completed");
    });

    it("accepts cost field", async () => {
      // Create and claim a job
      await postJson(app, "/api/jobs", { type: "ping" });
      const claimed = await postJson(app, "/api/jobs/claim", { workerId: "w1" });
      const claimBody = await claimed.json();
      await postJson(app, `/api/jobs/${claimBody.job.id}/start`, {});

      const res = await postJson(app, `/api/jobs/${claimBody.job.id}/complete`, {
        result: { ok: true },
        cost: 0.0042,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.costUsd).toBeTruthy();
    });
  });

  describe("POST /api/jobs/:id/fail", () => {
    it("marks a running job as failed with retried=false when maxRetries exhausted", async () => {
      await postJson(app, "/api/jobs", { type: "ping", maxRetries: 1 });
      await postJson(app, "/api/jobs/claim", { workerId: "w1" });
      await postJson(app, "/api/jobs/1/start", {});

      const res = await postJson(app, "/api/jobs/1/fail", {
        error: "Something went wrong",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBe("Something went wrong");
      expect(body.status).toBe("failed");
      expect(body.retried).toBe(false);
    });

    it("retries a failed job when retries < maxRetries", async () => {
      await postJson(app, "/api/jobs", { type: "ping", maxRetries: 3 });
      await postJson(app, "/api/jobs/claim", { workerId: "w1" });
      await postJson(app, "/api/jobs/1/start", {});

      const res = await postJson(app, "/api/jobs/1/fail", {
        error: "Transient error",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("pending");
      expect(body.retried).toBe(true);
      expect(body.retries).toBe(1);
    });

    it("rejects missing error message", async () => {
      const res = await postJson(app, "/api/jobs/1/fail", {});
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/jobs/:id/cancel", () => {
    it("cancels a pending job", async () => {
      await postJson(app, "/api/jobs", { type: "ping" });

      const res = await postJson(app, "/api/jobs/1/cancel", {});
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("cancelled");
    });

    it("rejects cancelling a running job", async () => {
      await postJson(app, "/api/jobs", { type: "ping" });
      await postJson(app, "/api/jobs/claim", { workerId: "w1" });
      await postJson(app, "/api/jobs/1/start", {});

      const res = await postJson(app, "/api/jobs/1/cancel", {});
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/jobs/stats", () => {
    it("returns aggregate statistics", async () => {
      await postJson(app, "/api/jobs", { type: "ping" });
      await postJson(app, "/api/jobs", { type: "citation-verify" });

      const res = await app.request("/api/jobs/stats");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.totalJobs).toBe(2);
      expect(body.byType).toBeDefined();
    });

    it("returns zeros when no jobs exist", async () => {
      const res = await app.request("/api/jobs/stats");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.totalJobs).toBe(0);
    });
  });

  describe("GET /api/jobs/:id", () => {
    it("returns a single job", async () => {
      await postJson(app, "/api/jobs", { type: "ping", priority: 5 });

      const res = await app.request("/api/jobs/1");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(1);
      expect(body.type).toBe("ping");
      expect(body.priority).toBe(5);
    });

    it("returns 404 for unknown job", async () => {
      const res = await app.request("/api/jobs/999");
      expect(res.status).toBe(404);
    });

    it("returns 400 for non-numeric id", async () => {
      const res = await app.request("/api/jobs/abc");
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/jobs/sweep", () => {
    it("returns swept count", async () => {
      const res = await postJson(app, "/api/jobs/sweep", {});
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.swept).toBeDefined();
      expect(typeof body.swept).toBe("number");
    });
  });

  describe("GET /api/jobs/:id/children", () => {
    it("returns empty children for job with no children", async () => {
      const created = await postJson(app, "/api/jobs", { type: "batch-commit" });
      const parent = await created.json();

      const res = await app.request(`/api/jobs/${parent.id}/children`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(0);
      expect(body.children).toEqual({});
    });
  });
});
