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
  recommendations_json: unknown;
  created_at: Date;
}> = [];

let sessionPageStore: Array<{
  session_id: number;
  page_id: string;
  page_id_int: number | null;
}> = [];

let nextSlugIntId = 1000;
const slugIntIdMap = new Map<string, number>();

function getIntIdForSlug(slug: string): number {
  if (!slugIntIdMap.has(slug)) {
    slugIntIdMap.set(slug, nextSlugIntId++);
  }
  return slugIntIdMap.get(slug)!;
}

function resetStore() {
  sessionStore = [];
  sessionPageStore = [];
  nextSessionId = 1;
  nextSlugIntId = 1000;
  slugIntIdMap.clear();
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

    // ---- entity_ids: SELECT WHERE slug (for resolvePageIntId/resolvePageIntIds) ----
    if (q.includes("entity_ids") && q.includes("where") && q.includes("slug")) {
      return params.map((p) => ({ numeric_id: getIntIdForSlug(String(p)), slug: p }));
    }

    // ---- TRUNCATE ----
    if (q.includes("truncate")) {
      sessionStore = [];
      sessionPageStore = [];
      nextSessionId = 1;
      return [];
    }

    // ---- INSERT INTO sessions (upsert — ON CONFLICT DO UPDATE) ----
    if (q.includes("insert into") && q.includes('"sessions"') && !q.includes("session_pages")) {
      const incoming = {
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
        recommendations_json: params[11] ?? null,
      };

      // Check for conflict on (date, title)
      const existing = sessionStore.find(
        (s) => s.date === incoming.date && s.title === incoming.title
      );

      if (existing && q.includes("on conflict")) {
        // Update existing row
        Object.assign(existing, {
          branch: incoming.branch,
          summary: incoming.summary,
          model: incoming.model,
          duration: incoming.duration,
          cost: incoming.cost,
          pr_url: incoming.pr_url,
          checks_yaml: incoming.checks_yaml,
          issues_json: incoming.issues_json,
          learnings_json: incoming.learnings_json,
          recommendations_json: incoming.recommendations_json,
        });
        return [existing];
      }

      const row = {
        ...incoming,
        id: nextSessionId++,
        created_at: new Date(),
      };
      sessionStore.push(row);
      return [row];
    }

    // ---- DELETE FROM session_pages WHERE session_id = $1 ----
    if (q.includes("delete") && q.includes("session_pages")) {
      const sessionId = params[0] as number;
      sessionPageStore = sessionPageStore.filter(
        (r) => r.session_id !== sessionId
      );
      return [];
    }

    // ---- INSERT INTO session_pages (supports multi-row) ----
    if (q.includes("insert into") && q.includes("session_pages")) {
      const COLS = 3; // Phase 4a: session_id, page_id, page_id_int
      const numRows = params.length / COLS;
      const rows = [];
      for (let i = 0; i < numRows; i++) {
        const o = i * COLS;
        const row = {
          session_id: params[o] as number,
          page_id: params[o + 1] as string,
          page_id_int: params[o + 2] as number | null,
        };
        sessionPageStore.push(row);
        rows.push(row);
      }
      return rows;
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

    // ---- SELECT sessions.id, sessions.date FROM sessions INNER JOIN session_pages ... GROUP BY ... LIMIT (page-changes step 1) ----
    if (q.includes('"sessions"') && q.includes("session_pages") && q.includes("inner join") && q.includes("group by") && q.includes("limit")) {
      const sessionIdsWithPages = new Set(sessionPageStore.map((r) => r.session_id));
      let matched = sessionStore.filter((s) => sessionIdsWithPages.has(s.id));
      // Apply optional since filter: if first param looks like a date string, it's the since value
      const limitParam = params[params.length - 1] as number;
      if (params.length > 1 && typeof params[0] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(params[0] as string)) {
        const since = params[0] as string;
        matched = matched.filter((s) => s.date >= since);
      }
      const sorted = matched.sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
      return sorted.slice(0, limitParam ?? 500).map((s) => ({ id: s.id, date: s.date }));
    }

    // ---- SELECT all FROM session_pages (no WHERE — legacy fallback) ----
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

    // ---- SELECT FROM session_pages WHERE session_id IN ($1, $2, ...) ----
    if (q.includes("session_pages") && (q.includes("any(") || q.includes(" in ("))) {
      // Drizzle inArray spreads array elements as $1, $2, ... — all params are individual IDs
      const ids = params.map(Number);
      return sessionPageStore.filter((r) => ids.includes(r.session_id));
    }

    // ---- SELECT FROM session_pages WHERE page_id_int = $1 (Phase 4b) ----
    if (q.includes("session_pages") && q.includes("where") && q.includes("page_id_int") && !q.includes("any(") && !q.includes(" in (")) {
      const intId = params[0] as number;
      return sessionPageStore.filter((r) => r.page_id_int === intId);
    }

    // ---- SELECT FROM sessions WHERE id IN ($1, $2, ...) ORDER BY ... ----
    if (q.includes('"sessions"') && (q.includes("any(") || q.includes(" in (")) && q.includes("order by")) {
      // Drizzle inArray spreads array elements as $1, $2, ... — all params are individual IDs
      const ids = params.map(Number);
      return sessionStore
        .filter((s) => ids.includes(s.id))
        .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
    }

    // ---- SELECT date, branch, title, learnings_json, recommendations_json FROM sessions WHERE branch LIKE ... ORDER BY ... LIMIT (insights) ----
    // Insights query selects exactly 5 columns (no "id", no "summary") — distinguish from paginated list which selects all.
    if (q.includes('"sessions"') && q.includes("order by") && q.includes("limit") && q.includes('"learnings_json"') && q.includes('"recommendations_json"') && !q.includes('"summary"')) {
      let filtered = [...sessionStore];
      // Apply LIKE filter on branch if present
      if (q.includes("like") && params.length > 0) {
        const pattern = String(params[0]);
        // Convert SQL LIKE pattern to a simple prefix match (strip trailing %)
        const prefix = pattern.replace(/%$/, "").replace(/\\%/g, "%").replace(/\\_/g, "_");
        filtered = filtered.filter((s) => s.branch && s.branch.startsWith(prefix));
      }
      const sorted = filtered.sort(
        (a, b) => b.date.localeCompare(a.date) || b.id - a.id
      );
      return sorted.slice(0, 500);
    }

    // ---- SELECT ... FROM sessions ORDER BY ... LIMIT ... (paginated list) ----
    if (q.includes('"sessions"') && q.includes("order by") && q.includes("limit") && !q.includes("any(") && !q.includes(" in (")) {
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
      expect(body.upserted).toBe(2);
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

  describe("Upsert behavior (deduplication)", () => {
    it("updates existing session on same date+title (single)", async () => {
      // First insert
      const res1 = await postJson(app, "/api/sessions", {
        date: "2026-02-20",
        title: "My Session",
        summary: "Original summary",
        pages: ["page-a"],
      });
      expect(res1.status).toBe(201);
      const body1 = await res1.json();
      const originalId = body1.id;

      // Same date+title should update, not duplicate
      const res2 = await postJson(app, "/api/sessions", {
        date: "2026-02-20",
        title: "My Session",
        summary: "Updated summary",
        model: "opus-4-6",
        pages: ["page-a", "page-b"],
      });
      expect(res2.status).toBe(201);
      const body2 = await res2.json();
      expect(body2.id).toBe(originalId);
      expect(body2.pages).toEqual(["page-a", "page-b"]);

      // Total sessions should still be 1
      const listRes = await app.request("/api/sessions");
      const listBody = await listRes.json();
      expect(listBody.total).toBe(1);
    });

    it("updates existing sessions on batch re-sync", async () => {
      // Initial sync
      await postJson(app, "/api/sessions/batch", {
        items: [
          { date: "2026-02-19", title: "Session A", pages: ["page-1"] },
          { date: "2026-02-20", title: "Session B", pages: ["page-2"] },
        ],
      });

      // Re-sync same sessions (should update, not duplicate)
      const res = await postJson(app, "/api/sessions/batch", {
        items: [
          { date: "2026-02-19", title: "Session A", summary: "Updated A", pages: ["page-1", "page-3"] },
          { date: "2026-02-20", title: "Session B", summary: "Updated B", pages: ["page-2"] },
        ],
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.upserted).toBe(2);

      // Total sessions should still be 2
      const listRes = await app.request("/api/sessions");
      const listBody = await listRes.json();
      expect(listBody.total).toBe(2);
    });

    it("different titles on same date create separate sessions", async () => {
      await postJson(app, "/api/sessions", {
        date: "2026-02-20",
        title: "Session A",
        pages: [],
      });
      await postJson(app, "/api/sessions", {
        date: "2026-02-20",
        title: "Session B",
        pages: [],
      });

      const listRes = await app.request("/api/sessions");
      const listBody = await listRes.json();
      expect(listBody.total).toBe(2);
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

  // ---------------------------------------------------------------------------
  // Insights endpoint
  // ---------------------------------------------------------------------------

  describe("GET /api/sessions/insights", () => {
    it("returns all insights when no branch_prefix filter", async () => {
      await postJson(app, "/api/sessions", {
        date: "2026-02-20",
        branch: "claude/feature-abc",
        title: "Feature session",
        learningsJson: ["Learned X", "Learned Y"],
        recommendationsJson: ["Do A"],
      });

      const res = await app.request("/api/sessions/insights");
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.insights).toHaveLength(3);
      expect(body.summary.total).toBe(3);
      expect(body.summary.byType.learning).toBe(2);
      expect(body.summary.byType.recommendation).toBe(1);
    });

    it("returns correct insight shape", async () => {
      await postJson(app, "/api/sessions", {
        date: "2026-02-20",
        branch: "claude/test",
        title: "Test Session",
        learningsJson: ["Important learning"],
      });

      const res = await app.request("/api/sessions/insights");
      const body = await res.json();

      const insight = body.insights[0];
      expect(insight).toEqual({
        date: "2026-02-20",
        branch: "claude/test",
        title: "Test Session",
        type: "learning",
        text: "Important learning",
      });
    });

    it("filters by branch_prefix", async () => {
      await postJson(app, "/api/sessions", {
        date: "2026-02-18",
        branch: "claude/claims-extract",
        title: "Claims session",
        learningsJson: ["Claims insight"],
      });
      await postJson(app, "/api/sessions", {
        date: "2026-02-19",
        branch: "claude/bugfix-xyz",
        title: "Bugfix session",
        learningsJson: ["Bugfix insight"],
      });

      const res = await app.request(
        "/api/sessions/insights?branch_prefix=claude/claims"
      );
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.insights).toHaveLength(1);
      expect(body.insights[0].text).toBe("Claims insight");
      expect(body.insights[0].branch).toBe("claude/claims-extract");
    });

    it("returns empty when no insights match filter", async () => {
      await postJson(app, "/api/sessions", {
        date: "2026-02-20",
        branch: "claude/feature",
        title: "Session",
        learningsJson: ["Something"],
      });

      const res = await app.request(
        "/api/sessions/insights?branch_prefix=claude/nonexistent"
      );
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.insights).toEqual([]);
      expect(body.summary.total).toBe(0);
      expect(body.summary.byType).toEqual({});
    });

    it("returns empty when sessions have no learnings or recommendations", async () => {
      await postJson(app, "/api/sessions", {
        date: "2026-02-20",
        title: "Minimal session",
      });

      const res = await app.request("/api/sessions/insights");
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.insights).toHaveLength(0);
      expect(body.summary.total).toBe(0);
    });

    it("handles sessions with only learnings (no recommendations)", async () => {
      await postJson(app, "/api/sessions", {
        date: "2026-02-20",
        title: "Learnings only",
        learningsJson: ["Just a learning"],
      });

      const res = await app.request("/api/sessions/insights");
      const body = await res.json();

      expect(body.insights).toHaveLength(1);
      expect(body.insights[0].type).toBe("learning");
      expect(body.summary.byType.recommendation).toBeUndefined();
    });

    it("handles sessions with only recommendations (no learnings)", async () => {
      await postJson(app, "/api/sessions", {
        date: "2026-02-20",
        title: "Recommendations only",
        recommendationsJson: ["Do this thing"],
      });

      const res = await app.request("/api/sessions/insights");
      const body = await res.json();

      expect(body.insights).toHaveLength(1);
      expect(body.insights[0].type).toBe("recommendation");
      expect(body.summary.byType.learning).toBeUndefined();
    });

    it("aggregates insights across multiple sessions", async () => {
      await postJson(app, "/api/sessions", {
        date: "2026-02-18",
        branch: "claude/a",
        title: "Session A",
        learningsJson: ["L1"],
        recommendationsJson: ["R1", "R2"],
      });
      await postJson(app, "/api/sessions", {
        date: "2026-02-19",
        branch: "claude/b",
        title: "Session B",
        learningsJson: ["L2", "L3"],
      });
      await postJson(app, "/api/sessions", {
        date: "2026-02-20",
        branch: "claude/c",
        title: "Session C",
        recommendationsJson: ["R3"],
      });

      const res = await app.request("/api/sessions/insights");
      const body = await res.json();

      expect(body.insights).toHaveLength(6);
      expect(body.summary.total).toBe(6);
      expect(body.summary.byType.learning).toBe(3);
      expect(body.summary.byType.recommendation).toBe(3);
    });

    it("returns insights ordered by date descending", async () => {
      await postJson(app, "/api/sessions", {
        date: "2026-02-15",
        title: "Older",
        learningsJson: ["Old insight"],
      });
      await postJson(app, "/api/sessions", {
        date: "2026-02-25",
        title: "Newer",
        learningsJson: ["New insight"],
      });

      const res = await app.request("/api/sessions/insights");
      const body = await res.json();

      // Newer session's insights should come first
      expect(body.insights[0].date).toBe("2026-02-25");
      expect(body.insights[1].date).toBe("2026-02-15");
    });
  });
});
