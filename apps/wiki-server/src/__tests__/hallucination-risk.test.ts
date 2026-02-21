import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// ---- In-memory store simulating the hallucination_risk_snapshots table ----

let nextId = 1;
let riskStore: Array<{
  id: number;
  page_id: string;
  score: number;
  level: string;
  factors: string[] | null;
  integrity_issues: string[] | null;
  computed_at: Date;
}>;

function resetStore() {
  riskStore = [];
  nextId = 1;
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

    // ---- INSERT INTO hallucination_risk_snapshots ----
    if (q.includes("insert into") && q.includes("hallucination_risk_snapshots")) {
      const row = {
        id: nextId++,
        page_id: params[0] as string,
        score: params[1] as number,
        level: params[2] as string,
        factors: params[3] as string[] | null,
        integrity_issues: params[4] as string[] | null,
        computed_at: new Date(),
      };
      riskStore.push(row);
      return [row];
    }

    // ---- SELECT count(distinct page_id) FROM hallucination_risk_snapshots ----
    if (q.includes("count(distinct") && q.includes("page_id") && q.includes("hallucination_risk_snapshots")) {
      const uniquePages = new Set(riskStore.map((e) => e.page_id));
      return [{ page_id: uniquePages.size }];
    }

    // ---- SELECT count(*) FROM hallucination_risk_snapshots (not GROUP BY) ----
    if (q.includes("count(*)") && q.includes("hallucination_risk_snapshots") && !q.includes("group by")) {
      return [{ count: riskStore.length }];
    }

    // ---- SELECT level, count FROM hallucination_risk_snapshots GROUP BY level ----
    if (q.includes("hallucination_risk_snapshots") && q.includes("group by") && q.includes('"level"')) {
      // This is for stats — latest snapshot per page
      // Simplified: just group all entries by level
      const latestByPage = new Map<string, typeof riskStore[0]>();
      for (const r of riskStore) {
        const existing = latestByPage.get(r.page_id);
        if (!existing || r.computed_at > existing.computed_at) {
          latestByPage.set(r.page_id, r);
        }
      }
      const counts: Record<string, number> = {};
      for (const r of latestByPage.values()) {
        counts[r.level] = (counts[r.level] || 0) + 1;
      }
      return Object.entries(counts)
        .map(([level, count]) => ({ level, count }))
        .sort((a, b) => b.count - a.count);
    }

    // ---- SELECT ... WHERE page_id = $1 ORDER BY computed_at DESC LIMIT ----
    if (q.includes("hallucination_risk_snapshots") && q.includes("where") && q.includes("page_id") && !q.includes("in (")) {
      const pageId = params[0] as string;
      const limit = params[1] as number || 50;
      return riskStore
        .filter((e) => e.page_id === pageId)
        .sort((a, b) => b.computed_at.getTime() - a.computed_at.getTime())
        .slice(0, limit);
    }

    // ---- SELECT ... (latest per page, for /latest endpoint) ORDER BY score DESC ----
    if (q.includes("hallucination_risk_snapshots") && q.includes("in (") && q.includes("order by")) {
      const latestByPage = new Map<string, typeof riskStore[0]>();
      for (const r of riskStore) {
        const existing = latestByPage.get(r.page_id);
        if (!existing || r.computed_at > existing.computed_at) {
          latestByPage.set(r.page_id, r);
        }
      }
      let results = [...latestByPage.values()];

      // Check for level filter
      const levelParamIndex = params.findIndex(
        (p) => p === "high" || p === "medium" || p === "low"
      );
      if (levelParamIndex >= 0) {
        const level = params[levelParamIndex] as string;
        results = results.filter((r) => r.level === level);
      }

      results.sort((a, b) => b.score - a.score);
      const limit = (params.find((p) => typeof p === "number" && p <= 200) as number) || 50;
      const offset = (params.find((p, i) => typeof p === "number" && i > 0 && p !== limit) as number) || 0;
      return results.slice(offset, offset + limit);
    }

    return [];
  }

  const mockSql: any = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("$").trim();
    return dispatch(query, values);
  };

  // ---- Shared helpers ----

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
      else if (ch === "," && depth === 0) { parts.push(current.trim()); current = ""; continue; }
      current += ch;
    }
    if (current.trim()) parts.push(current.trim());
    return parts.map((part) => {
      const matches = [...part.matchAll(/"([^"]+)"/g)];
      return matches.length > 0 ? matches[matches.length - 1][1] : null;
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
            return cols.map((col, i) => col !== null ? row[col] : Object.values(row)[i]);
          }
          return Object.values(row);
        });
        return createQueryResult(arrayRows, query);
      },
    };
  }

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

describe("Hallucination Risk API", () => {
  let app: Hono;

  beforeEach(() => {
    resetStore();
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    app = createApp();
  });

  describe("POST /api/hallucination-risk", () => {
    it("records a single snapshot and returns 201", async () => {
      const res = await app.request("/api/hallucination-risk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pageId: "open-philanthropy",
          score: 55,
          level: "medium",
          factors: ["biographical-claims", "low-citation-density"],
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe(1);
      expect(body.pageId).toBe("open-philanthropy");
      expect(body.score).toBe(55);
      expect(body.level).toBe("medium");
    });

    it("rejects invalid level", async () => {
      const res = await app.request("/api/hallucination-risk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pageId: "test",
          score: 50,
          level: "critical",
          factors: [],
        }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects score out of range", async () => {
      const res = await app.request("/api/hallucination-risk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pageId: "test",
          score: 150,
          level: "high",
        }),
      });
      expect(res.status).toBe(400);
    });

    it("accepts entries without optional fields", async () => {
      const res = await app.request("/api/hallucination-risk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pageId: "test-page",
          score: 30,
          level: "low",
        }),
      });
      expect(res.status).toBe(201);
    });
  });

  describe("POST /api/hallucination-risk/batch", () => {
    it("inserts multiple snapshots", async () => {
      const res = await app.request("/api/hallucination-risk/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          snapshots: [
            { pageId: "page-a", score: 70, level: "high", factors: ["no-citations"] },
            { pageId: "page-b", score: 25, level: "low", factors: ["well-cited"] },
          ],
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.inserted).toBe(2);
    });

    it("rejects empty batch", async () => {
      const res = await app.request("/api/hallucination-risk/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ snapshots: [] }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/hallucination-risk/history?page_id=X", () => {
    it("returns history for a page", async () => {
      // Insert some snapshots
      for (const entry of [
        { pageId: "my-page", score: 60, level: "medium", factors: ["no-citations"] },
        { pageId: "my-page", score: 45, level: "medium", factors: ["low-citation-density"] },
        { pageId: "other-page", score: 20, level: "low" },
      ]) {
        await app.request("/api/hallucination-risk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(entry),
        });
      }

      const res = await app.request("/api/hallucination-risk/history?page_id=my-page");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pageId).toBe("my-page");
      expect(body.snapshots).toHaveLength(2);
    });

    it("returns empty for unknown page", async () => {
      const res = await app.request("/api/hallucination-risk/history?page_id=nonexistent");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.snapshots).toHaveLength(0);
    });

    it("returns 400 without page_id", async () => {
      const res = await app.request("/api/hallucination-risk/history");
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/hallucination-risk/stats", () => {
    it("returns aggregate statistics", async () => {
      for (const entry of [
        { pageId: "page-a", score: 70, level: "high" },
        { pageId: "page-b", score: 25, level: "low" },
        { pageId: "page-c", score: 45, level: "medium" },
      ]) {
        await app.request("/api/hallucination-risk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(entry),
        });
      }

      const res = await app.request("/api/hallucination-risk/stats");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.totalSnapshots).toBe(3);
      expect(body.uniquePages).toBe(3);
    });

    it("returns zeros when no snapshots exist", async () => {
      const res = await app.request("/api/hallucination-risk/stats");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.totalSnapshots).toBe(0);
      expect(body.uniquePages).toBe(0);
    });
  });

  describe("GET /api/hallucination-risk/latest", () => {
    it("returns 200 with pages array", async () => {
      for (const entry of [
        { pageId: "page-a", score: 70, level: "high", factors: ["no-citations"] },
        { pageId: "page-b", score: 25, level: "low", factors: ["well-cited"] },
      ]) {
        await app.request("/api/hallucination-risk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(entry),
        });
      }

      const res = await app.request("/api/hallucination-risk/latest");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pages).toBeDefined();
      expect(Array.isArray(body.pages)).toBe(true);
    });
  });
});
