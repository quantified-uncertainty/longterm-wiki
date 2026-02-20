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
  { numeric_id: number; slug: string; description: string | null; created_at: string }
>;

function resetStore() {
  store = new Map();
  nextSeqVal = 886;
  lastSeqVal = 885;
  seqIsCalled = true;
}

/**
 * Minimal tagged-template SQL mock. Inspects the first chunk of the query
 * string to decide which "query" is being run, then operates on the
 * in-memory store.
 */
function createMockSql() {
  const mockSql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?").trim();

    // SELECT COUNT(*)
    if (query.includes("SELECT COUNT(*)")) {
      return [{ count: store.size }];
    }

    // SELECT last_value (sequence health check)
    if (query.includes("last_value")) {
      return [{ last_value: lastSeqVal, is_called: seqIsCalled }];
    }

    // INSERT INTO entity_ids ... ON CONFLICT (slug) DO NOTHING RETURNING ...
    if (query.includes("INSERT INTO entity_ids")) {
      const slug = values[0] as string;
      const description = (values[1] as string) ?? null;

      if (store.has(slug)) {
        // ON CONFLICT — return empty (DO NOTHING)
        const result: unknown[] = [];
        Object.defineProperty(result, "count", { value: 0 });
        return result;
      }

      const numeric_id = nextSeqVal++;
      lastSeqVal = numeric_id;
      const row = {
        numeric_id,
        slug,
        description,
        created_at: new Date().toISOString(),
      };
      store.set(slug, row);
      const result = [row];
      Object.defineProperty(result, "count", { value: 1 });
      return result;
    }

    // SELECT ... WHERE slug = ?
    if (query.includes("WHERE slug =")) {
      const slug = values[0] as string;
      const row = store.get(slug);
      return row ? [row] : [];
    }

    // SELECT ... ORDER BY numeric_id LIMIT ? OFFSET ?
    if (query.includes("ORDER BY numeric_id")) {
      const limit = values[0] as number;
      const offset = values[1] as number;
      const all = Array.from(store.values()).sort(
        (a, b) => a.numeric_id - b.numeric_id
      );
      return all.slice(offset, offset + limit);
    }

    // CREATE TABLE / DO $$ (init)
    if (query.includes("CREATE TABLE") || query.includes("DO $$")) {
      return [];
    }

    // setval
    if (query.includes("setval")) {
      const val = values[0] as number;
      lastSeqVal = val;
      nextSeqVal = val + 1;
      return [];
    }

    return [];
  };

  // Transaction support: pass through to the same mock
  mockSql.begin = async (fn: (tx: typeof mockSql) => Promise<void>) => {
    await fn(mockSql);
  };

  return mockSql;
}

// Mock the db module before importing routes
vi.mock("../db.js", () => {
  const mockSql = createMockSql();
  return {
    getDb: () => mockSql,
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
