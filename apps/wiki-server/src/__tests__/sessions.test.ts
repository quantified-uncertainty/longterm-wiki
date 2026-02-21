import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { postJson } from "./test-utils.js";

// ---- In-memory stores simulating the sessions + session_pages tables ----

let nextSessionId = 1;
let sessionStore: Array<{
  id: number;
  date: string;
  branch: string | null;
  title: string;
  summary: string | null;
  model: string | null;
  duration: string | null;
  cost: string | null;
  pr_url: string | null;
  checks_yaml: string | null;
  issues_json: unknown;
  learnings_json: unknown;
  created_at: Date;
}> = [];

let sessionPageStore: Array<{
  session_id: number;
  page_id: string;
}> = [];

function resetStore() {
  sessionStore = [];
  sessionPageStore = [];
  nextSessionId = 1;
}

// ---- Shared extractColumns / createQueryResult (inline to avoid hoisting issues) ----

function extractColumns(query: string): (string | null)[] {
  const q = query.trim();
  let clauseMatch = q.match(/returning\s+(.+?)$/is);
  if (!clauseMatch) clauseMatch = q.match(/^select\s+(.+?)\s+from\s/is);
  if (!clauseMatch) return [];
  const clause = clauseMatch[1];
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of clause) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts.map((part) => {
    let d = 0;
    let lastTopLevel: string | null = null;
    let i = 0;
    while (i < part.length) {
      if (part[i] === "(") { d++; i++; }
      else if (part[i] === ")") { d--; i++; }
      else if (part[i] === '"' && d === 0) {
        const close = part.indexOf('"', i + 1);
        if (close > i) { lastTopLevel = part.substring(i + 1, close); i = close + 1; }
        else i++;
      } else i++;
    }
    return lastTopLevel;
  });
}

function createQueryResult(rows: unknown[], query: string): any {
  const promise = Promise.resolve(rows);
  return {
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
    [Symbol.toStringTag]: "Promise",
    count: rows.length,
    values: () => {
      const cols = extractColumns(query);
      const arrayRows = rows.map((row: any) => {
        if (cols.length > 0 && cols.some((c: any) => c !== null)) {
          return cols.map((col: any, i: number) => {
            if (col !== null) return row[col];
            return Object.values(row)[i];
          });
        }
        return Object.values(row);
      });
      return createQueryResult(arrayRows, query);
    },
  };
}

// ---- Mock the db module ----

vi.mock("../db.js", async () => {
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const schema = await import("../schema.js");

  function dispatch(query: string, params: unknown[]): unknown[] {
    const q = query.toLowerCase();
    // Debug: uncomment to see generated queries
    // console.log('DISPATCH:', q.substring(0, 200), '| params:', JSON.stringify(params).substring(0, 100));

    // ---- health check / entity_ids ----
    if (q.includes("count(*)") && q.includes("entity_ids")) {
      return [{ count: 0 }];
    }
    if (q.includes("last_value")) {
      return [{ last_value: 0, is_called: false }];
    }

    // ---- TRUNCATE ----
    if (q.includes("truncate")) {
      sessionStore = [];
      sessionPageStore = [];
      nextSessionId = 1;
      return [];
    }

    // ---- INSERT INTO sessions (not session_pages) ----
    if (q.includes("insert into") && q.includes('"sessions"') && !q.includes("session_pages")) {
      const row = {
        id: nextSessionId++,
        date: String(params[0]),
        branch: params[1] as string | null,
        title: params[2] as string,
        summary: params[3] as string | null,
        model: params[4] as string | null,
        duration: params[5] as string | null,
        cost: params[6] as string | null,
        pr_url: params[7] as string | null,
        checks_yaml: params[8] as string | null,
        issues_json: params[9] ?? null,
        learnings_json: params[10] ?? null,
        created_at: new Date(),
      };
      sessionStore.push(row);
      return [row];
    }

    // ---- INSERT INTO session_pages ----
    if (q.includes("insert into") && q.includes("session_pages")) {
      const row = {
        session_id: params[0] as number,
        page_id: params[1] as string,
      };
      sessionPageStore.push(row);
      return [row];
    }

    // ---- SELECT count(*) FROM sessions (no group by) ----
    if (q.includes("count(*)") && q.includes('"sessions"') && !q.includes("group by") && !q.includes("session_pages")) {
      return [{ count: sessionStore.length }];
    }

    // ---- SELECT count(*) FROM session_pages (no distinct) ----
    if (q.includes("count(*)") && q.includes("session_pages") && !q.includes("distinct")) {
      return [{ count: sessionPageStore.length }];
    }

    // ---- SELECT count(distinct page_id) FROM session_pages ----
    if (q.includes("count(distinct") && q.includes("session_pages")) {
      const unique = new Set(sessionPageStore.map((r) => r.page_id));
      return [{ page_id: unique.size }];
    }

    // ---- SELECT all FROM session_pages (no WHERE — page-changes endpoint) ----
    if (q.includes("session_pages") && q.includes("select") && !q.includes("where") && !q.includes("count") && !q.includes("insert")) {
      return [...sessionPageStore];
    }

    // ---- SELECT model, count FROM sessions GROUP BY model ----
    if (q.includes('"sessions"') && q.includes("group by") && q.includes('"model"')) {
      const counts: Record<string, number> = {};
      for (const s of sessionStore) {
        const m = s.model || "(null)";
        counts[m] = (counts[m] || 0) + 1;
      }
      return Object.entries(counts)
        .map(([model, count]) => ({ model: model === "(null)" ? null : model, count }))
        .sort((a, b) => b.count - a.count);
    }

    // ---- SELECT FROM session_pages WHERE session_id = ANY(($1, $2, ...)) ----
    if (q.includes("session_pages") && q.includes("any(")) {
      // Drizzle spreads array elements as $1, $2, ... — all params are individual IDs
      const ids = params.map(Number);
      return sessionPageStore.filter((r) => ids.includes(r.session_id));
    }

    // ---- SELECT FROM session_pages WHERE page_id = $1 ----
    if (q.includes("session_pages") && q.includes("where") && q.includes("page_id") && !q.includes("any(")) {
      const pageId = params[0] as string;
      return sessionPageStore.filter((r) => r.page_id === pageId);
    }

    // ---- SELECT FROM sessions WHERE id = ANY(($1, $2, ...)) ORDER BY ... ----
    if (q.includes('"sessions"') && q.includes("any(") && q.includes("order by")) {
      // Drizzle spreads array elements as $1, $2, ... — all params are individual IDs
      const ids = params.map(Number);
      return sessionStore
        .filter((s) => ids.includes(s.id))
        .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
    }

    // ---- SELECT ... FROM sessions ORDER BY ... LIMIT ... (paginated list) ----
    if (q.includes('"sessions"') && q.includes("order by") && q.includes("limit") && !q.includes("any(")) {
      const limit = (params[0] as number) || 100;
      const offset = (params[1] as number) || 0;
      const sorted = [...sessionStore].sort(
        (a, b) => b.date.localeCompare(a.date) || b.id - a.id
      );
      return sorted.slice(offset, offset + limit);
    }

    return [];
  }

  // Build the mock SQL client
  const mockSql: any = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("$").trim();
    const rows = dispatch(query, values);
    const result: any = [...rows];
    result.count = rows.length;
    return result;
  };

  mockSql.unsafe = (query: string, params: unknown[] = []) => {
    return createQueryResult(dispatch(query, params), query);
  };

  mockSql.begin = async (fn: (tx: typeof mockSql) => Promise<any>) => {
    return await fn(mockSql);
  };

  mockSql.reserve = () => Promise.resolve(mockSql);
  mockSql.release = () => {};
  mockSql.options = { parsers: {}, serializers: {} };

  const mockDrizzle = drizzle(mockSql, { schema });
  return {
    getDb: () => mockSql,
    getDrizzleDb: () => mockDrizzle,
    initDb: vi.fn(),
    closeDb: vi.fn(),
  };
});

const { createApp } = await import("../app.js");

// ---- Tests ----

describe("Sessions API", () => {
  let app: Hono;

  beforeEach(() => {
    resetStore();
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    app = createApp();
  });

  describe("POST /api/sessions", () => {
    it("creates a session and returns 201", async () => {
      const res = await postJson(app, "/api/sessions", {
        date: "2026-02-20",
        branch: "claude/fix-something-AbC12",
        title: "Fix something important",
        summary: "Fixed a bug in the widget",
        model: "opus-4-6",
        pages: ["ai-risks", "existential-risk"],
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe(1);
      expect(body.title).toBe("Fix something important");
      expect(body.pages).toEqual(["ai-risks", "existential-risk"]);
    });

    it("creates a session without pages", async () => {
      const res = await postJson(app, "/api/sessions", {
        date: "2026-02-20",
        title: "Infrastructure-only session",
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.pages).toEqual([]);
    });

    it("rejects invalid date format", async () => {
      const res = await postJson(app, "/api/sessions", {
        date: "Feb 20, 2026",
        title: "Bad date",
      });
      expect(res.status).toBe(400);
    });

    it("rejects missing title", async () => {
      const res = await postJson(app, "/api/sessions", {
        date: "2026-02-20",
      });
      expect(res.status).toBe(400);
    });

    it("accepts all optional fields", async () => {
      const res = await postJson(app, "/api/sessions", {
        date: "2026-02-20",
        branch: "claude/issue-42-abc",
        title: "Full session",
        summary: "Did everything",
        model: "opus-4-6",
        duration: "~45min",
        cost: "~$5",
        prUrl: "https://github.com/test/repo/pull/42",
        checksYaml: '{"initialized": true}',
        issuesJson: ["some issue"],
        learningsJson: ["learned a thing"],
        pages: ["page-a"],
      });
      expect(res.status).toBe(201);
    });
  });

  describe("POST /api/sessions/batch", () => {
    it("inserts multiple sessions", async () => {
      const res = await postJson(app, "/api/sessions/batch", {
        items: [
          {
            date: "2026-02-19",
            title: "Session 1",
            pages: ["page-a"],
          },
          {
            date: "2026-02-20",
            title: "Session 2",
            pages: ["page-b", "page-c"],
          },
        ],
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.inserted).toBe(2);
      expect(body.results).toHaveLength(2);
      expect(body.results[0].pageCount).toBe(1);
      expect(body.results[1].pageCount).toBe(2);
    });

    it("rejects empty batch", async () => {
      const res = await postJson(app, "/api/sessions/batch", {
        items: [],
      });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/sessions", () => {
    it("returns paginated sessions", async () => {
      for (let i = 0; i < 3; i++) {
        await postJson(app, "/api/sessions", {
          date: `2026-02-${String(18 + i).padStart(2, "0")}`,
          title: `Session ${i}`,
          pages: [`page-${i}`],
        });
      }

      const res = await app.request("/api/sessions?limit=2&offset=0");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.sessions).toHaveLength(2);
      expect(body.total).toBe(3);
      expect(body.limit).toBe(2);
      expect(body.offset).toBe(0);
    });
  });

  describe("GET /api/sessions/by-page", () => {
    it("returns sessions for a specific page", async () => {
      await postJson(app, "/api/sessions", {
        date: "2026-02-18",
        title: "Session A",
        pages: ["ai-risks", "existential-risk"],
      });
      await postJson(app, "/api/sessions", {
        date: "2026-02-19",
        title: "Session B",
        pages: ["ai-risks"],
      });
      await postJson(app, "/api/sessions", {
        date: "2026-02-20",
        title: "Session C",
        pages: ["other-page"],
      });

      const res = await app.request("/api/sessions/by-page?page_id=ai-risks");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.sessions).toHaveLength(2);
    });

    it("returns empty for unknown page", async () => {
      const res = await app.request("/api/sessions/by-page?page_id=nonexistent");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.sessions).toHaveLength(0);
    });

    it("returns 400 without page_id parameter", async () => {
      const res = await app.request("/api/sessions/by-page");
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/sessions/stats", () => {
    it("returns aggregate statistics", async () => {
      await postJson(app, "/api/sessions", {
        date: "2026-02-18",
        title: "Session 1",
        model: "opus-4-6",
        pages: ["page-a", "page-b"],
      });
      await postJson(app, "/api/sessions", {
        date: "2026-02-19",
        title: "Session 2",
        model: "sonnet-4",
        pages: ["page-a"],
      });

      const res = await app.request("/api/sessions/stats");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.totalSessions).toBe(2);
      expect(body.uniquePages).toBe(2);
      expect(body.totalPageEdits).toBe(3);
      expect(body.byModel["opus-4-6"]).toBe(1);
      expect(body.byModel["sonnet-4"]).toBe(1);
    });

    it("returns zeros when no sessions exist", async () => {
      const res = await app.request("/api/sessions/stats");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.totalSessions).toBe(0);
      expect(body.uniquePages).toBe(0);
      expect(body.totalPageEdits).toBe(0);
    });
  });

  describe("GET /api/sessions/page-changes", () => {
    it("returns sessions with page associations", async () => {
      await postJson(app, "/api/sessions", {
        date: "2026-02-18",
        title: "Session with pages",
        pages: ["page-a", "page-b"],
      });
      await postJson(app, "/api/sessions", {
        date: "2026-02-19",
        title: "Infrastructure only",
        pages: [],
      });

      const res = await app.request("/api/sessions/page-changes");
      expect(res.status).toBe(200);
      const body = await res.json();
      // Only the session with pages should appear
      expect(body.sessions).toHaveLength(1);
      expect(body.sessions[0].title).toBe("Session with pages");
      expect(body.sessions[0].pages).toEqual(["page-a", "page-b"]);
    });

    it("returns empty when no sessions have pages", async () => {
      await postJson(app, "/api/sessions", {
        date: "2026-02-19",
        title: "No pages",
        pages: [],
      });

      const res = await app.request("/api/sessions/page-changes");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.sessions).toHaveLength(0);
    });
  });
});
