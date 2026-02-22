import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  type SqlDispatcher,
  mockDbModule,
  postJson,
} from "./test-utils";

// ---- In-memory store simulating agent_sessions table ----

let nextId = 1;
let store: Array<{
  id: number;
  branch: string;
  task: string;
  session_type: string;
  issue_number: number | null;
  checklist_md: string;
  status: string;
  started_at: Date;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}>;

function resetStore() {
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

  // ---- INSERT INTO agent_sessions ----
  if (q.includes("insert into") && q.includes("agent_sessions")) {
    const row = {
      id: nextId++,
      branch: params[0] as string,
      task: params[1] as string,
      session_type: params[2] as string,
      issue_number: params[3] as number | null,
      checklist_md: params[4] as string,
      status: "active",
      started_at: new Date(),
      completed_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    };
    store.push(row);
    return [row];
  }

  // ---- UPDATE agent_sessions SET ... WHERE "id" ----
  if (q.includes("update") && q.includes("agent_sessions") && q.includes("set")) {
    const id = params[params.length - 1] as number;
    const idx = store.findIndex((r) => r.id === id);
    if (idx === -1) return [];

    // The route builds dynamic SET clauses. We parse from the query which columns are being set.
    // Drizzle generates: UPDATE "agent_sessions" SET "col1" = $1, "col2" = $2 ... WHERE "id" = $N
    // Extract quoted column names from the SET clause
    const setMatch = query.match(/set\s+(.+?)\s+where/is);
    if (setMatch) {
      const setParts = setMatch[1].split(",").map((s) => s.trim());
      let pIdx = 0;
      for (const part of setParts) {
        const colMatch = part.match(/"(\w+)"/);
        if (!colMatch) { pIdx++; continue; }
        const col = colMatch[1];
        switch (col) {
          case "task":
            store[idx].task = params[pIdx] as string;
            break;
          case "session_type":
            store[idx].session_type = params[pIdx] as string;
            break;
          case "issue_number":
            store[idx].issue_number = params[pIdx] as number | null;
            break;
          case "checklist_md":
            store[idx].checklist_md = params[pIdx] as string;
            break;
          case "status":
            store[idx].status = params[pIdx] as string;
            break;
          case "completed_at":
            store[idx].completed_at = params[pIdx] as Date | null;
            break;
          case "updated_at":
            store[idx].updated_at = params[pIdx] as Date ?? new Date();
            break;
        }
        pIdx++;
      }
    }

    return [store[idx]];
  }

  // ---- SELECT from agent_sessions WHERE branch = $1 (by-branch lookup) ----
  if (
    q.includes("agent_sessions") &&
    q.includes("where") &&
    q.includes('"branch"')
  ) {
    const branch = params[0] as string;
    const matches = store
      .filter((r) => r.branch === branch)
      .sort((a, b) => b.started_at.getTime() - a.started_at.getTime());
    const limit = q.includes("limit") ? 1 : matches.length;
    return matches.slice(0, limit);
  }

  // ---- SELECT from agent_sessions WHERE id = $1 ----
  if (
    q.includes("agent_sessions") &&
    q.includes("where") &&
    q.includes('"id"')
  ) {
    const id = params[0] as number;
    return store.filter((r) => r.id === id);
  }

  // ---- SELECT from agent_sessions ORDER BY ... LIMIT ... (list all) ----
  if (
    q.includes("agent_sessions") &&
    !q.includes("where") &&
    q.includes("order by")
  ) {
    const limit = (params[0] as number) || 50;
    const sorted = [...store].sort(
      (a, b) => b.started_at.getTime() - a.started_at.getTime()
    );
    return sorted.slice(0, limit);
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

describe("Agent Sessions API", () => {
  let app: Hono;

  beforeEach(() => {
    resetStore();
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    app = createApp();
  });

  const sampleSession = {
    branch: "claude/issue-123-abc",
    task: "Fix widget rendering bug",
    sessionType: "bugfix",
    issueNumber: 123,
    checklistMd:
      "# Session Checklist\n\n- [ ] Read the issue\n- [ ] Fix the bug",
  };

  // ================================================================
  // POST / (create or upsert)
  // ================================================================

  describe("POST /api/agent-sessions", () => {
    it("creates a new session and returns 201", async () => {
      const res = await postJson(app, "/api/agent-sessions", sampleSession);
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe(1);
      expect(body.branch).toBe("claude/issue-123-abc");
      expect(body.task).toBe("Fix widget rendering bug");
      // Drizzle maps snake_case → camelCase
      expect(body.sessionType).toBe("bugfix");
      expect(body.issueNumber).toBe(123);
      expect(body.status).toBe("active");
    });

    it("upserts an existing active session for the same branch", async () => {
      await postJson(app, "/api/agent-sessions", sampleSession);

      const res = await postJson(app, "/api/agent-sessions", {
        ...sampleSession,
        task: "Updated task description",
        checklistMd: "# Updated checklist",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(1); // Same ID — updated, not duplicated
      expect(body.task).toBe("Updated task description");
    });

    it("creates a new session for the same branch if previous is completed", async () => {
      await postJson(app, "/api/agent-sessions", sampleSession);
      store[0].status = "completed";

      const res = await postJson(app, "/api/agent-sessions", {
        ...sampleSession,
        task: "Second session on same branch",
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe(2);
    });

    it("accepts null issueNumber", async () => {
      const res = await postJson(app, "/api/agent-sessions", {
        ...sampleSession,
        issueNumber: null,
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.issueNumber).toBeNull();
    });

    it("accepts omitted issueNumber (optional)", async () => {
      const { issueNumber, ...noIssue } = sampleSession;
      const res = await postJson(app, "/api/agent-sessions", noIssue);
      expect(res.status).toBe(201);
    });

    // -- Validation error cases --

    it("rejects missing branch", async () => {
      const { branch, ...noBranch } = sampleSession;
      const res = await postJson(app, "/api/agent-sessions", noBranch);
      expect(res.status).toBe(400);
    });

    it("rejects empty branch", async () => {
      const res = await postJson(app, "/api/agent-sessions", {
        ...sampleSession,
        branch: "",
      });
      expect(res.status).toBe(400);
    });

    it("rejects missing task", async () => {
      const { task, ...noTask } = sampleSession;
      const res = await postJson(app, "/api/agent-sessions", noTask);
      expect(res.status).toBe(400);
    });

    it("rejects invalid sessionType", async () => {
      const res = await postJson(app, "/api/agent-sessions", {
        ...sampleSession,
        sessionType: "invalid-type",
      });
      expect(res.status).toBe(400);
    });

    it("rejects missing checklistMd", async () => {
      const { checklistMd, ...noChecklist } = sampleSession;
      const res = await postJson(app, "/api/agent-sessions", noChecklist);
      expect(res.status).toBe(400);
    });

    it("rejects empty checklistMd", async () => {
      const res = await postJson(app, "/api/agent-sessions", {
        ...sampleSession,
        checklistMd: "",
      });
      expect(res.status).toBe(400);
    });

    it("rejects non-positive issueNumber", async () => {
      const res = await postJson(app, "/api/agent-sessions", {
        ...sampleSession,
        issueNumber: 0,
      });
      expect(res.status).toBe(400);
    });

    it("rejects negative issueNumber", async () => {
      const res = await postJson(app, "/api/agent-sessions", {
        ...sampleSession,
        issueNumber: -5,
      });
      expect(res.status).toBe(400);
    });

    it("rejects non-integer issueNumber", async () => {
      const res = await postJson(app, "/api/agent-sessions", {
        ...sampleSession,
        issueNumber: 1.5,
      });
      expect(res.status).toBe(400);
    });

    it("rejects invalid JSON body", async () => {
      const res = await app.request("/api/agent-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      });
      expect(res.status).toBe(400);
    });

    it("accepts all valid sessionType values", async () => {
      for (const t of [
        "content",
        "infrastructure",
        "bugfix",
        "refactor",
        "commands",
      ]) {
        resetStore();
        const res = await postJson(app, "/api/agent-sessions", {
          ...sampleSession,
          sessionType: t,
          branch: `claude/test-${t}`,
        });
        expect(res.status).toBe(201);
      }
    });

    it("rejects branch exceeding max length (500)", async () => {
      const res = await postJson(app, "/api/agent-sessions", {
        ...sampleSession,
        branch: "x".repeat(501),
      });
      expect(res.status).toBe(400);
    });

    it("rejects task exceeding max length (2000)", async () => {
      const res = await postJson(app, "/api/agent-sessions", {
        ...sampleSession,
        task: "x".repeat(2001),
      });
      expect(res.status).toBe(400);
    });
  });

  // ================================================================
  // GET /by-branch/:branch
  // ================================================================

  describe("GET /api/agent-sessions/by-branch/:branch", () => {
    it("returns the latest session for a branch", async () => {
      await postJson(app, "/api/agent-sessions", sampleSession);

      const res = await app.request(
        `/api/agent-sessions/by-branch/${encodeURIComponent(sampleSession.branch)}`
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.branch).toBe("claude/issue-123-abc");
      expect(body.id).toBe(1);
    });

    it("returns 404 for unknown branch", async () => {
      const res = await app.request(
        "/api/agent-sessions/by-branch/nonexistent-branch"
      );
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe("not_found");
    });

    it("handles URL-encoded branch names with slashes", async () => {
      await postJson(app, "/api/agent-sessions", sampleSession);

      const res = await app.request(
        `/api/agent-sessions/by-branch/${encodeURIComponent("claude/issue-123-abc")}`
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.branch).toBe("claude/issue-123-abc");
    });
  });

  // ================================================================
  // PATCH /:id
  // ================================================================

  describe("PATCH /api/agent-sessions/:id", () => {
    it("updates checklist markdown", async () => {
      await postJson(app, "/api/agent-sessions", sampleSession);

      const res = await patchJson(app, "/api/agent-sessions/1", {
        checklistMd: "# Updated\n\n- [x] Done",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.checklistMd).toBe("# Updated\n\n- [x] Done");
    });

    it("updates status to completed", async () => {
      await postJson(app, "/api/agent-sessions", sampleSession);

      const res = await patchJson(app, "/api/agent-sessions/1", {
        status: "completed",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("completed");
      expect(body.completedAt).not.toBeNull();
    });

    it("updates both checklist and status", async () => {
      await postJson(app, "/api/agent-sessions", sampleSession);

      const res = await patchJson(app, "/api/agent-sessions/1", {
        checklistMd: "# Final",
        status: "completed",
      });
      expect(res.status).toBe(200);
    });

    it("returns 404 for unknown session id", async () => {
      const res = await patchJson(app, "/api/agent-sessions/999", {
        status: "completed",
      });
      expect(res.status).toBe(404);
    });

    it("rejects non-numeric id", async () => {
      const res = await patchJson(app, "/api/agent-sessions/abc", {
        status: "completed",
      });
      expect(res.status).toBe(400);
    });

    it("rejects invalid status value", async () => {
      await postJson(app, "/api/agent-sessions", sampleSession);

      const res = await patchJson(app, "/api/agent-sessions/1", {
        status: "invalid",
      });
      expect(res.status).toBe(400);
    });

    it("rejects empty checklistMd", async () => {
      await postJson(app, "/api/agent-sessions", sampleSession);

      const res = await patchJson(app, "/api/agent-sessions/1", {
        checklistMd: "",
      });
      expect(res.status).toBe(400);
    });

    it("rejects empty body (no-op update)", async () => {
      await postJson(app, "/api/agent-sessions", sampleSession);

      const res = await patchJson(app, "/api/agent-sessions/1", {});
      expect(res.status).toBe(400);
    });

    it("rejects floating-point id", async () => {
      await postJson(app, "/api/agent-sessions", sampleSession);

      const res = await patchJson(app, "/api/agent-sessions/1.5", {
        status: "completed",
      });
      expect(res.status).toBe(400);
    });

    it("rejects invalid JSON body", async () => {
      await postJson(app, "/api/agent-sessions", sampleSession);

      const res = await app.request("/api/agent-sessions/1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      });
      expect(res.status).toBe(400);
    });
  });

  // ================================================================
  // GET / (list)
  // ================================================================

  describe("GET /api/agent-sessions", () => {
    it("returns empty sessions list", async () => {
      const res = await app.request("/api/agent-sessions");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.sessions).toHaveLength(0);
    });

    it("returns all created sessions", async () => {
      await postJson(app, "/api/agent-sessions", sampleSession);
      await postJson(app, "/api/agent-sessions", {
        ...sampleSession,
        branch: "claude/other-branch",
      });

      const res = await app.request("/api/agent-sessions");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.sessions).toHaveLength(2);
    });

    it("respects limit parameter", async () => {
      for (let i = 0; i < 5; i++) {
        await postJson(app, "/api/agent-sessions", {
          ...sampleSession,
          branch: `claude/branch-${i}`,
        });
      }

      const res = await app.request("/api/agent-sessions?limit=3");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.sessions).toHaveLength(3);
    });

    it("caps limit at 200", async () => {
      const res = await app.request("/api/agent-sessions?limit=999");
      expect(res.status).toBe(200);
    });
  });

  // ================================================================
  // Authentication
  // ================================================================

  describe("Authentication", () => {
    it("requires bearer token when API key is set", async () => {
      process.env.LONGTERMWIKI_SERVER_API_KEY = "test-secret";
      app = createApp();

      const res = await postJson(app, "/api/agent-sessions", sampleSession);
      expect(res.status).toBe(401);
    });

    it("accepts valid bearer token", async () => {
      process.env.LONGTERMWIKI_SERVER_API_KEY = "test-secret";
      app = createApp();

      const res = await app.request("/api/agent-sessions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-secret",
        },
        body: JSON.stringify(sampleSession),
      });
      expect(res.status).toBe(201);
    });

    it("rejects wrong bearer token", async () => {
      process.env.LONGTERMWIKI_SERVER_API_KEY = "test-secret";
      app = createApp();

      const res = await app.request("/api/agent-sessions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer wrong-token",
        },
        body: JSON.stringify(sampleSession),
      });
      expect(res.status).toBe(401);
    });
  });
});
