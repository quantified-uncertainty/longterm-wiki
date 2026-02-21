import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// ---- In-memory stores simulating Postgres tables ----

let pagesStore: Map<string, Record<string, unknown>>;

function resetStores() {
  pagesStore = new Map();
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
    let d = 0;
    let lastTopLevel: string | null = null;
    let i = 0;
    while (i < part.length) {
      if (part[i] === "(") { d++; i++; }
      else if (part[i] === ")") { d--; i++; }
      else if (part[i] === '"' && d === 0) {
        const close = part.indexOf('"', i + 1);
        if (close > i) {
          lastTopLevel = part.substring(i + 1, close);
          i = close + 1;
        } else { i++; }
      } else { i++; }
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
    // --- wiki_pages: INSERT ... ON CONFLICT DO UPDATE ---
    if (q.includes("insert into") && q.includes("wiki_pages")) {
      const now = new Date();
      const id = params[0] as string;
      const existing = pagesStore.get(id);

      const row: Record<string, unknown> = {
        id,
        numeric_id: params[1],
        title: params[2],
        description: params[3],
        llm_summary: params[4],
        category: params[5],
        subcategory: params[6],
        entity_type: params[7],
        tags: params[8],
        quality: params[9],
        reader_importance: params[10],
        hallucination_risk_level: params[11],
        hallucination_risk_score: params[12],
        content_plaintext: params[13],
        word_count: params[14],
        last_updated: params[15],
        content_format: params[16],
        synced_at: now,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };
      pagesStore.set(id, row);
      return [row];
    }

    // --- wiki_pages: SELECT with WHERE + OR (get by id or numeric_id) ---
    // Query: select ... from "wiki_pages" where ("wiki_pages"."id" = $1 or "wiki_pages"."numeric_id" = $2)
    if (q.includes("wiki_pages") && q.includes("where") && q.includes(" or ") && !q.includes("count(*)")) {
      const id = params[0] as string;
      const numericId = params[1] as string;
      const results: Record<string, unknown>[] = [];
      for (const row of pagesStore.values()) {
        if (row.id === id || row.numeric_id === numericId) {
          results.push(row);
        }
      }
      return results;
    }

    // --- wiki_pages: COUNT(*) with or without WHERE ---
    if (q.includes("count(*)") && q.includes("wiki_pages")) {
      if (q.includes("where")) {
        let count = 0;
        for (const row of pagesStore.values()) {
          if (params.length > 0) {
            if (row.category === params[0] || row.entity_type === params[0]) {
              count++;
            }
          }
        }
        return [{ count }];
      }
      return [{ count: pagesStore.size }];
    }

    // --- wiki_pages: SELECT ORDER BY LIMIT (paginated listing) ---
    // Query: select ... from "wiki_pages" order by ... limit $1
    if (q.includes("wiki_pages") && q.includes("order by") && q.includes("limit") && !q.includes("count(*)")) {
      const allRows = Array.from(pagesStore.values()).sort((a, b) =>
        (a.id as string).localeCompare(b.id as string)
      );

      let filtered = allRows;
      if (q.includes("where")) {
        const filterVal = params[0] as string;
        if (q.includes("category")) {
          filtered = allRows.filter((r) => r.category === filterVal);
        } else if (q.includes("entity_type")) {
          filtered = allRows.filter((r) => r.entity_type === filterVal);
        }
      }

      const limitIdx = q.includes("where") ? 1 : 0;
      const limit = (params[limitIdx] as number) || 50;
      const offset = (params[limitIdx + 1] as number) || 0;
      return filtered.slice(offset, offset + limit);
    }

    // --- wiki_pages: SELECT all (search index rebuild) ---
    // Query: select ... from "wiki_pages" (no WHERE, no ORDER BY, no LIMIT)
    if (q.includes("wiki_pages") && !q.includes("where") && !q.includes("order by") && !q.includes("count(*)") && !q.includes("insert") && !q.includes("update")) {
      return Array.from(pagesStore.values());
    }

    // --- entity_ids: COUNT (for health check) ---
    if (q.includes("count(*)") && !q.includes("wiki_pages")) {
      return [{ count: 0 }];
    }

    // --- sequence health check ---
    if (q.includes("last_value")) {
      return [{ last_value: 0, is_called: true }];
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

// Mock the db module
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

// ---- Helpers ----

function postJson(app: Hono, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function seedPage(
  app: Hono,
  id: string,
  title: string,
  opts: Record<string, unknown> = {}
) {
  return postJson(app, "/api/pages/sync", {
    pages: [
      {
        id,
        title,
        numericId: opts.numericId ?? `E${Math.floor(Math.random() * 1000)}`,
        description: opts.description ?? `Description of ${title}`,
        category: opts.category ?? "concept",
        entityType: opts.entityType ?? "concept",
        readerImportance: opts.readerImportance ?? 50,
        quality: opts.quality ?? 60,
        ...opts,
      },
    ],
  });
}

// ---- Tests ----

describe("Pages API", () => {
  let app: Hono;

  beforeEach(() => {
    resetStores();
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    app = createApp();
  });

  // ---- Sync ----

  describe("POST /api/pages/sync", () => {
    it("creates new pages", async () => {
      const res = await postJson(app, "/api/pages/sync", {
        pages: [
          {
            id: "anthropic",
            title: "Anthropic",
            numericId: "E42",
            description: "AI safety company",
            category: "organizations",
            entityType: "organization",
          },
          {
            id: "openai",
            title: "OpenAI",
            numericId: "E43",
            description: "AI research lab",
            category: "organizations",
            entityType: "organization",
          },
        ],
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(2);
      expect(body.totalIndexed).toBeGreaterThanOrEqual(0);
    });

    it("updates existing pages", async () => {
      await seedPage(app, "anthropic", "Anthropic");

      const res = await postJson(app, "/api/pages/sync", {
        pages: [
          {
            id: "anthropic",
            title: "Anthropic (Updated)",
            description: "Updated description",
          },
        ],
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(1);
    });

    it("rejects empty batch", async () => {
      const res = await postJson(app, "/api/pages/sync", { pages: [] });
      expect(res.status).toBe(400);
    });

    it("rejects invalid JSON", async () => {
      const res = await app.request("/api/pages/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("invalid_json");
    });

    it("rejects pages without title", async () => {
      const res = await postJson(app, "/api/pages/sync", {
        pages: [{ id: "no-title" }],
      });
      expect(res.status).toBe(400);
    });
  });

  // ---- Get by ID ----

  describe("GET /api/pages/:id", () => {
    it("returns page by slug", async () => {
      await seedPage(app, "anthropic", "Anthropic", {
        numericId: "E42",
        description: "AI safety company",
      });

      const res = await app.request("/api/pages/anthropic");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe("anthropic");
      expect(body.title).toBe("Anthropic");
      expect(body.numericId).toBe("E42");
    });

    it("returns page by numeric ID", async () => {
      await seedPage(app, "anthropic", "Anthropic", { numericId: "E42" });

      const res = await app.request("/api/pages/E42");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe("anthropic");
    });

    it("returns 404 for unknown page", async () => {
      const res = await app.request("/api/pages/nonexistent");
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe("not_found");
    });
  });

  // ---- Paginated listing ----

  describe("GET /api/pages", () => {
    it("returns paginated listing", async () => {
      await seedPage(app, "anthropic", "Anthropic");
      await seedPage(app, "openai", "OpenAI");
      await seedPage(app, "deepmind", "DeepMind");

      const res = await app.request("/api/pages?limit=2&offset=0");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pages).toHaveLength(2);
      expect(body.total).toBe(3);
      expect(body.limit).toBe(2);
      expect(body.offset).toBe(0);
    });

    it("returns empty list when no pages", async () => {
      const res = await app.request("/api/pages");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pages).toHaveLength(0);
      expect(body.total).toBe(0);
    });
  });

  // ---- Search ----

  describe("GET /api/pages/search", () => {
    it("returns search results", async () => {
      await seedPage(app, "anthropic", "Anthropic", {
        description: "AI safety company founded by Dario Amodei",
      });
      await seedPage(app, "openai", "OpenAI", {
        description: "AI research lab",
      });

      const res = await app.request(
        "/api/pages/search?q=anthropic"
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.query).toBe("anthropic");
      expect(body.results).toBeDefined();
      // MiniSearch results depend on index state
    });

    it("requires q parameter", async () => {
      const res = await app.request("/api/pages/search");
      expect(res.status).toBe(400);
    });

    it("returns empty results for no match", async () => {
      const res = await app.request(
        "/api/pages/search?q=nonexistentxyz"
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results).toHaveLength(0);
    });
  });

  // ---- Bearer auth ----

  describe("Bearer auth for pages routes", () => {
    it("rejects unauthenticated requests when API key is set", async () => {
      process.env.LONGTERMWIKI_SERVER_API_KEY = "test-key";
      const authedApp = createApp();

      const res = await authedApp.request("/api/pages");
      expect(res.status).toBe(401);

      delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    });

    it("accepts requests with correct token", async () => {
      process.env.LONGTERMWIKI_SERVER_API_KEY = "test-key";
      const authedApp = createApp();

      const res = await authedApp.request("/api/pages", {
        headers: { Authorization: "Bearer test-key" },
      });
      expect(res.status).toBe(200);

      delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    });
  });

  // ---- Health check includes totalPages ----

  describe("Health check", () => {
    it("includes totalPages and searchIndexed", async () => {
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.totalPages).toBeDefined();
      expect(body.searchIndexed).toBeDefined();
    });
  });
});
