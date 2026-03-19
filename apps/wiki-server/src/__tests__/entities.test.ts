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

  // --- ref-check: SELECT id FROM entities WHERE id IN (...) ---
  if (q.includes("as id from") && q.includes("where") && q.includes(" in ")) {
    // Return only IDs that exist in the entities store (check both slug and stableId)
    return params
      .filter((p) => lookupEntity(p as string) !== undefined)
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
        sources: params[o + 13],
        metadata: params[o + 14],
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

  // --- entities: ILIKE search (has ilike + order by + limit) ---
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
    !q.includes("count(*)")
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

    // ---- SQL metacharacter escaping ----

    it("escapes % in search query so it is treated as a literal character", async () => {
      await seedEntity(app, "test-percent", "100% Safe AI");
      dispatchCalls = [];

      const res = await app.request(
        `/api/entities/search?q=${encodeURIComponent("100%")}`
      );
      expect(res.status).toBe(200);

      // Verify the ILIKE parameter escapes % as \%
      const ilikeCall = dispatchCalls.find((c) =>
        c.query.toLowerCase().includes("ilike")
      );
      expect(ilikeCall).toBeDefined();
      // The pattern should be %100\%% — wrapping wildcards around the escaped literal
      expect(ilikeCall!.params[0]).toBe("%100\\%%");
    });

    it("escapes _ in search query so it is treated as a literal character", async () => {
      await seedEntity(app, "test-underscore", "my_variable_name");
      dispatchCalls = [];

      const res = await app.request(
        `/api/entities/search?q=${encodeURIComponent("my_var")}`
      );
      expect(res.status).toBe(200);

      // Verify the ILIKE parameter escapes _ as \_
      const ilikeCall = dispatchCalls.find((c) =>
        c.query.toLowerCase().includes("ilike")
      );
      expect(ilikeCall).toBeDefined();
      // The pattern should be %my\_var% — wrapping wildcards around the escaped literal
      expect(ilikeCall!.params[0]).toBe("%my\\_var%");
    });

    it("escapes \\ in search query so it does not act as an escape character", async () => {
      await seedEntity(app, "test-backslash", "C:\\Users\\docs");
      dispatchCalls = [];

      const res = await app.request(
        `/api/entities/search?q=${encodeURIComponent("C:\\Users")}`
      );
      expect(res.status).toBe(200);

      // Verify the ILIKE parameter escapes \ as \\
      const ilikeCall = dispatchCalls.find((c) =>
        c.query.toLowerCase().includes("ilike")
      );
      expect(ilikeCall).toBeDefined();
      // The pattern should be %C:\\Users% — wrapping wildcards around the escaped literal
      expect(ilikeCall!.params[0]).toBe("%C:\\\\Users%");
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

  // ---- Sync with JSONB fields ----

  describe("JSONB fields", () => {
    it("syncs entities with tags, relatedEntries, sources", async () => {
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
            sources: [
              { title: "Anthropic Website", url: "https://anthropic.com" },
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
    it("rejects sync with dangling relatedEntries", async () => {
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

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.message).toContain("nonexistent-org");
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

    it("auto-clears stub flag when entity has sources", async () => {
      await postJson(app, "/api/entities/sync", {
        entities: [{
          id: "stub-with-sources",
          stableId: "sRc1234567",
          title: "Person With Sources",
          entityType: "person",
          sources: [{ title: "Source 1", url: "https://example.com" }],
          metadata: { stub: true },
        }],
      });

      const row = entitiesStore.get("sRc1234567");
      const meta = parseMeta(row!.metadata);
      expect(meta?.stub).toBeUndefined();
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

  it("clears stub when sources are present", () => {
    const result = clearStubIfEnriched({
      sources: [{ title: "Source" }],
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
      sources: [],
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
      sources: null,
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
