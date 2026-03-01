import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  type SqlDispatcher,
  mockDbModule,
  postJson,
} from "./test-utils";

// ---- In-memory store simulating active_agents table ----

let nextId = 1;
interface AgentRow {
  id: number;
  session_id: string;
  session_name: string | null;
  branch: string | null;
  task: string;
  status: string;
  current_step: string | null;
  issue_number: number | null;
  pr_number: number | null;
  files_touched: string[] | null;
  model: string | null;
  worktree: string | null;
  heartbeat_at: Date;
  started_at: Date;
  completed_at: Date | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

let store: AgentRow[];

function resetStore() {
  store = [];
  nextId = 1;
}

/** Parse a date param that could be a Date object or an ISO string. */
function toDate(p: unknown): Date {
  if (p instanceof Date) return p;
  if (typeof p === "string") return new Date(p);
  return new Date(0);
}

const dispatch: SqlDispatcher = (query, params) => {
  const q = query.toLowerCase().trim();

  // ---- entity_ids (for health check) ----
  if (q.includes("count(*)") && q.includes("entity_ids")) {
    return [{ count: 0 }];
  }
  if (q.includes("last_value")) {
    return [{ last_value: 0, is_called: false }];
  }

  // ---- INSERT INTO active_agents ... ON CONFLICT ... DO UPDATE ----
  if (q.includes("insert into") && q.includes("active_agents") && q.includes("on conflict")) {
    const sessionId = params[0] as string;
    const existing = store.find((r) => r.session_id === sessionId);

    if (existing) {
      // Simulate ON CONFLICT DO UPDATE
      // params: [sessionId, sessionName, branch, task, issueNumber, model, worktree, metadata]
      const now = new Date();
      existing.branch = (params[2] as string | null) ?? existing.branch;
      // Keep existing session name if set; otherwise use the newly generated one
      existing.session_name = existing.session_name ?? (params[1] as string | null);
      existing.task = params[3] as string;
      existing.issue_number = params[4] as number | null;
      existing.model = params[5] as string | null;
      existing.worktree = params[6] as string | null;
      existing.metadata = (params[7] as Record<string, unknown> | null) ?? existing.metadata;
      existing.status = "active";
      existing.heartbeat_at = now;
      existing.completed_at = null;
      existing.updated_at = now;
      return [existing];
    }

    // Simulate INSERT
    // params: [sessionId, sessionName, branch, task, issueNumber, model, worktree, metadata]
    const now = new Date();
    const row: AgentRow = {
      id: nextId++,
      session_id: params[0] as string,
      session_name: params[1] as string | null,
      branch: params[2] as string | null,
      task: params[3] as string,
      status: "active",
      current_step: null,
      issue_number: params[4] as number | null,
      pr_number: null,
      files_touched: null,
      model: params[5] as string | null,
      worktree: params[6] as string | null,
      heartbeat_at: now,
      started_at: now,
      completed_at: null,
      metadata: params[7] as Record<string, unknown> | null,
      created_at: now,
      updated_at: now,
    };
    store.push(row);
    return [row];
  }

  // ---- DELETE FROM active_agents WHERE (status IN (...) AND updated_at < cutoff) ----
  if (q.includes("delete") && q.includes("active_agents")) {
    // Params: [status1, status2, status3, cutoffDate]
    const statuses = params.slice(0, -1) as string[];
    const cutoff = toDate(params[params.length - 1]);
    const deleted: AgentRow[] = [];
    store = store.filter((row) => {
      if (statuses.includes(row.status) && row.updated_at < cutoff) {
        deleted.push(row);
        return false;
      }
      return true;
    });
    return deleted;
  }

  // ---- UPDATE active_agents SET ... ----
  if (q.startsWith("update ") && q.includes('"active_agents"') && q.includes(" set ")) {
    // Sweep: UPDATE SET status='stale', updated_at=... WHERE status='active' AND heartbeat_at < cutoff
    // Identified by: WHERE condition (before RETURNING) contains heartbeat_at
    const afterWhere = q.split(" where ")[1] ?? "";
    const whereCondition = afterWhere.split(" returning ")[0] ?? "";
    if (whereCondition.includes('"heartbeat_at"')) {
      const statusVal = params[0] as string;
      const updatedAt = toDate(params[1]);
      // params[2] is the WHERE status value, params[3] is the cutoff
      const cutoff = toDate(params[3]);
      const updated: AgentRow[] = [];
      for (const row of store) {
        if (row.status === "active" && row.heartbeat_at < cutoff) {
          row.status = statusVal;
          row.updated_at = updatedAt;
          updated.push(row);
        }
      }
      return updated;
    }

    // PATCH/heartbeat by id: WHERE "active_agents"."id" = $N
    const id = params[params.length - 1] as number;
    console.log("PATCH/heartbeat:", { id, storeIds: store.map(r => r.id), paramsLen: params.length, lastParam: params[params.length-1], query: q.substring(0, 150) });
    const idx = store.findIndex((r) => r.id === id);
    if (idx === -1) return [];

    const setMatch = query.match(/set\s+(.+?)\s+where/is);
    if (setMatch) {
      const setParts = setMatch[1].split(",").map((s) => s.trim());
      let pIdx = 0;
      for (const part of setParts) {
        const colMatch = part.match(/"(\w+)"/);
        if (!colMatch) { pIdx++; continue; }
        const col = colMatch[1];
        switch (col) {
          case "status":
            store[idx].status = params[pIdx] as string;
            break;
          case "current_step":
            store[idx].current_step = params[pIdx] as string | null;
            break;
          case "branch":
            store[idx].branch = params[pIdx] as string | null;
            break;
          case "issue_number":
            store[idx].issue_number = params[pIdx] as number | null;
            break;
          case "pr_number":
            store[idx].pr_number = params[pIdx] as number | null;
            break;
          case "files_touched":
            store[idx].files_touched = params[pIdx] as string[] | null;
            break;
          case "metadata":
            store[idx].metadata = params[pIdx] as Record<string, unknown> | null;
            break;
          case "heartbeat_at":
            store[idx].heartbeat_at = toDate(params[pIdx]);
            break;
          case "completed_at":
            store[idx].completed_at = params[pIdx] ? toDate(params[pIdx]) : null;
            break;
          case "updated_at":
            store[idx].updated_at = toDate(params[pIdx]);
            break;
        }
        pIdx++;
      }
    }

    return [store[idx]];
  }

  // ---- SELECT from active_agents ----
  if (q.includes("select") && q.includes("active_agents")) {
    // WHERE "active_agents"."id" = $1 (get by primary key)
    if (q.includes('where') && q.includes('"active_agents"."id"')) {
      const id = params[0] as number;
      return store.filter((r) => r.id === id);
    }

    // WHERE "active_agents"."status" = $1 (filtered list)
    if (q.includes('where') && q.includes('"active_agents"."status"')) {
      const status = params[0] as string;
      const limit = (params[1] as number) ?? 50;
      return store
        .filter((r) => r.status === status)
        .sort((a, b) => b.started_at.getTime() - a.started_at.getTime())
        .slice(0, limit);
    }

    // ORDER BY (list all, no WHERE)
    if (!q.includes("where") && q.includes("order by")) {
      const limit = (params[0] as number) || 50;
      return [...store]
        .sort((a, b) => b.started_at.getTime() - a.started_at.getTime())
        .slice(0, limit);
    }
  }

  return [];
};

vi.mock("../db.js", () => mockDbModule(dispatch));

const { createApp } = await import("../app.js");

// ---- Helpers ----

function patchJson(app: Hono, path: string, body: unknown) {
  return app.request(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---- Tests ----

describe("Active Agents API", () => {
  let app: Hono;

  beforeEach(() => {
    resetStore();
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    app = createApp();
  });

  const sampleAgent = {
    sessionId: "agent-abc-123",
    branch: "claude/fix-bug-42",
    task: "Fix widget rendering bug",
    issueNumber: 42,
    model: "claude-opus-4",
  };

  // ================================================================
  // POST / (register / upsert)
  // ================================================================

  describe("POST /api/active-agents", () => {
    it("registers a new agent and returns 201", async () => {
      const res = await postJson(app, "/api/active-agents", sampleAgent);
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe(1);
      expect(body.sessionId).toBe("agent-abc-123");
      expect(body.task).toBe("Fix widget rendering bug");
      expect(body.status).toBe("active");
    });

    it("upserts an existing agent with the same sessionId (returns 200)", async () => {
      // First registration
      await postJson(app, "/api/active-agents", sampleAgent);

      // Simulate time passing so updated_at differs from created_at
      store[0].created_at = new Date(Date.now() - 10000);

      // Second registration with same sessionId
      const res = await postJson(app, "/api/active-agents", {
        ...sampleAgent,
        task: "Updated task",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(1); // Same agent, not duplicated
      expect(body.task).toBe("Updated task");
    });

    it("preserves existing branch when new registration omits it", async () => {
      await postJson(app, "/api/active-agents", sampleAgent);

      // Register again without branch
      const { branch, ...noBranch } = sampleAgent;
      store[0].created_at = new Date(Date.now() - 10000);

      const res = await postJson(app, "/api/active-agents", noBranch);
      expect(res.status).toBe(200);
      const body = await res.json();
      // Should keep the existing branch since new one is null
      expect(body.branch).toBe("claude/fix-bug-42");
    });

    it("resets status to active on re-registration", async () => {
      await postJson(app, "/api/active-agents", sampleAgent);

      // Mark agent as stale
      store[0].status = "stale";
      store[0].created_at = new Date(Date.now() - 10000);

      // Re-register
      const res = await postJson(app, "/api/active-agents", sampleAgent);
      const body = await res.json();
      expect(body.status).toBe("active");
    });

    it("accepts null issueNumber", async () => {
      const res = await postJson(app, "/api/active-agents", {
        ...sampleAgent,
        issueNumber: null,
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.issueNumber).toBeNull();
    });

    it("rejects missing sessionId", async () => {
      const { sessionId, ...noSessionId } = sampleAgent;
      const res = await postJson(app, "/api/active-agents", noSessionId);
      expect(res.status).toBe(400);
    });

    it("rejects empty sessionId", async () => {
      const res = await postJson(app, "/api/active-agents", {
        ...sampleAgent,
        sessionId: "",
      });
      expect(res.status).toBe(400);
    });

    it("rejects missing task", async () => {
      const { task, ...noTask } = sampleAgent;
      const res = await postJson(app, "/api/active-agents", noTask);
      expect(res.status).toBe(400);
    });

    it("rejects invalid JSON body", async () => {
      const res = await app.request("/api/active-agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      });
      expect(res.status).toBe(400);
    });
  });

  // ================================================================
  // GET / (list agents with conflict detection)
  // ================================================================

  describe("GET /api/active-agents", () => {
    it("returns empty agents list", async () => {
      const res = await app.request("/api/active-agents");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.agents).toHaveLength(0);
      expect(body.conflicts).toHaveLength(0);
    });

    it("returns all registered agents", async () => {
      await postJson(app, "/api/active-agents", sampleAgent);
      await postJson(app, "/api/active-agents", {
        ...sampleAgent,
        sessionId: "agent-def-456",
      });

      const res = await app.request("/api/active-agents");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.agents).toHaveLength(2);
    });

    it("detects conflicts for active agents on the same issue", async () => {
      await postJson(app, "/api/active-agents", {
        ...sampleAgent,
        sessionId: "agent-1",
        issueNumber: 100,
      });
      await postJson(app, "/api/active-agents", {
        ...sampleAgent,
        sessionId: "agent-2",
        issueNumber: 100,
      });

      const res = await app.request("/api/active-agents");
      const body = await res.json();
      expect(body.conflicts).toHaveLength(1);
      expect(body.conflicts[0].issueNumber).toBe(100);
      expect(body.conflicts[0].sessionIds).toContain("agent-1");
      expect(body.conflicts[0].sessionIds).toContain("agent-2");
    });

    it("detects conflicts for stale agents on the same issue", async () => {
      await postJson(app, "/api/active-agents", {
        ...sampleAgent,
        sessionId: "agent-1",
        issueNumber: 100,
      });
      // Mark the first as stale
      store[0].status = "stale";

      await postJson(app, "/api/active-agents", {
        ...sampleAgent,
        sessionId: "agent-2",
        issueNumber: 100,
      });

      const res = await app.request("/api/active-agents");
      const body = await res.json();
      // Should still report a conflict — stale agent may still be running
      expect(body.conflicts).toHaveLength(1);
      expect(body.conflicts[0].sessionIds).toContain("agent-1");
      expect(body.conflicts[0].sessionIds).toContain("agent-2");
    });

    it("does NOT report conflicts for completed agents", async () => {
      await postJson(app, "/api/active-agents", {
        ...sampleAgent,
        sessionId: "agent-1",
        issueNumber: 100,
      });
      store[0].status = "completed";

      await postJson(app, "/api/active-agents", {
        ...sampleAgent,
        sessionId: "agent-2",
        issueNumber: 100,
      });

      const res = await app.request("/api/active-agents");
      const body = await res.json();
      expect(body.conflicts).toHaveLength(0);
    });

    it("filters by status query parameter", async () => {
      await postJson(app, "/api/active-agents", sampleAgent);
      store[0].status = "completed";

      await postJson(app, "/api/active-agents", {
        ...sampleAgent,
        sessionId: "agent-2",
      });

      const res = await app.request("/api/active-agents?status=active");
      const body = await res.json();
      expect(body.agents).toHaveLength(1);
      expect(body.agents[0].sessionId).toBe("agent-2");
    });

    it("respects limit parameter", async () => {
      for (let i = 0; i < 5; i++) {
        await postJson(app, "/api/active-agents", {
          ...sampleAgent,
          sessionId: `agent-${i}`,
        });
      }

      const res = await app.request("/api/active-agents?limit=3");
      const body = await res.json();
      expect(body.agents).toHaveLength(3);
    });
  });

  // ================================================================
  // GET /:id
  // ================================================================

  describe("GET /api/active-agents/:id", () => {
    it("returns a specific agent", async () => {
      await postJson(app, "/api/active-agents", sampleAgent);

      const res = await app.request("/api/active-agents/1");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.sessionId).toBe("agent-abc-123");
    });

    it("returns 404 for unknown agent", async () => {
      const res = await app.request("/api/active-agents/999");
      expect(res.status).toBe(404);
    });

    it("rejects non-numeric id", async () => {
      const res = await app.request("/api/active-agents/abc");
      expect(res.status).toBe(400);
    });
  });

  // ================================================================
  // PATCH /:id
  // ================================================================

  describe("PATCH /api/active-agents/:id", () => {
    it("updates agent status", async () => {
      await postJson(app, "/api/active-agents", sampleAgent);

      const res = await patchJson(app, "/api/active-agents/1", {
        status: "completed",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("completed");
    });

    it("updates current step", async () => {
      await postJson(app, "/api/active-agents", sampleAgent);

      const res = await patchJson(app, "/api/active-agents/1", {
        currentStep: "Running tests",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.currentStep).toBe("Running tests");
    });

    it("returns 404 for unknown agent", async () => {
      const res = await patchJson(app, "/api/active-agents/999", {
        status: "completed",
      });
      expect(res.status).toBe(404);
    });

    it("rejects invalid status", async () => {
      await postJson(app, "/api/active-agents", sampleAgent);

      const res = await patchJson(app, "/api/active-agents/1", {
        status: "invalid",
      });
      expect(res.status).toBe(400);
    });
  });

  // ================================================================
  // POST /:id/heartbeat
  // ================================================================

  describe("POST /api/active-agents/:id/heartbeat", () => {
    it("updates heartbeat timestamp", async () => {
      await postJson(app, "/api/active-agents", sampleAgent);

      const res = await postJson(app, "/api/active-agents/1/heartbeat", {});
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.heartbeatAt).toBeDefined();
    });

    it("returns 404 for unknown agent", async () => {
      const res = await postJson(app, "/api/active-agents/999/heartbeat", {});
      expect(res.status).toBe(404);
    });
  });

  // ================================================================
  // POST /sweep
  // ================================================================

  describe("POST /api/active-agents/sweep", () => {
    it("marks stale agents", async () => {
      await postJson(app, "/api/active-agents", sampleAgent);

      // Make the agent's heartbeat old (1 hour ago)
      store[0].heartbeat_at = new Date(Date.now() - 60 * 60 * 1000);

      const res = await postJson(app, "/api/active-agents/sweep", {
        timeoutMinutes: 30,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.swept).toBe(1);
      expect(store[0].status).toBe("stale");
    });

    it("does not sweep recent agents", async () => {
      await postJson(app, "/api/active-agents", sampleAgent);
      // heartbeat_at is recent (just created)

      const res = await postJson(app, "/api/active-agents/sweep", {
        timeoutMinutes: 30,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.swept).toBe(0);
    });
  });

  // ================================================================
  // POST /cleanup
  // ================================================================

  describe("POST /api/active-agents/cleanup", () => {
    it("deletes old completed agents", async () => {
      await postJson(app, "/api/active-agents", sampleAgent);

      // Mark as completed and make old
      store[0].status = "completed";
      store[0].updated_at = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000); // 60 days ago

      const res = await postJson(app, "/api/active-agents/cleanup", {
        ageDays: 30,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(1);
      expect(store).toHaveLength(0);
    });

    it("does not delete active agents", async () => {
      await postJson(app, "/api/active-agents", sampleAgent);

      // Make old but still active
      store[0].updated_at = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);

      const res = await postJson(app, "/api/active-agents/cleanup", {
        ageDays: 30,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(0);
      expect(store).toHaveLength(1);
    });

    it("does not delete recent completed agents", async () => {
      await postJson(app, "/api/active-agents", sampleAgent);

      // Mark as completed but recent
      store[0].status = "completed";
      // updated_at is recent (just created)

      const res = await postJson(app, "/api/active-agents/cleanup", {
        ageDays: 30,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(0);
      expect(store).toHaveLength(1);
    });

    it("deletes old stale and errored agents", async () => {
      // Create 3 agents with different terminal states
      await postJson(app, "/api/active-agents", { ...sampleAgent, sessionId: "a1" });
      await postJson(app, "/api/active-agents", { ...sampleAgent, sessionId: "a2" });
      await postJson(app, "/api/active-agents", { ...sampleAgent, sessionId: "a3" });

      const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
      store[0].status = "stale";
      store[0].updated_at = oldDate;
      store[1].status = "errored";
      store[1].updated_at = oldDate;
      store[2].status = "completed";
      store[2].updated_at = oldDate;

      const res = await postJson(app, "/api/active-agents/cleanup", {
        ageDays: 30,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(3);
      expect(store).toHaveLength(0);
    });
  });

  // ================================================================
  // Authentication
  // ================================================================

  describe("Authentication", () => {
    it("requires bearer token when API key is set", async () => {
      process.env.LONGTERMWIKI_SERVER_API_KEY = "test-secret";
      app = createApp();

      const res = await postJson(app, "/api/active-agents", sampleAgent);
      expect(res.status).toBe(401);
    });

    it("accepts valid bearer token", async () => {
      process.env.LONGTERMWIKI_SERVER_API_KEY = "test-secret";
      app = createApp();

      const res = await app.request("/api/active-agents", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-secret",
        },
        body: JSON.stringify(sampleAgent),
      });
      expect(res.status).toBe(201);
    });
  });
});
