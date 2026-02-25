import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { mockDbModule, postJson } from "./test-utils.js";

// ---- In-memory stores simulating Postgres tables ----

let pagesStore: Map<string, Record<string, unknown>>;
let entityIdsStore: Map<number, { slug: string; description: string | null; created_at: Date }>;

function resetStores() {
  pagesStore = new Map();
  entityIdsStore = new Map();
}

/**
 * Simple in-memory text search to simulate PostgreSQL tsvector matching.
 * Searches title, description, entity_type, tags, and llm_summary fields.
 */
function simpleTextMatch(row: Record<string, unknown>, query: string): boolean {
  const q = query.toLowerCase();
  const fields = [row.title, row.description, row.entity_type, row.tags, row.llm_summary];
  return fields.some((f) => typeof f === "string" && f.toLowerCase().includes(q));
}

function dispatch(query: string, params: unknown[]): unknown[] {
  const q = query.toLowerCase();

  // --- wiki_pages: INSERT ... ON CONFLICT DO UPDATE (supports multi-row) ---
  if (q.includes("insert into") && q.includes("wiki_pages")) {
    const COLS = 26;
    const numRows = params.length / COLS;
    const rows: Record<string, unknown>[] = [];
    const now = new Date();
    for (let i = 0; i < numRows; i++) {
      const o = i * COLS;
      const id = params[o] as string;
      const existing = pagesStore.get(id);

      const row: Record<string, unknown> = {
        id,
        numeric_id: params[o + 1],
        title: params[o + 2],
        description: params[o + 3],
        llm_summary: params[o + 4],
        category: params[o + 5],
        subcategory: params[o + 6],
        entity_type: params[o + 7],
        tags: params[o + 8],
        quality: params[o + 9],
        reader_importance: params[o + 10],
        research_importance: params[o + 11],
        tactical_value: params[o + 12],
        backlink_count: params[o + 13],
        risk_category: params[o + 14],
        date_created: params[o + 15],
        recommended_score: params[o + 16],
        clusters: params[o + 17],
        hallucination_risk_level: params[o + 18],
        hallucination_risk_score: params[o + 19],
        content_plaintext: params[o + 20],
        word_count: params[o + 21],
        last_updated: params[o + 22],
        content_format: params[o + 23],
        synced_from_branch: params[o + 24],
        synced_from_commit: params[o + 25],
        synced_at: now,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };
      pagesStore.set(id, row);
      rows.push(row);
    }
    return rows;
  }

  // --- wiki_pages: UPDATE search_vector (after sync) ---
  if (q.includes("update wiki_pages") && q.includes("search_vector")) {
    return []; // No-op in tests — tsvector is a Postgres feature
  }

  // --- wiki_pages: Full-text search via search_vector (prefix tsquery or plain) ---
  if (q.includes("search_vector") && (q.includes("to_tsquery") || q.includes("plainto_tsquery")) && !q.includes("update")) {
    // First param is the tsquery string (e.g. "anthropic:*" for prefix search)
    const rawQuery = params[0] as string;
    // Strip :* suffixes and & operators to get plain search words
    const searchWords = rawQuery.replace(/:\*/g, "").replace(/\s*&\s*/g, " ").trim();
    const limit = (params[1] as number) || 20;
    const results: Record<string, unknown>[] = [];
    for (const row of pagesStore.values()) {
      if (simpleTextMatch(row, searchWords)) {
        results.push({
          id: row.id,
          numeric_id: row.numeric_id,
          title: row.title,
          description: row.description,
          entity_type: row.entity_type,
          category: row.category,
          reader_importance: row.reader_importance,
          quality: row.quality,
          rank: 1.0,
          snippet: row.description || null,
        });
      }
    }
    return results.slice(0, limit);
  }

  // --- wiki_pages: Trigram similarity fallback search ---
  if (q.includes("similarity") && q.includes("wiki_pages") && !q.includes("update")) {
    const searchQuery = params[0] as string;
    const limit = (params[1] as number) || 20;
    const excludeIds = (params[2] as string[]) || [];
    const results: Record<string, unknown>[] = [];
    for (const row of pagesStore.values()) {
      if (excludeIds.includes(row.id as string)) continue;
      if (simpleTextMatch(row, searchQuery)) {
        results.push({
          id: row.id,
          numeric_id: row.numeric_id,
          title: row.title,
          description: row.description,
          entity_type: row.entity_type,
          category: row.category,
          reader_importance: row.reader_importance,
          quality: row.quality,
          rank: 0.5,
          snippet: row.description || null,
        });
      }
    }
    return results.slice(0, limit);
  }

  // --- wiki_pages: SELECT with WHERE + OR (get by id or numeric_id) ---
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
  if (q.includes("wiki_pages") && q.includes("order by") && q.includes("limit") && !q.includes("count(*)")) {
    const allRows = Array.from(pagesStore.values()).sort((a, b) =>
      String(a.id ?? "").localeCompare(String(b.id ?? ""))
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

  // --- wiki_pages: DELETE WHERE id = ? RETURNING id ---
  if (q.includes("delete from") && q.includes("wiki_pages") && q.includes("returning")) {
    const id = params[0] as string;
    if (pagesStore.has(id)) {
      pagesStore.delete(id);
      return [{ id }];
    }
    return [];
  }

  // --- entity_ids: SELECT slug WHERE numeric_id = ? (numeric ID resolution) ---
  if (q.includes("entity_ids") && q.includes("where") && q.includes("numeric_id") && !q.includes("count(*)")) {
    const numericId = params[0] as number;
    const entry = entityIdsStore.get(numericId);
    if (entry) {
      return [{ slug: entry.slug }];
    }
    return [];
  }

  // --- entity_ids: COUNT (for health check) ---
  if (q.includes("count(*)") && !q.includes("wiki_pages")) {
    return [{ count: entityIdsStore.size }];
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

    it("returns page by numeric ID (legacy wiki_pages.numericId)", async () => {
      await seedPage(app, "anthropic", "Anthropic", { numericId: "E42" });

      const res = await app.request("/api/pages/E42");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe("anthropic");
    });

    it("returns page by numeric ID via entityIds table when wiki_pages.numericId is null", async () => {
      // Seed a page WITHOUT numericId (as most pages are in production)
      await seedPage(app, "anthropic", "Anthropic", { numericId: null });
      // Seed the entityIds mapping: E22 → anthropic
      entityIdsStore.set(22, { slug: "anthropic", description: null, created_at: new Date() });

      const res = await app.request("/api/pages/E22");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe("anthropic");
      expect(body.numericId).toBe("E22");
    });

    it("returns page by case-insensitive numeric ID", async () => {
      await seedPage(app, "anthropic", "Anthropic", { numericId: null });
      entityIdsStore.set(22, { slug: "anthropic", description: null, created_at: new Date() });

      // Lowercase e22 should also work
      const res = await app.request("/api/pages/e22");
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
      expect(body.results.length).toBeGreaterThan(0);
      expect(body.results[0].id).toBe("anthropic");
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

  // ---- Delete by ID ----

  describe("DELETE /api/pages/:id", () => {
    it("deletes an existing page and returns deleted count", async () => {
      await seedPage(app, "to-delete", "Page To Delete");

      const res = await app.request("/api/pages/to-delete", { method: "DELETE" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(1);

      // Confirm it's gone
      const getRes = await app.request("/api/pages/to-delete");
      expect(getRes.status).toBe(404);
    });

    it("returns 404 when page does not exist", async () => {
      const res = await app.request("/api/pages/nonexistent-page", { method: "DELETE" });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe("not_found");
    });

    it("deletes smoke-test page (mirrors workflow cleanup step)", async () => {
      // Seed the smoke-test page the same way the workflow does
      await postJson(app, "/api/pages/sync", {
        pages: [
          {
            id: "__smoke-test__",
            numericId: null,
            title: "Smoke Test",
            description: null,
            llmSummary: null,
            category: null,
            subcategory: null,
            entityType: null,
            tags: null,
            quality: null,
            readerImportance: null,
            hallucinationRiskLevel: null,
            hallucinationRiskScore: null,
            contentPlaintext: null,
            wordCount: null,
            lastUpdated: null,
            contentFormat: null,
          },
        ],
      });

      const res = await app.request("/api/pages/__smoke-test__", { method: "DELETE" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(1);
    });
  });

  // ---- Health check includes totalPages ----

  describe("Health check", () => {
    it("includes totalPages", async () => {
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.totalPages).toBeDefined();
    });
  });
});