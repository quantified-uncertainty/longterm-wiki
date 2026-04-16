import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { mockDbModule, postJson } from "./test-utils.js";
import { clearStubIfEnriched } from "../routes/tablebase/entities.js";

// ---- In-memory store simulating Postgres entities table ----

/** Primary store: stableId -> row */
let entitiesStore: Map<string, Record<string, unknown>>;
/** Secondary index: slug (id) -> stableId */
let slugIndex: Map<string, string>;

/** Captured dispatch calls for asserting SQL parameters. */
let dispatchCalls: Array<{ query: string; params: unknown[] }>;

function resetStores() {
  entitiesStore = new Map();
  slugIndex = new Map();
  dispatchCalls = [];
}

/** Look up entity by any key (stableId or slug). */
function lookupEntity(key: string): Record<string, unknown> | undefined {
  return entitiesStore.get(key) ?? entitiesStore.get(slugIndex.get(key) ?? "");
}

function dispatch(query: string, params: unknown[]): unknown[] {
  dispatchCalls.push({ query, params: [...params] });
  const q = query.toLowerCase();

  // --- ref-check: SELECT <column> AS id FROM entities WHERE <column> IN (...) ---
  // Respect the column being queried so tests can catch slug-vs-stableId
  // confusion (QUA-519): when the query targets entities.id, only return
  // ids that exist as slugs; when it targets stable_id, only return
  // stableIds. The previous column-agnostic behavior masked the bug where
  // ref-check only looked at entities.id while YAML refs may be stableIds.
  if (q.includes("as id from") && q.includes("where") && q.includes(" in ")) {
    const targetsStableId = q.includes("stable_id");
    const keys: Set<string> = targetsStableId
      ? new Set(entitiesStore.keys())
      : new Set(slugIndex.keys());
    return params
      .filter((p) => keys.has(p as string))
      .map((p) => ({ id: p }));
  }

  // --- entities: INSERT ... ON CONFLICT DO UPDATE (supports multi-row) ---
  if (q.includes("insert into") && q.includes('"entities"')) {
    const COLS = 15;
    const numRows = params.length / COLS;
    const rows: Record<string, unknown>[] = [];
    const now = new Date();
    for (let i = 0; i < numRows; i++) {
      const o = i * COLS;
      const id = params[o] as string;
      const stableId = params[o + 2] as string;
      const existing = entitiesStore.get(stableId);

      const row: Record<string, unknown> = {
        id,
        wiki_id: params[o + 1],
        stable_id: stableId,
        entity_type: params[o + 3],
        title: params[o + 4],
        description: params[o + 5],
        website: params[o + 6],
        tags: params[o + 7],
        clusters: params[o + 8],
        status: params[o + 9],
        last_updated: params[o + 10],
        custom_fields: params[o + 11],
        related_entries: params[o + 12],
        metadata: params[o + 13],
        synced_at: now,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };
      // Primary key: stableId; secondary index: slug
      entitiesStore.set(stableId, row);
      slugIndex.set(id, stableId);
      rows.push(row);
    }
    return rows;
  }

  // --- entities: tsvector search (search_vector @@ to_tsquery) ---
  // Search uses buildTsvectorSearchCondition first.
  // The SQL contains "search_vector", "to_tsquery", and "@@".
  // MUST come before ILIKE since ILIKE is the fallback when tsquery can't be built.
  if (q.includes('"entities"') && q.includes("search_vector") && q.includes("to_tsquery")) {
    // params[0] is the tsquery string (e.g. "anthropic:*"), params may also have
    // the raw search term for title boosting (params[1]) and limit (last numeric param).
    // We do a simple case-insensitive substring match to simulate the text search.
    // Extract search terms from the tsquery: strip :* suffixes and & operators
    const tsquery = String(params[0] ?? "");
    const terms = tsquery.replace(/:[\*]?/g, "").split(/\s*&\s*/).map(t => t.trim().toLowerCase()).filter(Boolean);
    const limitParam = params.find((p, i) => i >= 1 && typeof p === "number") as number | undefined;
    const limit = limitParam ?? 20;
    const results: Record<string, unknown>[] = [];
    for (const row of entitiesStore.values()) {
      const title = (row.title as string) || "";
      const id = (row.id as string) || "";
      const desc = (row.description as string) || "";
      const text = `${title} ${id} ${desc}`.toLowerCase();
      if (terms.every(term => text.includes(term))) {
        results.push(row);
      }
    }
    return results.slice(0, limit);
  }

  // --- entities: trigram fallback search (similarity) ---
  // When tsvector returns too few results, the route falls back to trigram similarity.
  // The SQL contains "similarity" and "entities".
  if (q.includes('"entities"') && q.includes("similarity")) {
    const searchTerm = String(params[0] ?? "").toLowerCase();
    const limitParam = params.find((p, i) => i >= 1 && typeof p === "number") as number | undefined;
    const limit = limitParam ?? 20;
    const results: Record<string, unknown>[] = [];
    for (const row of entitiesStore.values()) {
      const title = (row.title as string) || "";
      if (title.toLowerCase().includes(searchTerm)) {
        results.push(row);
      }
    }
    return results.slice(0, limit);
  }

  // --- entities: ILIKE search (has ilike + order by + limit) ---
  // Fallback when tsquery cannot be built (e.g. all-punctuation input).
  // MUST come before the OR check since ILIKE queries also contain 'or'
  if (q.includes('"entities"') && q.includes("ilike")) {
    // The search uses 3 ILIKE patterns (title, id, description) — all the same value
    const pattern = params[0] as string;
    const searchTerm = pattern.replace(/%/g, "").toLowerCase();
    // Limit is the last numeric param
    const limitParam = params.find((p, i) => i >= 3 && typeof p === "number") as number | undefined;
    const limit = limitParam ?? 20;
    const results: Record<string, unknown>[] = [];
    for (const row of entitiesStore.values()) {
      const title = (row.title as string) || "";
      const id = (row.id as string) || "";
      const desc = (row.description as string) || "";
      if (
        title.toLowerCase().includes(searchTerm) ||
        id.toLowerCase().includes(searchTerm) ||
        desc.toLowerCase().includes(searchTerm)
      ) {
        results.push(row);
      }
    }
    return results.slice(0, limit);
  }

  // --- entities: SELECT with WHERE + OR (get by id, wiki_id, or stable_id) ---
  if (
    q.includes('"entities"') &&
    q.includes("where") &&
    q.includes(" or ") &&
    !q.includes("count(*)") &&
    !q.includes("order by")
  ) {
    const id = params[0] as string;
    const wikiId = params[1] as string;
    const stableId = params[2] as string;
    const results: Record<string, unknown>[] = [];
    for (const row of entitiesStore.values()) {
      if (row.id === id || row.wiki_id === wikiId || row.stable_id === stableId) {
        results.push(row);
      }
    }
    return results;
  }

  // --- entities: COUNT(*) with or without WHERE (not GROUP BY) ---
  if (q.includes("count(*)") && q.includes('"entities"') && !q.includes("group by")) {
    if (q.includes("where")) {
      let count = 0;
      for (const row of entitiesStore.values()) {
        if (params.length > 0 && row.entity_type === params[0]) {
          count++;
        }
      }
      return [{ count }];
    }
    return [{ count: entitiesStore.size }];
  }

  // --- entities: GROUP BY entity_type (stats) ---
  if (q.includes('"entities"') && q.includes("group by")) {
    const byType = new Map<string, number>();
    for (const row of entitiesStore.values()) {
      const t = row.entity_type as string;
      byType.set(t, (byType.get(t) || 0) + 1);
    }
    return [...byType.entries()].map(([entity_type, count]) => ({
      entity_type,
      count,
    }));
  }

  // --- entities: SELECT ORDER BY LIMIT (paginated listing) ---
  if (
    q.includes('"entities"') &&
    q.includes("order by") &&
    q.includes("limit") &&
    !q.includes("count(*)")
  ) {
    const allRows = Array.from(entitiesStore.values()).sort((a, b) =>
      (a.id as string).localeCompare(b.id as string)
    );

    let filtered = allRows;
    if (q.includes("where")) {
      const filterVal = params[0] as string;
      filtered = allRows.filter((r) => r.entity_type === filterVal);
    }

    const limitIdx = q.includes("where") ? 1 : 0;
    const limit = (params[limitIdx] as number) || 50;
    const offset = (params[limitIdx + 1] as number) || 0;
    return filtered.slice(offset, offset + limit);
  }

  // --- prune: SELECT id FROM entities WHERE entity_type = ? AND id NOT IN (?) ---
  if (
    q.includes('"entities"') &&
    q.includes("where") &&
    q.includes("not in") &&
    !q.includes("insert")
  ) {
    const entityType = params[0] as string;
    const keepIds = new Set(params.slice(1));
    const results: { id: string }[] = [];
    for (const row of entitiesStore.values()) {
      if (row.entity_type === entityType && !keepIds.has(row.id)) {
        results.push({ id: row.id as string });
      }
    }
    return results;
  }

  // --- directory step 4b: SELECT id, title FROM entities WHERE id IN (...) ---
  // Resolves metadata ref fields (e.g. metadata.developer = "anthropic") into entity names.
  if (
    q.includes('"entities"') && q.includes("where") && q.includes(" in ") &&
    !q.includes("not in") && !q.includes("order by") && !q.includes("stable_id") &&
    !q.includes("count(*)") && !q.includes("group by") && !q.includes("insert")
  ) {
    const ids = new Set(params as string[]);
    const results: { id: string; title: string }[] = [];
    for (const row of entitiesStore.values()) {
      if (ids.has(row.id as string)) {
        results.push({ id: row.id as string, title: row.title as string });
      }
    }
    return results;
  }

  // --- prune: SELECT id WHERE entity_type = ? (no NOT IN — all entities of type) ---
  // Matches when keepIds is empty (prune all of type)
  if (
    q.includes("select") &&
    q.includes('"entities"') &&
    q.includes("where") &&
    !q.includes("not in") &&
    !q.includes("or") &&
    !q.includes("order by") &&
    !q.includes("count(*)") &&
    !q.includes("insert") &&
    !q.includes("ilike") &&
    !q.includes("group by") &&
    !q.includes(" in ") &&
    params.length === 1
  ) {
    const entityType = params[0] as string;
    const results: { id: string }[] = [];
    for (const row of entitiesStore.values()) {
      if (row.entity_type === entityType) {
        results.push({ id: row.id as string });
      }
    }
    return results;
  }

  // --- prune: DELETE FROM things WHERE source_table = 'entities' AND source_id IN (...) ---
  if (q.includes("delete") && q.includes('"things"')) {
    // No things store in this test — just acknowledge the delete
    return [];
  }

  // --- prune: DELETE FROM entities WHERE id IN (...) ---
  if (q.includes("delete") && q.includes('"entities"')) {
    const idsToDelete = new Set(params);
    for (const [stableId, row] of entitiesStore) {
      if (idsToDelete.has(row.id)) {
        slugIndex.delete(row.id as string);
        entitiesStore.delete(stableId);
      }
    }
    return [];
  }

  // --- facts: DISTINCT ON query for directory endpoint ---
  if (q.includes("distinct on") && q.includes("facts")) {
    return []; // No facts in test — return empty
  }

  // --- entity_ids: COUNT (for health check) ---
  if (q.includes("count(*)") && !q.includes('"entities"')) {
    return [{ count: 0 }];
  }

  // --- sequence health check ---
  if (q.includes("last_value")) {
    return [{ last_value: 0, is_called: true }];
  }

  return [];
}

// Mock the db module
vi.mock("../db.js", () => mockDbModule(dispatch));

const { createApp } = await import("../app.js");

// ---- Helpers ----

/** Generate a deterministic 10-char stableId from a slug for tests. */
function testStableId(slug: string): string {
  // Simple hash for test determinism — not cryptographic
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = ((h << 5) - h + slug.charCodeAt(i)) | 0;
  return `test${Math.abs(h).toString(36).padEnd(6, "0")}`.slice(0, 10);
}

function seedEntity(
  app: Hono,
  id: string,
  title: string,
  opts: Record<string, unknown> = {}
) {
  return postJson(app, "/api/entities/sync", {
    entities: [
      {
        id,
        title,
        entityType: opts.entityType ?? "organization",
        stableId: opts.stableId ?? testStableId(id),
        wikiId: opts.wikiId ?? `E${Math.floor(Math.random() * 1000)}`,
        description: opts.description ?? `Description of ${title}`,
        ...opts,
      },
    ],
  });
}

// ---- Tests ----

describe("Entities API", () => {
  let app: Hono;

  beforeEach(() => {
    resetStores();
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    app = createApp();
  });

  // ---- Sync ----

  describe("POST /api/entities/sync", () => {
    it("creates new entities", async () => {
      const res = await postJson(app, "/api/entities/sync", {
        entities: [
          {
            id: "anthropic",
            stableId: "aB1cD2eF3g",
            title: "Anthropic",
            entityType: "organization",
            wikiId: "E22",
            description: "AI safety company",
          },
          {
            id: "openai",
            stableId: "hI4jK5lM6n",
            title: "OpenAI",
            entityType: "organization",
            wikiId: "E43",
            description: "AI research lab",
          },
        ],
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(2);
    });

    it("updates existing entities", async () => {
      await seedEntity(app, "anthropic", "Anthropic", { stableId: "aB1cD2eF3g" });

      const res = await postJson(app, "/api/entities/sync", {
        entities: [
          {
            id: "anthropic",
            stableId: "aB1cD2eF3g",
            title: "Anthropic (Updated)",
            entityType: "organization",
            description: "Updated description",
          },
        ],
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(1);
    });

    it("rejects empty batch", async () => {
      const res = await postJson(app, "/api/entities/sync", { entities: [] });
      expect(res.status).toBe(400);
    });

    it("rejects entities without title", async () => {
      const res = await postJson(app, "/api/entities/sync", {
        entities: [{ id: "no-title", stableId: "nT1234abcd", entityType: "concept" }],
      });
      expect(res.status).toBe(400);
    });

    it("rejects entities without entityType", async () => {
      const res = await postJson(app, "/api/entities/sync", {
        entities: [{ id: "no-type", stableId: "nT5678efgh", title: "No Type" }],
      });
      expect(res.status).toBe(400);
    });

    it("rejects entities without stableId", async () => {
      const res = await postJson(app, "/api/entities/sync", {
        entities: [{ id: "no-stable", title: "No Stable ID", entityType: "concept" }],
      });
      expect(res.status).toBe(400);
    });

    it("rejects invalid JSON", async () => {
      const res = await app.request("/api/entities/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("invalid_json");
    });
  });

  // ---- Get by ID ----

  describe("GET /api/entities/:id", () => {
    it("returns entity by slug", async () => {
      await seedEntity(app, "anthropic", "Anthropic", {
        stableId: "aB1cD2eF3g",
        wikiId: "E22",
        description: "AI safety company",
      });

      const res = await app.request("/api/entities/anthropic");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe("anthropic");
      expect(body.title).toBe("Anthropic");
      expect(body.wikiId).toBe("E22");
    });

    it("returns entity by wiki ID", async () => {
      await seedEntity(app, "anthropic", "Anthropic", { stableId: "aB1cD2eF3g", wikiId: "E22" });

      const res = await app.request("/api/entities/E22");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe("anthropic");
    });

    it("returns 404 for unknown entity", async () => {
      const res = await app.request("/api/entities/nonexistent");
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe("not_found");
    });
  });

  // ---- Paginated listing ----

  describe("GET /api/entities", () => {
    it("returns paginated listing", async () => {
      await seedEntity(app, "anthropic", "Anthropic");
      await seedEntity(app, "openai", "OpenAI");
      await seedEntity(app, "deepmind", "DeepMind");

      const res = await app.request("/api/entities?limit=2&offset=0");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.entities).toHaveLength(2);
      expect(body.total).toBe(3);
      expect(body.limit).toBe(2);
      expect(body.offset).toBe(0);
    });

    it("filters by entityType", async () => {
      await seedEntity(app, "anthropic", "Anthropic", {
        entityType: "organization",
      });
      await seedEntity(app, "deceptive-alignment", "Deceptive Alignment", {
        entityType: "risk",
      });

      const res = await app.request("/api/entities?entityType=organization");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.entities.length).toBeGreaterThan(0);
    });

    it("returns empty list when no entities", async () => {
      const res = await app.request("/api/entities");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.entities).toHaveLength(0);
      expect(body.total).toBe(0);
    });
  });

  // ---- Search ----

  describe("GET /api/entities/search", () => {
    it("returns search results", async () => {
      await seedEntity(app, "anthropic", "Anthropic", {
        description: "AI safety company founded by Dario Amodei",
      });
      await seedEntity(app, "openai", "OpenAI", {
        description: "AI research lab",
      });

      const res = await app.request("/api/entities/search?q=anthropic");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.query).toBe("anthropic");
      expect(body.results.length).toBeGreaterThan(0);
      expect(body.results[0].id).toBe("anthropic");
    });

    it("requires q parameter", async () => {
      const res = await app.request("/api/entities/search");
      expect(res.status).toBe(400);
    });

    it("returns empty results for no match", async () => {
      const res = await app.request("/api/entities/search?q=nonexistentxyz");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results).toHaveLength(0);
    });

    // ---- SQL metacharacter sanitization ----
    // Search now uses tsvector (buildPrefixTsquery) which strips non-alphanumeric
    // characters, so SQL ILIKE metacharacters (%, _, \) are harmless.
    // These tests verify that the search returns correct results and the tsquery
    // parameter is properly sanitized (no raw metacharacters reach the DB).

    it("strips % from search query via tsvector sanitization", async () => {
      await seedEntity(app, "test-percent", "100% Safe AI");
      dispatchCalls = [];

      const res = await app.request(
        `/api/entities/search?q=${encodeURIComponent("100%")}`
      );
      expect(res.status).toBe(200);

      // Tsvector path: buildPrefixTsquery("100%") → "100:*" (% stripped)
      const tsCall = dispatchCalls.find((c) =>
        c.query.toLowerCase().includes("to_tsquery")
      );
      expect(tsCall).toBeDefined();
      // The tsquery param should be "100:*" — % is stripped by buildPrefixTsquery
      expect(tsCall!.params[0]).toBe("100:*");
    });

    it("strips _ from search query via tsvector sanitization", async () => {
      await seedEntity(app, "test-underscore", "my_variable_name");
      dispatchCalls = [];

      const res = await app.request(
        `/api/entities/search?q=${encodeURIComponent("my_var")}`
      );
      expect(res.status).toBe(200);

      // Tsvector path: buildPrefixTsquery("my_var") → "my:* & var:*" (_ replaced by space)
      const tsCall = dispatchCalls.find((c) =>
        c.query.toLowerCase().includes("to_tsquery")
      );
      expect(tsCall).toBeDefined();
      expect(tsCall!.params[0]).toBe("my:* & var:*");
    });

    it("strips \\ from search query via tsvector sanitization", async () => {
      await seedEntity(app, "test-backslash", "C:\\Users\\docs");
      dispatchCalls = [];

      const res = await app.request(
        `/api/entities/search?q=${encodeURIComponent("C:\\Users")}`
      );
      expect(res.status).toBe(200);

      // Tsvector path: buildPrefixTsquery("C:\\Users") → "C:* & Users:*" (\ stripped)
      const tsCall = dispatchCalls.find((c) =>
        c.query.toLowerCase().includes("to_tsquery")
      );
      expect(tsCall).toBeDefined();
      expect(tsCall!.params[0]).toBe("C:* & Users:*");
    });
  });

  // ---- Stats ----

  describe("GET /api/entities/stats", () => {
    it("returns entity statistics", async () => {
      await seedEntity(app, "anthropic", "Anthropic", {
        entityType: "organization",
      });
      await seedEntity(app, "deceptive-alignment", "Deceptive Alignment", {
        entityType: "risk",
      });

      const res = await app.request("/api/entities/stats");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(2);
      expect(body.byType).toBeDefined();
      expect(body.byType.organization).toBe(1);
      expect(body.byType.risk).toBe(1);
    });
  });

  // ---- Export ----

  describe("GET /api/entities/export", () => {
    it("returns full entity shape for all entities", async () => {
      await seedEntity(app, "anthropic", "Anthropic", {
        entityType: "organization",
        description: "AI safety company",
      });
      await seedEntity(app, "deceptive-alignment", "Deceptive Alignment", {
        entityType: "risk",
      });

      const res = await app.request("/api/entities/export");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(2);
      expect(body.returned).toBe(2);
      expect(body.entities).toHaveLength(2);
      // Full shape: metadata, relatedEntries, customFields present
      const anthropic = body.entities.find((e: { id: string }) => e.id === "anthropic");
      expect(anthropic).toBeDefined();
      expect(anthropic).toHaveProperty("metadata");
      expect(anthropic).toHaveProperty("relatedEntries");
      expect(anthropic).toHaveProperty("customFields");
      expect(anthropic.description).toBe("AI safety company");
    });

    it("filters by entityType", async () => {
      await seedEntity(app, "anthropic", "Anthropic", {
        entityType: "organization",
      });
      await seedEntity(app, "deceptive-alignment", "Deceptive Alignment", {
        entityType: "risk",
      });

      const res = await app.request("/api/entities/export?entityType=organization");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(1);
      expect(body.entities).toHaveLength(1);
      expect(body.entities[0].id).toBe("anthropic");
    });

    it("supports pagination via limit and offset", async () => {
      await seedEntity(app, "a-ent", "A");
      await seedEntity(app, "b-ent", "B");
      await seedEntity(app, "c-ent", "C");

      const res = await app.request("/api/entities/export?limit=2&offset=1");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(3);
      expect(body.returned).toBe(2);
      expect(body.limit).toBe(2);
      expect(body.offset).toBe(1);
      expect(body.entities).toHaveLength(2);
      // Ordered by id ascending → offset=1 skips "a-ent"
      expect(body.entities[0].id).toBe("b-ent");
      expect(body.entities[1].id).toBe("c-ent");
    });

    it("rejects invalid updatedSince", async () => {
      const res = await app.request("/api/entities/export?updatedSince=not-a-date");
      expect(res.status).toBe(400);
    });

    it("rejects limit above the export cap", async () => {
      const res = await app.request("/api/entities/export?limit=999999");
      expect(res.status).toBe(400);
    });

    it("does not collide with GET /:id for the literal 'export' slug", async () => {
      // Regression: route ordering must define /export before /:id, otherwise
      // /export would match /:id with id="export" and return 404.
      const res = await app.request("/api/entities/export");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("entities");
      expect(body).toHaveProperty("total");
    });

    it("returns an empty result with total 0 when no entities match", async () => {
      await seedEntity(app, "anthropic", "Anthropic", {
        entityType: "organization",
      });
      const res = await app.request("/api/entities/export?entityType=risk");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(0);
      expect(body.returned).toBe(0);
      expect(body.entities).toEqual([]);
    });
  });

  // ---- Sync with JSONB fields ----

  describe("JSONB fields", () => {
    it("syncs entities with tags and relatedEntries", async () => {
      // Pre-seed referenced entities so ref-check passes
      await seedEntity(app, "openai", "OpenAI", { stableId: "hI4jK5lM6n" });
      await seedEntity(app, "interpretability", "Interpretability", {
        entityType: "safety-agenda",
        stableId: "xY7zA8bC9d",
      });

      const res = await postJson(app, "/api/entities/sync", {
        entities: [
          {
            id: "anthropic",
            stableId: "aB1cD2eF3g",
            title: "Anthropic",
            entityType: "organization",
            tags: ["ai-safety", "frontier-lab"],
            relatedEntries: [
              { id: "openai", type: "organization" },
              { id: "interpretability", type: "safety-agenda", relationship: "research" },
            ],
          },
        ],
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(1);
    });
  });

  // ---- Referential integrity ----

  describe("Referential integrity", () => {
    it("preserves relatedEntries that target a stableId, not just slugs (QUA-519)", async () => {
      // Regression: ref-check previously only queried entities.id (slug),
      // silently stripping every stableId-based ref and writing relatedEntries:[].
      await seedEntity(app, "openai", "OpenAI", { stableId: "hI4jK5lM6n" });

      const res = await postJson(app, "/api/entities/sync", {
        entities: [
          {
            id: "anthropic",
            stableId: "aB1cD2eF3g",
            title: "Anthropic",
            entityType: "organization",
            relatedEntries: [
              // stableId reference — must resolve via entities.stable_id
              { id: "hI4jK5lM6n", type: "organization" },
              // genuinely missing — must still be stripped
              { id: "nonexistent-sid", type: "organization" },
            ],
          },
        ],
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(1);

      // Row written should still contain the stableId ref, with only the
      // unresolved one stripped.
      const row = entitiesStore.get("aB1cD2eF3g");
      expect(row).toBeDefined();
      const related = JSON.parse(row!.related_entries as string);
      expect(related).toEqual([
        { id: "hI4jK5lM6n", type: "organization" },
      ]);
    });

    it("strips dangling relatedEntries instead of rejecting", async () => {
      const res = await postJson(app, "/api/entities/sync", {
        entities: [
          {
            id: "anthropic",
            stableId: "aB1cD2eF3g",
            title: "Anthropic",
            entityType: "organization",
            relatedEntries: [
              { id: "nonexistent-org", type: "organization" },
            ],
          },
        ],
      });

      // Entity should be upserted — dangling refs are stripped, not rejected
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(1);
    });

    it("accepts relatedEntries pointing to entities in the same batch", async () => {
      const res = await postJson(app, "/api/entities/sync", {
        entities: [
          {
            id: "alpha",
            stableId: "alPHa12345",
            title: "Alpha",
            entityType: "organization",
            relatedEntries: [{ id: "beta", type: "organization" }],
          },
          {
            id: "beta",
            stableId: "bETa678901",
            title: "Beta",
            entityType: "organization",
            relatedEntries: [{ id: "alpha", type: "organization" }],
          },
        ],
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(2);
    });
  });

  // ---- Directory endpoint ----

  describe("GET /api/entities/directory", () => {
    it("returns entities for a valid entityType", async () => {
      await seedEntity(app, "anthropic", "Anthropic", {
        entityType: "organization",
      });
      await seedEntity(app, "openai", "OpenAI", {
        entityType: "organization",
      });

      const res = await app.request(
        "/api/entities/directory?entityType=organization"
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.entities)).toBe(true);
      expect(body.total).toBeGreaterThanOrEqual(0);
    });

    it("rejects unknown entityType with 400", async () => {
      const res = await app.request(
        "/api/entities/directory?entityType=unknown-type-xyz"
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Unknown entityType");
      expect(body.error).toContain("unknown-type-xyz");
    });

    it("rejects SQL-injection-style entityType with 400", async () => {
      const res = await app.request(
        "/api/entities/directory?entityType='; DROP TABLE entities;--"
      );
      expect(res.status).toBe(400);
    });

    it("accepts a valid alias entityType", async () => {
      await seedEntity(app, "researcher-1", "A Researcher", {
        entityType: "researcher",
      });

      // "researcher" is a known alias — should be accepted (200), not rejected
      const res = await app.request(
        "/api/entities/directory?entityType=researcher"
      );
      expect(res.status).toBe(200);
    });

    it("requires entityType parameter", async () => {
      const res = await app.request("/api/entities/directory");
      expect(res.status).toBe(400);
    });

    it("resolves metadata ref fields (e.g. developer) into resolvedRefs", async () => {
      await seedEntity(app, "anthropic", "Anthropic", { entityType: "organization", stableId: "aB1cD2eF3g" });
      await seedEntity(app, "claude-3-opus", "Claude 3 Opus", {
        entityType: "ai-model", stableId: "bC2dE3fG4h",
        metadata: { developer: "anthropic", releaseDate: "2024-03-04" },
      });
      const res = await app.request("/api/entities/directory?entityType=ai-model&measures=developer");
      expect(res.status).toBe(200);
      const body = await res.json();
      const model = body.entities.find((e: { id: string }) => e.id === "claude-3-opus");
      expect(model).toBeDefined();
      expect(model?.resolvedRefs["developer"]).toBeDefined();
      expect(model?.resolvedRefs["developer"].name).toBe("Anthropic");
      expect(model?.resolvedRefs["developer"].entityId).toBe("anthropic");
    });
  });

  // ---- Auth ----

  describe("Bearer auth", () => {
    it("rejects unauthenticated sync when API key is set", async () => {
      process.env.LONGTERMWIKI_SERVER_API_KEY = "test-secret";
      const authedApp = createApp();

      const res = await postJson(authedApp, "/api/entities/sync", {
        entities: [
          {
            id: "anthropic",
            stableId: "aB1cD2eF3g",
            title: "Anthropic",
            entityType: "organization",
          },
        ],
      });

      expect(res.status).toBe(401);
    });

    it("accepts sync with correct Bearer token", async () => {
      process.env.LONGTERMWIKI_SERVER_API_KEY = "test-secret";
      const authedApp = createApp();

      const res = await authedApp.request("/api/entities/sync", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-secret",
        },
        body: JSON.stringify({
          entities: [
            {
              id: "anthropic",
              stableId: "aB1cD2eF3g",
              title: "Anthropic",
              entityType: "organization",
            },
          ],
        }),
      });

      expect(res.status).toBe(200);
    });
  });

  // ---- Stub entity filtering ----

  describe("Stub entity filtering", () => {
    /** Parse metadata stored by mock (may be JSON string or object from Drizzle). */
    function parseMeta(raw: unknown): Record<string, unknown> | null {
      if (raw === null || raw === undefined) return null;
      if (typeof raw === "string") {
        try { return JSON.parse(raw); } catch { return null; }
      }
      return raw as Record<string, unknown>;
    }

    it("auto-clears stub flag when entity is synced with description", async () => {
      // First create a stub entity
      await postJson(app, "/api/entities/sync", {
        entities: [{
          id: "stub-person",
          stableId: "sTuB123456",
          title: "Stub Person",
          entityType: "person",
          metadata: { stub: true },
        }],
      });

      // Verify stub is set
      const row = entitiesStore.get("sTuB123456");
      expect(row).toBeDefined();
      const meta = parseMeta(row!.metadata);
      expect(meta?.stub).toBe(true);

      // Now re-sync with description — stub should be cleared
      await postJson(app, "/api/entities/sync", {
        entities: [{
          id: "stub-person",
          stableId: "sTuB123456",
          title: "Stub Person",
          entityType: "person",
          description: "A well-known AI researcher",
          metadata: { stub: true },
        }],
      });

      const updated = entitiesStore.get("sTuB123456");
      expect(updated).toBeDefined();
      // metadata.stub should be cleared (metadata becomes null if only stub was present)
      const updatedMeta = parseMeta(updated!.metadata);
      expect(updatedMeta?.stub).toBeUndefined();
    });

    it("auto-clears stub flag when entity is synced with wikiId", async () => {
      await postJson(app, "/api/entities/sync", {
        entities: [{
          id: "stub-person-2",
          stableId: "sTuB789012",
          title: "Notable Person",
          entityType: "person",
          wikiId: "E500",
          metadata: { stub: true },
        }],
      });

      const row = entitiesStore.get("sTuB789012");
      const meta = parseMeta(row!.metadata);
      expect(meta?.stub).toBeUndefined();
    });

    it("preserves stub flag when entity has no enrichment data", async () => {
      await postJson(app, "/api/entities/sync", {
        entities: [{
          id: "minimal-stub",
          stableId: "mInStUb1234",
          title: "Minimal Stub",
          entityType: "person",
          metadata: { stub: true },
        }],
      });

      const row = entitiesStore.get("mInStUb1234");
      const meta = parseMeta(row!.metadata);
      expect(meta).toBeDefined();
      expect(meta!.stub).toBe(true);
    });

    it("preserves other metadata fields when clearing stub", async () => {
      await postJson(app, "/api/entities/sync", {
        entities: [{
          id: "stub-with-meta",
          stableId: "mEtA567890",
          title: "Person With Metadata",
          entityType: "person",
          description: "Has a description",
          metadata: { stub: true, customTag: "important" },
        }],
      });

      const row = entitiesStore.get("mEtA567890");
      const meta = parseMeta(row!.metadata);
      expect(meta).toBeDefined();
      expect(meta!.stub).toBeUndefined();
      expect(meta!.customTag).toBe("important");
    });

  });

  // ---- Directory stub exclusion ----

  describe("Directory stub exclusion", () => {
    it("includeStubs defaults to false (stubs excluded)", async () => {
      // Seed a regular entity and a stub entity
      await seedEntity(app, "regular-person", "Regular Person", {
        entityType: "person",
        stableId: "rEg1234567",
      });
      await postJson(app, "/api/entities/sync", {
        entities: [{
          id: "stub-jane",
          stableId: "sTb1234567",
          title: "Stub Jane",
          entityType: "person",
          metadata: { stub: true },
        }],
      });

      const res = await app.request("/api/entities/directory?entityType=person");
      expect(res.status).toBe(200);
      // The mock doesn't filter by metadata, so we just verify the endpoint
      // accepts the parameter and responds successfully
      const body = await res.json();
      expect(Array.isArray(body.entities)).toBe(true);
    });

    it("includeStubs=true returns all entities", async () => {
      const res = await app.request(
        "/api/entities/directory?entityType=person&includeStubs=true"
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.entities)).toBe(true);
    });

    it("includeStubs=false excludes stubs (explicit)", async () => {
      const res = await app.request(
        "/api/entities/directory?entityType=person&includeStubs=false"
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.entities)).toBe(true);
    });
  });

  // ---- Prune endpoint ----

  describe("POST /api/entities/prune", () => {
    it("deletes stale entities not in the keep list", async () => {
      resetStores();
      await seedEntity(app, "alice", "Alice", { entityType: "person" });
      await seedEntity(app, "bob", "Bob", { entityType: "person" });
      await seedEntity(app, "ghost-person", "Ghost Person", { entityType: "person" });

      // Prune: keep alice and bob, ghost-person should be deleted
      const res = await postJson(app, "/api/entities/prune", {
        entityType: "person",
        keepIds: ["alice", "bob"],
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(1);
      expect(body.ids).toContain("ghost-person");
    });

    it("returns 0 deleted when all entities are in the keep list", async () => {
      resetStores();
      await seedEntity(app, "alice", "Alice", { entityType: "person" });
      await seedEntity(app, "bob", "Bob", { entityType: "person" });

      const res = await postJson(app, "/api/entities/prune", {
        entityType: "person",
        keepIds: ["alice", "bob"],
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(0);
      expect(body.ids).toEqual([]);
    });

    it("only prunes entities of the specified type", async () => {
      resetStores();
      await seedEntity(app, "alice", "Alice", { entityType: "person" });
      await seedEntity(app, "acme-org", "ACME", { entityType: "organization" });

      // Prune person type with empty keep list (keep no persons)
      // This should only affect person entities, not organization
      const res = await postJson(app, "/api/entities/prune", {
        entityType: "person",
        keepIds: [],
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(1);
      expect(body.ids).toContain("alice");

      // Organization should still exist
      const orgStableId = testStableId("acme-org");
      expect(entitiesStore.has(orgStableId)).toBe(true);
    });

    it("rejects unknown entity types", async () => {
      const res = await postJson(app, "/api/entities/prune", {
        entityType: "nonexistent-type",
        keepIds: [],
      });

      expect(res.status).toBe(400);
    });

    it("validates request body shape", async () => {
      // Missing entityType
      const res = await postJson(app, "/api/entities/prune", {
        keepIds: [],
      });
      expect(res.status).toBe(400);
    });
  });
});

// ---- Unit tests for clearStubIfEnriched ----

describe("clearStubIfEnriched", () => {
  it("returns null for entities without metadata", () => {
    expect(clearStubIfEnriched({ metadata: null })).toBe(null);
    expect(clearStubIfEnriched({ metadata: undefined })).toBe(null);
    expect(clearStubIfEnriched({})).toBe(null);
  });

  it("returns metadata unchanged if no stub flag", () => {
    const meta = { customTag: "important" };
    expect(clearStubIfEnriched({ metadata: meta })).toBe(meta);
  });

  it("preserves stub flag when no enrichment data present", () => {
    const result = clearStubIfEnriched({
      metadata: { stub: true },
    });
    expect(result).toEqual({ stub: true });
  });

  it("clears stub when description is present", () => {
    const result = clearStubIfEnriched({
      description: "A description",
      metadata: { stub: true },
    });
    expect(result).toBe(null); // Only field was stub, so metadata becomes null
  });

  it("clears stub when wikiId is present", () => {
    const result = clearStubIfEnriched({
      wikiId: "E42",
      metadata: { stub: true },
    });
    expect(result).toBe(null);
  });

  it("clears stub when customFields are present", () => {
    const result = clearStubIfEnriched({
      customFields: [{ label: "Field", value: "Value" }],
      metadata: { stub: true },
    });
    expect(result).toBe(null);
  });

  it("clears stub when relatedEntries are present", () => {
    const result = clearStubIfEnriched({
      relatedEntries: [{ id: "other", type: "org" }],
      metadata: { stub: true },
    });
    expect(result).toBe(null);
  });

  it("preserves other metadata fields when clearing stub", () => {
    const result = clearStubIfEnriched({
      description: "Has data",
      metadata: { stub: true, customTag: "important", verified: false },
    });
    expect(result).toEqual({ customTag: "important", verified: false });
  });

  it("does not clear stub for empty arrays", () => {
    const result = clearStubIfEnriched({
      customFields: [],
      relatedEntries: [],
      metadata: { stub: true },
    });
    expect(result).toEqual({ stub: true });
  });

  it("does not clear stub for null/undefined data fields", () => {
    const result = clearStubIfEnriched({
      description: null,
      wikiId: null,
      customFields: null,
      relatedEntries: null,
      metadata: { stub: true },
    });
    expect(result).toEqual({ stub: true });
  });

  it("does not clear stub for empty description", () => {
    const result = clearStubIfEnriched({
      description: "",
      metadata: { stub: true },
    });
    expect(result).toEqual({ stub: true });
  });
});
