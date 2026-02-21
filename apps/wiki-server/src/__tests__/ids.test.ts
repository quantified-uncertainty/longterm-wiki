import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// ---- Mock the postgres module ----

// Track sequence state
let nextSeqVal = 886;
let lastSeqVal = 885;
let seqIsCalled = true;

// In-memory store simulating the entity_ids table
let store: Map<
  string,
  { numeric_id: number; slug: string; description: string | null; created_at: Date }
>;

function resetStore() {
  store = new Map();
  nextSeqVal = 886;
  lastSeqVal = 885;
  seqIsCalled = true;
}

/**
 * Extract column names from SELECT or RETURNING clauses in Drizzle-generated SQL.
 * Returns array of column names (snake_case) or null for expression positions.
 */
function extractColumns(query: string): (string | null)[] {
  const q = query.trim();

  // Try RETURNING first (at end of INSERT/UPDATE)
  let clauseMatch = q.match(/returning\s+(.+?)$/is);
  if (!clauseMatch) {
    // Try SELECT
    clauseMatch = q.match(/^select\s+(.+?)\s+from\s/is);
  }
  if (!clauseMatch) return [];

  const clause = clauseMatch[1];

  // Split by commas, respecting parentheses
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

  // Extract the last quoted identifier from each part
  return parts.map((part) => {
    const matches = [...part.matchAll(/"([^"]+)"/g)];
    if (matches.length > 0) {
      return matches[matches.length - 1][1];
    }
    return null; // expression without quoted name (e.g., count(*))
  });
}

/**
 * Create a thenable result that supports .values() for Drizzle's query builder.
 *
 * Drizzle's postgres-js adapter calls:
 * - client.unsafe(query, params) for raw SQL → expects row objects
 * - client.unsafe(query, params).values() for query builder → expects positional arrays
 */
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
            // Fallback for expressions without quoted names (like count(*))
            return Object.values(row)[i];
          });
        }
        return Object.values(row);
      });
      return createQueryResult(arrayRows, query);
    },
  };
}

/**
 * Mock SQL handler for Drizzle's `unsafe()` calls and raw tagged-template queries.
 * Drizzle generates SQL with quoted identifiers and $N placeholders.
 */
function createMockSql() {
  function dispatch(query: string, params: unknown[]): unknown[] {
    const q = query.toLowerCase();

    // SELECT COUNT(*)
    if (q.includes("count(*)") && q.includes("entity_ids")) {
      return [{ count: store.size }];
    }

    // SELECT COUNT(*) for wiki_pages (health check)
    if (q.includes("count(*)") && q.includes("wiki_pages")) {
      return [{ count: 0 }];
    }

    // SELECT last_value (sequence health check)
    if (q.includes("last_value")) {
      return [{ last_value: lastSeqVal, is_called: seqIsCalled }];
    }

    // INSERT INTO entity_ids ... ON CONFLICT ... DO NOTHING ... RETURNING
    if (q.includes("insert into") && q.includes("entity_ids") && q.includes("do nothing")) {
      const slug = params[0] as string;
      const description = (params[1] as string) ?? null;

      if (store.has(slug)) {
        return [];
      }

      const numeric_id = nextSeqVal++;
      lastSeqVal = numeric_id;
      const row = {
        numeric_id,
        slug,
        description,
        created_at: new Date(),
      };
      store.set(slug, row);
      return [row];
    }

    // SELECT ... WHERE ... slug = $1
    if (q.includes("entity_ids") && q.includes("where") && q.includes("slug")) {
      const slug = params[0] as string;
      const row = store.get(slug);
      return row ? [row] : [];
    }

    // SELECT ... ORDER BY ... LIMIT ... OFFSET
    if (q.includes("entity_ids") && q.includes("order by") && q.includes("limit")) {
      // Drizzle may send limit/offset as params or inline them
      // Drizzle omits OFFSET when 0, so params[1] may be undefined
      const limit = (params[0] as number) || 100;
      const offset = (params[1] as number) || 0;
      const all = Array.from(store.values()).sort(
        (a, b) => a.numeric_id - b.numeric_id
      );
      return all.slice(offset, offset + limit);
    }

    // setval
    if (q.includes("setval")) {
      const val = params[0] as number;
      lastSeqVal = val;
      nextSeqVal = val + 1;
      return [];
    }

    return [];
  }

  // Tagged-template handler (for raw SQL like health check sequence query)
  const mockSql: any = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("$").trim();
    return dispatch(query, values);
  };

  // Drizzle calls client.unsafe(query, params) for all query-builder operations.
  // The result must be a thenable with a .values() method that returns positional arrays.
  mockSql.unsafe = (query: string, params: unknown[] = []) => {
    return createQueryResult(dispatch(query, params), query);
  };

  // Transaction support: Drizzle calls client.begin(fn) with a transaction client
  mockSql.begin = async (fn: (tx: typeof mockSql) => Promise<any>) => {
    return await fn(mockSql);
  };

  // Reserve/release connection (drizzle internals)
  mockSql.reserve = () => Promise.resolve(mockSql);
  mockSql.release = () => {};

  // Drizzle's postgres-js driver reads client.options.parsers/serializers
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

// Now import the app (which imports routes that import db)
const { createApp } = await import("../app.js");

// ---- Tests ----

describe("ID Server API", () => {
  let app: Hono;

  beforeEach(() => {
    resetStore();
    // Re-create app (no API key set → unauthenticated mode for tests)
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    app = createApp();
  });

  describe("GET /health", () => {
    it("returns healthy status", async () => {
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("healthy");
      expect(body.database).toBe("ok");
      expect(typeof body.totalIds).toBe("number");
      expect(typeof body.uptime).toBe("number");
    });
  });

  describe("POST /api/ids/allocate", () => {
    it("allocates a new ID and returns 201", async () => {
      const res = await app.request("/api/ids/allocate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: "test-entity" }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.numericId).toBe("E886");
      expect(body.slug).toBe("test-entity");
      expect(body.created).toBe(true);
    });

    it("returns existing ID with 200 for duplicate slug", async () => {
      // First allocation
      await app.request("/api/ids/allocate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: "dup-entity" }),
      });

      // Second allocation — same slug
      const res = await app.request("/api/ids/allocate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: "dup-entity" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.numericId).toBe("E886");
      expect(body.created).toBe(false);
    });

    it("includes description when provided", async () => {
      const res = await app.request("/api/ids/allocate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: "described-entity",
          description: "A test entity",
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.description).toBe("A test entity");
    });

    it("rejects invalid slug", async () => {
      const res = await app.request("/api/ids/allocate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: "" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("validation_error");
    });

    it("assigns sequential IDs", async () => {
      const res1 = await app.request("/api/ids/allocate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: "entity-a" }),
      });
      const res2 = await app.request("/api/ids/allocate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: "entity-b" }),
      });

      const body1 = await res1.json();
      const body2 = await res2.json();
      expect(body1.numericId).toBe("E886");
      expect(body2.numericId).toBe("E887");
    });
  });

  describe("POST /api/ids/allocate-batch", () => {
    it("allocates multiple IDs in a batch", async () => {
      const res = await app.request("/api/ids/allocate-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [
            { slug: "batch-a" },
            { slug: "batch-b" },
            { slug: "batch-c" },
          ],
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results).toHaveLength(3);
      expect(body.results[0].numericId).toBe("E886");
      expect(body.results[1].numericId).toBe("E887");
      expect(body.results[2].numericId).toBe("E888");
      expect(body.results.every((r: { created: boolean }) => r.created)).toBe(true);
    });

    it("handles mixed new and existing slugs", async () => {
      // Pre-allocate one
      await app.request("/api/ids/allocate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: "existing-slug" }),
      });

      const res = await app.request("/api/ids/allocate-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [{ slug: "existing-slug" }, { slug: "new-slug" }],
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results).toHaveLength(2);
      expect(body.results[0].created).toBe(false);
      expect(body.results[1].created).toBe(true);
    });

    it("rejects empty batch", async () => {
      const res = await app.request("/api/ids/allocate-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [] }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/ids", () => {
    it("returns paginated list", async () => {
      // Create a few entries
      for (const slug of ["list-a", "list-b", "list-c"]) {
        await app.request("/api/ids/allocate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug }),
        });
      }

      const res = await app.request("/api/ids?limit=2&offset=0");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ids).toHaveLength(2);
      expect(body.total).toBe(3);
      expect(body.limit).toBe(2);
      expect(body.offset).toBe(0);
    });
  });

  describe("GET /api/ids/by-slug", () => {
    it("returns ID for existing slug", async () => {
      await app.request("/api/ids/allocate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: "lookup-me" }),
      });

      const res = await app.request("/api/ids/by-slug?slug=lookup-me");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.numericId).toBe("E886");
      expect(body.slug).toBe("lookup-me");
    });

    it("returns 404 for unknown slug", async () => {
      const res = await app.request("/api/ids/by-slug?slug=nonexistent");
      expect(res.status).toBe(404);
    });

    it("returns 400 when slug parameter is missing", async () => {
      const res = await app.request("/api/ids/by-slug");
      expect(res.status).toBe(400);
    });
  });

  describe("Bearer auth", () => {
    it("rejects requests without token when API key is set", async () => {
      process.env.LONGTERMWIKI_SERVER_API_KEY = "test-secret-key";
      const authedApp = createApp();

      const res = await authedApp.request("/api/ids/allocate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: "should-fail" }),
      });
      expect(res.status).toBe(401);

      delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    });

    it("accepts requests with correct token", async () => {
      process.env.LONGTERMWIKI_SERVER_API_KEY = "test-secret-key";
      const authedApp = createApp();

      const res = await authedApp.request("/api/ids/allocate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-secret-key",
        },
        body: JSON.stringify({ slug: "should-succeed" }),
      });
      expect(res.status).toBe(201);

      delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    });

    it("allows health check without token", async () => {
      process.env.LONGTERMWIKI_SERVER_API_KEY = "test-secret-key";
      const authedApp = createApp();

      const res = await authedApp.request("/health");
      expect(res.status).toBe(200);

      delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    });
  });
});
