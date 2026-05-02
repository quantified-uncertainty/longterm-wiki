import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { mockDbModule, postJson } from "./test-utils.js";

// ---- In-memory stores simulating Postgres tables ----

let pagesStore: Map<string, Record<string, unknown>>;
let entityIdsStore: Map<number, { slug: string; description: string | null; created_at: Date }>;
let modelAliasesStore: Array<{ alias: string; model_stable_id: string }>;
let entitiesStore: Map<string, { id: string; stable_id: string }>; // slug → row

function resetStores() {
  pagesStore = new Map();
  entityIdsStore = new Map();
  modelAliasesStore = [];
  entitiesStore = new Map();
}

/**
 * Simple in-memory text search to simulate PostgreSQL tsvector matching.
 * Searches title, description, entity_type, tags, and summary fields.
 */
function simpleTextMatch(row: Record<string, unknown>, query: string): boolean {
  const q = query.toLowerCase();
  const fields = [row.title, row.description, row.entity_type, row.tags, row.summary];
  return fields.some((f) => typeof f === "string" && f.toLowerCase().includes(q));
}

function dispatch(query: string, params: unknown[]): unknown[] {
  const q = query.toLowerCase();

  // --- entity_ids: INSERT (auto-allocation from page-id-helpers, supports bulk) ---
  if (q.includes("insert into") && q.includes("entity_ids")) {
    const rows: Array<{ wiki_id: number; slug: string }> = [];
    for (const p of params) {
      const slug = p as string;
      // Check if already exists (ON CONFLICT DO NOTHING)
      let found = false;
      for (const [numId, entry] of entityIdsStore.entries()) {
        if (entry.slug === slug) {
          found = true;
          break;
        }
      }
      if (!found) {
        const newId = entityIdsStore.size + 1;
        entityIdsStore.set(newId, { slug, description: null, created_at: new Date() });
        rows.push({ wiki_id: newId, slug });
      }
    }
    return rows;
  }

  // --- entity_ids: SELECT slug WHERE wiki_id = ? (resolve E-id → slug) ---
  // Must check for "wiki_id" in the WHERE clause specifically (not just SELECT list).
  // Drizzle generates: WHERE "entity_ids"."wiki_id" = $1
  if (q.includes("entity_ids") && q.includes("where") && q.includes('"wiki_id" =') && !q.includes("insert into")) {
    const wikiId = params[0] as number;
    const entry = entityIdsStore.get(wikiId);
    if (entry) {
      return [{ slug: entry.slug }];
    }
    return [];
  }

  // --- wiki_pages: SELECT WHERE slug IN (...) (batch resolve from page-id-helpers) ---
  // Must exclude OR queries (get-by-slug-or-wikiId), search queries, and other wiki_pages handlers.
  if (q.includes('from "wiki_pages"') && q.includes("where") && q.includes("slug") && q.includes(" in ") && !q.includes("count(*)") && !q.includes("insert into") && !q.includes(" or ") && !q.includes("as id")) {
    const results: Record<string, unknown>[] = [];
    for (const [numId, entry] of entityIdsStore.entries()) {
      if (params.includes(entry.slug)) {
        results.push({ id: numId, slug: entry.slug });
      }
    }
    return results;
  }

  // --- wiki_pages: INSERT ... ON CONFLICT DO UPDATE (supports multi-row) ---
  if (q.includes("insert into") && q.includes("wiki_pages")) {
    const COLS = 27; // id (integer PK), wiki_id, slug, title, ...
    const numRows = params.length / COLS;
    const rows: Record<string, unknown>[] = [];
    const now = new Date();
    for (let i = 0; i < numRows; i++) {
      const o = i * COLS;
      const id = params[o] as number; // integer PK
      const slug = params[o + 2] as string;
      const existing = pagesStore.get(slug);

      const row: Record<string, unknown> = {
        id,
        wiki_id: params[o + 1],
        slug,
        title: params[o + 3],
        description: params[o + 4],
        summary: params[o + 5],
        category: params[o + 6],
        subcategory: params[o + 7],
        entity_type: params[o + 8],
        tags: params[o + 9],
        quality: params[o + 10],
        reader_importance: params[o + 11],
        research_importance: params[o + 12],
        tactical_value: params[o + 13],
        backlink_count: params[o + 14],
        risk_category: params[o + 15],
        date_created: params[o + 16],
        recommended_score: params[o + 17],
        clusters: params[o + 18],
        hallucination_risk_level: params[o + 19],
        hallucination_risk_score: params[o + 20],
        content_plaintext: params[o + 21],
        word_count: params[o + 22],
        last_updated: params[o + 23],
        content_format: params[o + 24],
        synced_from_branch: params[o + 25],
        synced_from_commit: params[o + 26],
        synced_at: now,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };
      pagesStore.set(slug, row);
      rows.push(row);
    }
    return rows;
  }

  // --- wiki_pages: UPDATE search_vector (after sync) ---
  if (q.includes("update wiki_pages") && q.includes("search_vector")) {
    return []; // No-op in tests — tsvector is a Postgres feature
  }

  // --- wiki_pages: Full-text search via search_vector (prefix tsquery or plain) ---
  // Route uses `slug AS id` in the raw SQL SELECT, so `id` = the slug string.
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
          id: row.slug, // `slug AS id` in the raw SQL — id is the slug string, not the integer PK
          wiki_id: row.wiki_id,
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
  // Route uses `slug AS id` in the raw SQL SELECT.
  if (q.includes("similarity") && q.includes("wiki_pages") && !q.includes("update")) {
    const searchQuery = params[0] as string;
    const limit = (params[1] as number) || 20;
    const excludeIds = (params[2] as string[]) || [];
    const results: Record<string, unknown>[] = [];
    for (const row of pagesStore.values()) {
      if (excludeIds.includes(row.slug as string)) continue;
      if (simpleTextMatch(row, searchQuery)) {
        results.push({
          id: row.slug, // `slug AS id` in the raw SQL — id is the slug string
          wiki_id: row.wiki_id,
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

  // --- model_aliases JOIN entities JOIN wiki_pages: alias-based search (QUA-745) ---
  // Mirrors the Phase 3 SQL in apps/wiki-server/src/routes/wikibase/pages.ts:
  //   DISTINCT ON (wp.slug) ... ORDER BY wp.slug, rank DESC
  //   WHERE wp.entity_type = 'ai-model' AND wp.wiki_id IS NOT NULL
  //         AND (ma.alias = $1 OR ma.alias LIKE $2)
  //         AND wp.slug NOT IN excludeIds
  if (q.includes("model_aliases") && q.includes("join entities") && q.includes("join wiki_pages")) {
    const aliasLower = params[0] as string;
    const aliasPrefix = params[1] as string; // "alias%" form
    const limit = (params[2] as number) || 20;
    const excludeIds = (params[3] as string[]) || [];
    const prefixCore = aliasPrefix.endsWith("%") ? aliasPrefix.slice(0, -1) : aliasPrefix;

    // Step 1: collect all candidate (slug, rank) pairs that match the WHERE.
    type Candidate = { slug: string; row: Record<string, unknown>; rank: number };
    const candidates: Candidate[] = [];
    for (const a of modelAliasesStore) {
      const isExact = a.alias === aliasLower;
      const isPrefix = a.alias.startsWith(prefixCore);
      if (!isExact && !isPrefix) continue;

      const ent = Array.from(entitiesStore.values()).find(
        (e) => e.stable_id === a.model_stable_id,
      );
      if (!ent) continue;

      const page = pagesStore.get(ent.id);
      if (!page) continue;
      if (excludeIds.includes(page.slug as string)) continue;
      if (page.entity_type !== "ai-model") continue;
      if (page.wiki_id == null) continue;

      const rank = isExact ? 100.0 : 50.0;
      candidates.push({
        slug: page.slug as string,
        rank,
        row: {
          id: page.slug,
          wiki_id: page.wiki_id,
          title: page.title,
          description: page.description,
          entity_type: page.entity_type,
          category: page.category,
          reader_importance: page.reader_importance,
          quality: page.quality,
          rank,
          snippet: page.description || null,
        },
      });
    }

    // Step 2: DISTINCT ON (slug) — keep the highest-rank candidate per slug.
    const bySlug = new Map<string, Candidate>();
    for (const c of candidates) {
      const existing = bySlug.get(c.slug);
      if (!existing || c.rank > existing.rank) bySlug.set(c.slug, c);
    }

    // Step 3: sort by rank DESC (mimics the post-DISTINCT resort).
    const hits = Array.from(bySlug.values()).sort((a, b) => b.rank - a.rank);
    return hits.slice(0, limit).map((h) => h.row);
  }

  // --- wiki_pages: SELECT with WHERE + OR (get by slug or wiki_id) ---
  if (q.includes("wiki_pages") && q.includes("where") && q.includes(" or ") && !q.includes("count(*)")) {
    const slug = params[0] as string;
    const wikiId = params[1] as string;
    const results: Record<string, unknown>[] = [];
    for (const row of pagesStore.values()) {
      if (row.slug === slug || row.wiki_id === wikiId) {
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
      String(a.slug ?? "").localeCompare(String(b.slug ?? ""))
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

  // --- wiki_pages: SELECT WHERE slug = ? (no OR — pre-delete fetch) ---
  if (q.includes("wiki_pages") && q.includes("where") && !q.includes(" or ") && !q.includes("count(*)") && !q.includes("order by") && !q.includes("search_vector") && !q.includes("similarity") && !q.includes("delete from") && !q.includes("entity_ids")) {
    const slug = params[0] as string;
    const row = pagesStore.get(slug);
    return row ? [row] : [];
  }

  // --- Related tables: DELETE during page deletion (FK cleanup) ---
  // These tables are cleaned up in the transactional page delete handler.
  // The mock just returns an empty result (no rows affected is fine).
  const relatedDeleteTables = [
    "citation_quotes", "resource_citations", "citation_accuracy_snapshots",
    "edit_logs", "hallucination_risk_snapshots", "auto_update_results",
    "page_citations", "page_improve_runs", "wikibase_page_similarity",
    "wikibase_page_assessments", "page_links", "things",
  ];
  if (q.includes("delete from")) {
    for (const table of relatedDeleteTables) {
      if (q.includes(table)) return [];
    }
  }

  // --- wiki_pages: DELETE WHERE slug = ? (with or without RETURNING) ---
  if (q.includes("delete from") && q.includes("wiki_pages")) {
    const slug = params[0] as string;
    if (pagesStore.has(slug)) {
      const row = pagesStore.get(slug)!;
      pagesStore.delete(slug);
      return [{ id: row.id, slug }];
    }
    return [];
  }

  // --- entity_ids: SELECT slug WHERE wiki_id = ? (wiki ID resolution) ---
  if (q.includes("entity_ids") && q.includes("where") && q.includes("wiki_id") && !q.includes("count(*)")) {
    const wikiId = params[0] as number;
    const entry = entityIdsStore.get(wikiId);
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
        wikiId: opts.wikiId ?? `E${Math.floor(Math.random() * 1000)}`,
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
            wikiId: "E42",
            description: "AI safety company",
            category: "organizations",
            entityType: "organization",
          },
          {
            id: "openai",
            title: "OpenAI",
            wikiId: "E43",
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
        wikiId: "E42",
        description: "AI safety company",
      });

      const res = await app.request("/api/pages/anthropic");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe("anthropic");
      expect(body.title).toBe("Anthropic");
      expect(body.wikiId).toBe("E42");
    });

    it("returns page by wiki ID (legacy wiki_pages.wikiId)", async () => {
      await seedPage(app, "anthropic", "Anthropic", { wikiId: "E42" });

      const res = await app.request("/api/pages/E42");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe("anthropic");
    });

    it("returns page by wiki ID via entityIds table when wiki_pages.wikiId is null", async () => {
      // Seed a page WITHOUT wikiId (as most pages are in production)
      await seedPage(app, "anthropic", "Anthropic", { wikiId: null });
      // Seed the entityIds mapping: E22 → anthropic
      entityIdsStore.set(22, { slug: "anthropic", description: null, created_at: new Date() });

      const res = await app.request("/api/pages/E22");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe("anthropic");
      expect(body.wikiId).toBe("E22");
    });

    it("returns page by case-insensitive wiki ID", async () => {
      await seedPage(app, "anthropic", "Anthropic", { wikiId: null });
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

    // QUA-745 — alias-based search resolves external naming to canonical pages.
    it("resolves a model alias to the canonical wiki page", async () => {
      await seedPage(app, "gpt-4-turbo", "GPT-4 Turbo", {
        description: "OpenAI flagship turbo model",
        entityType: "ai-model",
      });
      // Seed the entity row + alias row that the alias-search SQL JOINs against.
      entitiesStore.set("gpt-4-turbo", {
        id: "gpt-4-turbo",
        stable_id: "sid_gpt4turbo",
      });
      modelAliasesStore.push({
        alias: "gpt-4-turbo-2024-04-09",
        model_stable_id: "sid_gpt4turbo",
      });

      const res = await app.request(
        "/api/pages/search?q=gpt-4-turbo-2024-04-09"
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results.length).toBeGreaterThan(0);
      expect(body.results[0].id).toBe("gpt-4-turbo");
    });

    it("does not match an alias whose target page has no wiki_id", async () => {
      await seedPage(app, "phantom-model", "Phantom Model", {
        wikiId: null,
        entityType: "ai-model",
      });
      entitiesStore.set("phantom-model", {
        id: "phantom-model",
        stable_id: "sid_phantom",
      });
      modelAliasesStore.push({
        alias: "phantom-2024-01-01",
        model_stable_id: "sid_phantom",
      });

      const res = await app.request(
        "/api/pages/search?q=phantom-2024-01-01"
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results).toHaveLength(0);
    });

    // Prefix match: a partial query like "claude-3-5" should still resolve
    // to the canonical page via an alias starting with that prefix.
    it("resolves an alias via prefix match", async () => {
      await seedPage(app, "claude-3-5-sonnet", "Claude 3.5 Sonnet", {
        entityType: "ai-model",
      });
      entitiesStore.set("claude-3-5-sonnet", {
        id: "claude-3-5-sonnet",
        stable_id: "sid_claude35sonnet",
      });
      modelAliasesStore.push({
        alias: "claude-3-5-sonnet-20240620",
        model_stable_id: "sid_claude35sonnet",
      });

      const res = await app.request(
        "/api/pages/search?q=claude-3-5-sonnet-2024",
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results.map((r: { id: string }) => r.id)).toContain(
        "claude-3-5-sonnet",
      );
    });

    // Dedup: when multiple aliases (one exact, one prefix-only) point at the
    // same model, the canonical page should appear exactly once.
    it("dedupes when multiple aliases point at the same model", async () => {
      await seedPage(app, "gpt-4-turbo", "GPT-4 Turbo", {
        entityType: "ai-model",
      });
      entitiesStore.set("gpt-4-turbo", {
        id: "gpt-4-turbo",
        stable_id: "sid_gpt4turbo",
      });
      modelAliasesStore.push(
        { alias: "gpt-4-turbo", model_stable_id: "sid_gpt4turbo" },
        {
          alias: "gpt-4-turbo-2024-04-09",
          model_stable_id: "sid_gpt4turbo",
        },
        {
          alias: "gpt-4-turbo-preview",
          model_stable_id: "sid_gpt4turbo",
        },
      );

      const res = await app.request("/api/pages/search?q=gpt-4-turbo");
      expect(res.status).toBe(200);
      const body = await res.json();
      const matches = body.results.filter(
        (r: { id: string }) => r.id === "gpt-4-turbo",
      );
      expect(matches).toHaveLength(1);
    });

    // Adversarial: a `%` in the user query must not act as a LIKE wildcard.
    // Without escapeIlike(), "%" would match every alias. The mock dispatch
    // uses startsWith for prefix matching which mirrors the escaped form.
    it("does not treat user input '%' as a LIKE wildcard", async () => {
      await seedPage(app, "claude-3-haiku", "Claude 3 Haiku", {
        entityType: "ai-model",
      });
      entitiesStore.set("claude-3-haiku", {
        id: "claude-3-haiku",
        stable_id: "sid_haiku",
      });
      modelAliasesStore.push({
        alias: "claude-3-haiku-20240307",
        model_stable_id: "sid_haiku",
      });

      // A bare "%" (or "_") should NOT match the haiku alias as a wildcard.
      const res = await app.request("/api/pages/search?q=%25");
      expect(res.status).toBe(200);
      const body = await res.json();
      // FTS / trigram may produce no results either; the assertion is that
      // the alias-search phase did NOT match haiku via wildcard expansion.
      expect(
        body.results.find((r: { id: string }) => r.id === "claude-3-haiku"),
      ).toBeUndefined();
    });

    // Defense in depth: even if an alias points at a non-ai-model entity
    // (corruption / future schema drift), it must NOT leak into search.
    it("rejects an alias whose target page is not entity_type=ai-model", async () => {
      await seedPage(app, "openai", "OpenAI", {
        // Wrong type — alias should not resolve here.
        entityType: "organization",
      });
      entitiesStore.set("openai", {
        id: "openai",
        stable_id: "sid_openai",
      });
      modelAliasesStore.push({
        alias: "openai-mystery-model",
        model_stable_id: "sid_openai",
      });

      const res = await app.request(
        "/api/pages/search?q=openai-mystery-model",
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
            wikiId: null,
            title: "Smoke Test",
            description: null,
            summary: null,
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