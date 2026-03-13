import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { createBaseMockSql, mockDbModule, postJson } from "./test-utils.js";

// ---- In-memory store simulating the entity_ids table ----

let nextSeqVal = 886;
let lastSeqVal = 885;
let seqIsCalled = true;

let store: Map<
  string,
  { numeric_id: number; slug: string; stable_id: string | null; description: string | null; created_at: Date }
>;

function resetStore() {
  store = new Map();
  nextSeqVal = 886;
  lastSeqVal = 885;
  seqIsCalled = true;
}

function dispatch(query: string, params: unknown[]): unknown[] {
  const q = query.toLowerCase();

  // SELECT COUNT(*) for entity_ids
  if (q.includes("count(*)") && q.includes("entity_ids")) {
    return [{ count: store.size }];
  }

  // SELECT COUNT(*) for wiki_pages (health check)
  if (q.includes("count(*)") && q.includes("wiki_pages")) {
    return [{ count: 0 }];
  }

  // SELECT COUNT(*) for entities (health check)
  if (q.includes("count(*)") && q.includes('"entities"')) {
    return [{ count: 0 }];
  }

  // SELECT COUNT(*) for facts (health check)
  if (q.includes("count(*)") && q.includes('"facts"')) {
    return [{ count: 0 }];
  }

  // SELECT last_value (sequence health check)
  if (q.includes("last_value")) {
    return [{ last_value: lastSeqVal, is_called: seqIsCalled }];
  }

  // INSERT INTO entity_ids ... ON CONFLICT ... DO NOTHING ... RETURNING
  if (q.includes("insert into") && q.includes("entity_ids") && q.includes("do nothing")) {
    // Params order: slug, stableId, description (matches schema column order)
    const slug = params[0] as string;
    const stable_id = (params[1] as string) ?? null;
    const description = (params[2] as string) ?? null;

    if (store.has(slug)) return [];

    const numeric_id = nextSeqVal++;
    lastSeqVal = numeric_id;
    const row = { numeric_id, slug, stable_id, description, created_at: new Date() };
    store.set(slug, row);
    return [row];
  }

  // UPDATE entity_ids SET stable_id = ... WHERE slug = ... AND stable_id IS NULL
  // Must come before SELECT-by-slug since both match "entity_ids" + "where" + "slug"
  if (q.includes("update") && q.includes("entity_ids") && q.includes("stable_id")) {
    const stableId = params[0] as string;
    const slug = params[1] as string;
    const row = store.get(slug);
    if (row && !row.stable_id) {
      row.stable_id = stableId;
      return [row];
    }
    return [];
  }

  // SELECT ... WHERE stable_id IS NULL
  // Must come before SELECT-by-slug since both match "entity_ids" + "where"
  if (q.includes("entity_ids") && q.includes("is null") && !q.includes("update")) {
    return Array.from(store.values()).filter(r => !r.stable_id);
  }

  // SELECT ... WHERE ... slug = $1
  if (q.includes("entity_ids") && q.includes("where") && q.includes("slug")) {
    const slug = params[0] as string;
    const row = store.get(slug);
    return row ? [row] : [];
  }

  // SELECT ... ORDER BY ... LIMIT ... OFFSET
  if (q.includes("entity_ids") && q.includes("order by") && q.includes("limit")) {
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

// Mock the db module before importing routes
vi.mock("../db.js", () => mockDbModule(dispatch));

const { createApp } = await import("../app.js");

// ---- Tests ----

describe("ID Server API", () => {
  let app: Hono;

  beforeEach(() => {
    resetStore();
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
      const res = await postJson(app, "/api/ids/allocate", { slug: "test-entity" });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.numericId).toBe("E886");
      expect(body.slug).toBe("test-entity");
      expect(body.created).toBe(true);
    });

    it("returns existing ID with 200 for duplicate slug", async () => {
      await postJson(app, "/api/ids/allocate", { slug: "dup-entity" });

      const res = await postJson(app, "/api/ids/allocate", { slug: "dup-entity" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.numericId).toBe("E886");
      expect(body.created).toBe(false);
    });

    it("includes description when provided", async () => {
      const res = await postJson(app, "/api/ids/allocate", {
        slug: "described-entity",
        description: "A test entity",
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.description).toBe("A test entity");
    });

    it("rejects invalid slug", async () => {
      const res = await postJson(app, "/api/ids/allocate", { slug: "" });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("validation_error");
    });

    it("assigns sequential IDs", async () => {
      const res1 = await postJson(app, "/api/ids/allocate", { slug: "entity-a" });
      const res2 = await postJson(app, "/api/ids/allocate", { slug: "entity-b" });

      const body1 = await res1.json();
      const body2 = await res2.json();
      expect(body1.numericId).toBe("E886");
      expect(body2.numericId).toBe("E887");
    });
  });

  describe("POST /api/ids/allocate-batch", () => {
    it("allocates multiple IDs in a batch", async () => {
      const res = await postJson(app, "/api/ids/allocate-batch", {
        items: [
          { slug: "batch-a" },
          { slug: "batch-b" },
          { slug: "batch-c" },
        ],
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
      await postJson(app, "/api/ids/allocate", { slug: "existing-slug" });

      const res = await postJson(app, "/api/ids/allocate-batch", {
        items: [{ slug: "existing-slug" }, { slug: "new-slug" }],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results).toHaveLength(2);
      expect(body.results[0].created).toBe(false);
      expect(body.results[1].created).toBe(true);
    });

    it("rejects empty batch", async () => {
      const res = await postJson(app, "/api/ids/allocate-batch", { items: [] });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/ids", () => {
    it("returns paginated list", async () => {
      for (const slug of ["list-a", "list-b", "list-c"]) {
        await postJson(app, "/api/ids/allocate", { slug });
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
      await postJson(app, "/api/ids/allocate", { slug: "lookup-me" });

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

  describe("stableId allocation", () => {
    it("returns a stableId when allocating a new ID", async () => {
      const res = await postJson(app, "/api/ids/allocate", { slug: "stable-test" });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.stableId).toBeDefined();
      expect(typeof body.stableId).toBe("string");
    });

    it("returns stableId in batch allocation", async () => {
      const res = await postJson(app, "/api/ids/allocate-batch", {
        items: [{ slug: "batch-stable-a" }, { slug: "batch-stable-b" }],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results[0].stableId).toBeDefined();
      expect(body.results[1].stableId).toBeDefined();
    });

    it("returns stableId in by-slug lookup", async () => {
      await postJson(app, "/api/ids/allocate", { slug: "lookup-stable" });

      const res = await app.request("/api/ids/by-slug?slug=lookup-stable");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.stableId).toBeDefined();
    });

    it("includes stableId in paginated list", async () => {
      await postJson(app, "/api/ids/allocate", { slug: "list-stable" });

      const res = await app.request("/api/ids?limit=10");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ids[0].stableId).toBeDefined();
    });
  });

  describe("POST /api/ids/backfill-stable-ids", () => {
    it("backfills stableIds for existing slugs", async () => {
      // Pre-allocate entities (they get auto-generated stableIds)
      await postJson(app, "/api/ids/allocate", { slug: "entity-a" });
      await postJson(app, "/api/ids/allocate", { slug: "entity-b" });

      // Clear the auto-generated stableIds to simulate pre-existing rows
      store.get("entity-a")!.stable_id = null;
      store.get("entity-b")!.stable_id = null;

      const res = await postJson(app, "/api/ids/backfill-stable-ids", {
        items: [
          { slug: "entity-a", stableId: "aaaaaaaaaa" },
          { slug: "entity-b", stableId: "bbbbbbbbbb" },
        ],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.updated).toBe(2);
      expect(store.get("entity-a")!.stable_id).toBe("aaaaaaaaaa");
      expect(store.get("entity-b")!.stable_id).toBe("bbbbbbbbbb");
    });

    it("does not overwrite existing stableIds", async () => {
      await postJson(app, "/api/ids/allocate", { slug: "has-id" });
      const originalStableId = store.get("has-id")!.stable_id;
      expect(originalStableId).toBeTruthy();

      const res = await postJson(app, "/api/ids/backfill-stable-ids", {
        items: [{ slug: "has-id", stableId: "zzzzzzzzzz" }],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.updated).toBe(0);
      expect(store.get("has-id")!.stable_id).toBe(originalStableId);
    });

    it("generates stableIds for rows that still lack one when finalize=true", async () => {
      await postJson(app, "/api/ids/allocate", { slug: "no-stable" });
      store.get("no-stable")!.stable_id = null;

      const res = await postJson(app, "/api/ids/backfill-stable-ids", {
        items: [{ slug: "nonexistent-slug", stableId: "xxxxxxxxxx" }],
        finalize: true,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.totalMissing).toBe(1);
      expect(body.generated).toBe(1);
      expect(store.get("no-stable")!.stable_id).toBeTruthy();
    });

    it("rejects invalid stableId format", async () => {
      const res = await postJson(app, "/api/ids/backfill-stable-ids", {
        items: [{ slug: "test", stableId: "too-short" }],
      });
      expect(res.status).toBe(400);
    });

    it("rejects non-alphanumeric stableId", async () => {
      const res = await postJson(app, "/api/ids/backfill-stable-ids", {
        items: [{ slug: "test", stableId: "abc!!def!!" }],
      });
      expect(res.status).toBe(400);
    });

    it("returns updated=0 for non-existent slugs", async () => {
      const res = await postJson(app, "/api/ids/backfill-stable-ids", {
        items: [{ slug: "does-not-exist", stableId: "aaaaaaaaaa" }],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.updated).toBe(0);
    });
  });

  describe("Bearer auth", () => {
    it("rejects requests without token when API key is set", async () => {
      process.env.LONGTERMWIKI_SERVER_API_KEY = "test-secret-key";
      const authedApp = createApp();

      const res = await postJson(authedApp, "/api/ids/allocate", { slug: "should-fail" });
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
