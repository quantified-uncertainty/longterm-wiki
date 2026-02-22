import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// ---- In-memory store simulating the edit_logs table ----

let nextId = 1;
let editStore: Array<{
  id: number;
  page_id: string;
  date: string;
  tool: string;
  agency: string;
  requested_by: string | null;
  note: string | null;
  created_at: Date;
}>;

function resetStore() {
  editStore = [];
  nextId = 1;
}

/**
 * Extract column names from SELECT or RETURNING clauses in Drizzle-generated SQL.
 */
function extractColumns(query: string): (string | null)[] {
  const q = query.trim();

  let clauseMatch = q.match(/returning\s+(.+?)$/is);
  if (!clauseMatch) {
    clauseMatch = q.match(/^select\s+(.+?)\s+from\s/is);
  }
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
    const matches = [...part.matchAll(/"([^"]+)"/g)];
    if (matches.length > 0) {
      return matches[matches.length - 1][1];
    }
    return null;
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
        if (cols.length > 0 && cols.some((c) => c !== null)) {
          return cols.map((col, i) => {
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

function createMockSql() {
  function dispatch(query: string, params: unknown[]): unknown[] {
    const q = query.toLowerCase();

    // ---- entity_ids (for health check) ----
    if (q.includes("count(*)") && q.includes("entity_ids")) {
      return [{ count: 0 }];
    }
    if (q.includes("last_value")) {
      return [{ last_value: 0, is_called: false }];
    }

    // ---- TRUNCATE ----
    if (q.includes("truncate")) {
      editStore = [];
      nextId = 1;
      return [];
    }

    // ---- INSERT INTO edit_logs (supports multi-row) ----
    if (q.includes("insert into") && q.includes("edit_logs")) {
      // Drizzle sends positional params: page_id, date, tool, agency, requested_by, note per row
      const COLS = 6;
      const numRows = params.length / COLS;
      const rows = [];
      for (let i = 0; i < numRows; i++) {
        const o = i * COLS;
        const row = {
          id: nextId++,
          page_id: params[o] as string,
          date: String(params[o + 1]),
          tool: params[o + 2] as string,
          agency: params[o + 3] as string,
          requested_by: (params[o + 4] as string) ?? null,
          note: (params[o + 5] as string) ?? null,
          created_at: new Date(),
        };
        editStore.push(row);
        rows.push(row);
      }
      return rows;
    }

    // ---- SELECT count(distinct page_id) FROM edit_logs ----
    // Must come before the general count(*) check.
    // Key is "page_id" because extractColumns finds the last quoted identifier
    // inside `count(distinct "edit_logs"."page_id")` as "page_id".
    if (q.includes("count(distinct") && q.includes("page_id") && q.includes("edit_logs")) {
      const uniquePages = new Set(editStore.map((e) => e.page_id));
      return [{ page_id: uniquePages.size }];
    }

    // ---- SELECT count(*) FROM edit_logs (not GROUP BY) ----
    if (q.includes("count(*)") && q.includes("edit_logs") && !q.includes("group by")) {
      let filtered = editStore;
      if (params.length > 0 && typeof params[0] === "string") {
        filtered = filtered.filter((e) => e.date >= (params[0] as string));
      }
      return [{ count: filtered.length }];
    }

    // ---- SELECT tool, count FROM edit_logs GROUP BY tool ----
    if (q.includes("edit_logs") && q.includes("group by") && q.includes('"tool"')) {
      const counts: Record<string, number> = {};
      for (const e of editStore) {
        counts[e.tool] = (counts[e.tool] || 0) + 1;
      }
      return Object.entries(counts)
        .map(([tool, count]) => ({ tool, count }))
        .sort((a, b) => b.count - a.count);
    }

    // ---- SELECT agency, count FROM edit_logs GROUP BY agency ----
    if (q.includes("edit_logs") && q.includes("group by") && q.includes('"agency"')) {
      const counts: Record<string, number> = {};
      for (const e of editStore) {
        counts[e.agency] = (counts[e.agency] || 0) + 1;
      }
      return Object.entries(counts)
        .map(([agency, count]) => ({ agency, count }))
        .sort((a, b) => b.count - a.count);
    }

    // ---- SELECT ... WHERE page_id = $1 ORDER BY date, id ----
    // Exclude queries with LIMIT (those are the paginated /all endpoint)
    if (q.includes("edit_logs") && q.includes("where") && q.includes("page_id") && !q.includes("limit")) {
      const pageId = params[0] as string;
      return editStore
        .filter((e) => e.page_id === pageId)
        .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
    }

    // ---- SELECT ... ORDER BY ... LIMIT ... (all entries, paginated) ----
    if (q.includes("edit_logs") && q.includes("order by") && q.includes("limit")) {
      let filtered = [...editStore];
      let paramIdx = 0;

      // Handle optional since filter (first param is a date string)
      if (params.length > 0 && typeof params[0] === "string") {
        const since = params[0] as string;
        filtered = filtered.filter((e) => e.date >= since);
        paramIdx = 1;
      }

      filtered.sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);

      const limit = (params[paramIdx] as number) || 100;
      const offset = (params[paramIdx + 1] as number) || 0;
      return filtered.slice(offset, offset + limit);
    }

    return [];
  }

  const mockSql: any = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("$").trim();
    return dispatch(query, values);
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

  return mockSql;
}

// Mock the db module before importing routes
vi.mock("../db.js", async () => {
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const schema = await import("../schema.js");
  const mockSql = createMockSql();
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

describe("Edit Logs API", () => {
  let app: Hono;

  beforeEach(() => {
    resetStore();
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    app = createApp();
  });

  describe("POST /api/edit-logs", () => {
    it("appends a single entry and returns 201", async () => {
      const res = await app.request("/api/edit-logs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pageId: "open-philanthropy",
          date: "2026-02-20",
          tool: "crux-improve",
          agency: "ai-directed",
          requestedBy: "ozzie",
          note: "Added 2024 funding data",
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe(1);
      expect(body.pageId).toBe("open-philanthropy");
    });

    it("rejects invalid date format", async () => {
      const res = await app.request("/api/edit-logs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pageId: "test-page",
          date: "Feb 20, 2026",
          tool: "manual",
          agency: "human",
        }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects missing required fields", async () => {
      const res = await app.request("/api/edit-logs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pageId: "test-page",
          date: "2026-02-20",
        }),
      });
      expect(res.status).toBe(400);
    });

    it("accepts entries without optional fields", async () => {
      const res = await app.request("/api/edit-logs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pageId: "test-page",
          date: "2026-02-20",
          tool: "crux-fix",
          agency: "automated",
        }),
      });
      expect(res.status).toBe(201);
    });
  });

  describe("POST /api/edit-logs/batch", () => {
    it("inserts multiple entries", async () => {
      const res = await app.request("/api/edit-logs/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [
            {
              pageId: "page-a",
              date: "2026-02-19",
              tool: "crux-create",
              agency: "ai-directed",
            },
            {
              pageId: "page-b",
              date: "2026-02-20",
              tool: "crux-fix",
              agency: "automated",
            },
          ],
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.inserted).toBe(2);
      expect(body.results).toHaveLength(2);
    });

    it("rejects empty batch", async () => {
      const res = await app.request("/api/edit-logs/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [] }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/edit-logs?page_id=X", () => {
    it("returns entries for a specific page", async () => {
      // Insert some entries
      for (const entry of [
        { pageId: "my-page", date: "2026-02-18", tool: "crux-create", agency: "ai-directed" },
        { pageId: "my-page", date: "2026-02-19", tool: "crux-improve", agency: "ai-directed" },
        { pageId: "other-page", date: "2026-02-20", tool: "crux-fix", agency: "automated" },
      ]) {
        await app.request("/api/edit-logs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(entry),
        });
      }

      const res = await app.request("/api/edit-logs?page_id=my-page");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.entries).toHaveLength(2);
      expect(body.entries[0].tool).toBe("crux-create");
      expect(body.entries[1].tool).toBe("crux-improve");
    });

    it("returns empty array for unknown page", async () => {
      const res = await app.request("/api/edit-logs?page_id=nonexistent");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.entries).toHaveLength(0);
    });

    it("returns 400 without page_id parameter", async () => {
      const res = await app.request("/api/edit-logs");
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/edit-logs/stats", () => {
    it("returns aggregate statistics", async () => {
      for (const entry of [
        { pageId: "page-a", date: "2026-02-18", tool: "crux-create", agency: "ai-directed" },
        { pageId: "page-a", date: "2026-02-19", tool: "crux-improve", agency: "ai-directed" },
        { pageId: "page-b", date: "2026-02-20", tool: "crux-fix", agency: "automated" },
      ]) {
        await app.request("/api/edit-logs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(entry),
        });
      }

      const res = await app.request("/api/edit-logs/stats");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.totalEntries).toBe(3);
      expect(body.pagesWithLogs).toBe(2);
      expect(body.byTool["crux-create"]).toBe(1);
      expect(body.byTool["crux-improve"]).toBe(1);
      expect(body.byTool["crux-fix"]).toBe(1);
      expect(body.byAgency["ai-directed"]).toBe(2);
      expect(body.byAgency["automated"]).toBe(1);
    });

    it("returns zeros when no entries exist", async () => {
      const res = await app.request("/api/edit-logs/stats");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.totalEntries).toBe(0);
      expect(body.pagesWithLogs).toBe(0);
    });
  });

  describe("GET /api/edit-logs/all", () => {
    it("returns paginated entries", async () => {
      for (let i = 0; i < 5; i++) {
        await app.request("/api/edit-logs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pageId: `page-${i}`,
            date: `2026-02-${String(15 + i).padStart(2, "0")}`,
            tool: "crux-fix",
            agency: "automated",
          }),
        });
      }

      const res = await app.request("/api/edit-logs/all?limit=2&offset=0");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.entries).toHaveLength(2);
      expect(body.total).toBe(5);
      expect(body.limit).toBe(2);
      expect(body.offset).toBe(0);
    });

    it("filters entries by since parameter", async () => {
      const dates = ["2026-02-10", "2026-02-15", "2026-02-18", "2026-02-20", "2026-02-21"];
      for (let i = 0; i < dates.length; i++) {
        await app.request("/api/edit-logs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pageId: `page-${i}`,
            date: dates[i],
            tool: "crux-fix",
            agency: "automated",
          }),
        });
      }

      const res = await app.request("/api/edit-logs/all?since=2026-02-18");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.entries).toHaveLength(3);
      expect(body.total).toBe(3);
      // Should be sorted descending
      expect(body.entries[0].date).toBe("2026-02-21");
      expect(body.entries[2].date).toBe("2026-02-18");
    });
  });
});
