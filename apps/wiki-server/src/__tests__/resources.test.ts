import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { mockDbModule, postJson } from "./test-utils.js";

// ---- In-memory stores ----

let resourceStore: Map<string, Record<string, unknown>>;
let citationStore: Array<{ resource_id: string; page_slug: string; page_id: number; created_at: Date }>;

// Lightweight resource store for /suggest endpoint tests.
// Stores resources with the simplified shape returned by the suggest lookup query.
let suggestResourceStore: Map<string, { id: string; url: string; title: string | null; fetched_at: Date | null; has_content: boolean }>;

let nextSlugIntId = 1000;
const slugIntIdMap = new Map<string, number>();

function getIntIdForSlug(slug: string): number {
  if (!slugIntIdMap.has(slug)) {
    slugIntIdMap.set(slug, nextSlugIntId++);
  }
  return slugIntIdMap.get(slug)!;
}

/** Non-allocating lookup — returns undefined for slugs not yet in the map. */
function lookupIntIdForSlug(slug: string): number | undefined {
  return slugIntIdMap.get(slug);
}

/** Reverse-lookup: recover slug from integer ID. */
function slugFromIntId(intId: number | null): string | null {
  if (intId === null) return null;
  for (const [slug, id] of slugIntIdMap.entries()) {
    if (id === intId) return slug;
  }
  return null;
}

function resetStores() {
  resourceStore = new Map();
  citationStore = [];
  suggestResourceStore = new Map();
  nextSlugIntId = 1000;
  slugIntIdMap.clear();
}

function dispatch(query: string, params: unknown[]): unknown[] {
  const q = query.toLowerCase();

  // ---- entity_ids (health check) ----
  if (q.includes("count(*)") && q.includes("entity_ids")) {
    return [{ count: 0 }];
  }
  if (q.includes("last_value")) {
    return [{ last_value: 0, is_called: false }];
  }

  // ---- wiki_pages: SELECT WHERE slug (for resolvePageIntId/resolvePageIntIds) ----
  // Must use 'from "wiki_pages"' to avoid matching JOIN queries that also reference wiki_pages.
  if (q.includes('from "wiki_pages"') && q.includes("where") && q.includes("slug") && !q.includes("as id")) {
    // Allocating on first use mirrors production where all page slugs have wiki_pages rows.
    return params.map((p) => ({ id: getIntIdForSlug(String(p)), slug: p }));
  }

  // ---- ref-check: SELECT id FROM wiki_pages WHERE id IN (...) ----
  if (q.includes("as id from") && q.includes("where") && q.includes(" in ")) {
    return params.map((p) => ({ id: p }));
  }

  // ---- TRUNCATE ----
  if (q.includes("truncate") && q.includes("resource_citations")) {
    citationStore = [];
    return [];
  }
  if (q.includes("truncate") && q.includes("resources")) {
    resourceStore = new Map();
    return [];
  }

  // ---- UPDATE resources SET search_vector (no-op in tests) ----
  // Must check for "update resources" to avoid matching SELECT queries that contain
  // "updated_at" + "search_vector" (e.g., the full-text search query)
  if (q.includes("update resources") && q.includes("set search_vector")) {
    return [];
  }

  // ---- INSERT INTO resources ... ON CONFLICT (supports multi-row) ----
  if (q.includes("insert into") && q.includes('"resources"') && !q.includes("resource_citations")) {
    const now = new Date();
    const COLS = 27; // Number of columns in resourceValues()
    const numRows = Math.max(1, Math.floor(params.length / COLS));
    const results: Record<string, unknown>[] = [];

    for (let r = 0; r < numRows; r++) {
      const o = r * COLS;
      const id = params[o] as string;
      const existing = resourceStore.get(id);

      const row: Record<string, unknown> = {
        id,
        url: params[o + 1],
        // COALESCE(incoming, existing): non-null incoming overwrites; null preserves existing.
        title: params[o + 2] ?? existing?.title ?? null,
        type: params[o + 3] ?? existing?.type ?? null,
        summary: params[o + 4] ?? existing?.summary ?? null,
        review: params[o + 5] ?? existing?.review ?? null,
        abstract: params[o + 6] ?? existing?.abstract ?? null,
        key_points: params[o + 7] ?? existing?.key_points ?? null,
        publication_id: params[o + 8] ?? existing?.publication_id ?? null,
        authors: params[o + 9] ?? existing?.authors ?? null,
        published_date: params[o + 10] ?? existing?.published_date ?? null,
        tags: params[o + 11] ?? existing?.tags ?? null,
        local_filename: params[o + 12] ?? existing?.local_filename ?? null,
        credibility_override: params[o + 13] ?? existing?.credibility_override ?? null,
        fetched_at: params[o + 14] ?? existing?.fetched_at ?? null,
        content_hash: params[o + 15] ?? existing?.content_hash ?? null,
        // stableId is generate-once: preserve existing, only set if row didn't have one
        stable_id: existing?.stable_id ?? params[o + 16] ?? null,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };
      resourceStore.set(id, row);
      results.push(row);
    }
    return results;
  }

  // ---- DELETE FROM resource_citations WHERE resource_id ... ----
  if (q.includes("delete") && q.includes("resource_citations") && q.includes("where")) {
    // Supports both single-row (= $1) and bulk (IN ($1, $2, ...)) deletes
    for (const p of params) {
      const resourceId = p as string;
      citationStore = citationStore.filter((c) => c.resource_id !== resourceId);
    }
    return [];
  }

  // ---- INSERT INTO resource_citations (supports multi-row) ----
  // Params: resource_id, page_id (integer)
  if (q.includes("insert into") && q.includes("resource_citations")) {
    const COLS = 2; // resource_id, page_id
    const numRows = params.length / COLS;
    for (let i = 0; i < numRows; i++) {
      const o = i * COLS;
      const resourceId = params[o] as string;
      const pageId = params[o + 1] as number;
      const slug = slugFromIntId(pageId) ?? `page-${pageId}`;
      const exists = citationStore.some(
        (c) => c.resource_id === resourceId && c.page_id === pageId
      );
      if (!exists) {
        citationStore.push({
          resource_id: resourceId,
          page_slug: slug,
          page_id: pageId,
          created_at: new Date(),
        });
      }
    }
    return [];
  }

  // ---- SELECT count(distinct page_id) FROM resource_citations ----
  if (q.includes("count(distinct") && q.includes("resource_citations")) {
    const uniquePages = new Set(citationStore.map((c) => c.page_id));
    return [{ page_id: uniquePages.size }];
  }

  // ---- SELECT count(*) FROM resource_citations (not GROUP BY) ----
  if (q.includes("count(*)") && q.includes("resource_citations") && !q.includes("group by")) {
    return [{ count: citationStore.length }];
  }

  // ---- SELECT count(*) FROM resources with GROUP BY type ----
  if (q.includes("count(*)") && q.includes('"resources"') && q.includes("group by")) {
    const counts: Record<string, number> = {};
    for (const r of resourceStore.values()) {
      const t = (r.type as string) ?? "unknown";
      counts[t] = (counts[t] || 0) + 1;
    }
    return Object.entries(counts)
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count);
  }

  // ---- SELECT count(*) FROM resources (no GROUP BY, with optional WHERE) ----
  if (q.includes("count(*)") && q.includes('"resources"') && !q.includes("group by")) {
    if (q.includes("where") && params.length > 0) {
      let count = 0;
      for (const r of resourceStore.values()) {
        if (r.type === params[0]) count++;
      }
      return [{ count }];
    }
    return [{ count: resourceStore.size }];
  }

  // ---- SELECT ... FROM resource_citations INNER JOIN resources (by-page) ----
  if (q.includes("resource_citations") && q.includes("inner join") && q.includes('"resources"')) {
    const intId = params[0] as number;
    const results: Record<string, unknown>[] = [];
    for (const c of citationStore) {
      if (c.page_id === intId) {
        const r = resourceStore.get(c.resource_id);
        if (r) {
          results.push({
            id: r.id,
            url: r.url,
            title: r.title,
            type: r.type,
            publication_id: r.publication_id,
            authors: r.authors,
            published_date: r.published_date,
          });
        }
      }
    }
    return results;
  }

  // ---- SELECT wiki_pages.slug FROM resource_citations LEFT JOIN wiki_pages WHERE resource_id = $1 ----
  // Returns slug via LEFT JOIN wiki_pages
  if (q.includes("resource_citations") && q.includes("where") && !q.includes("delete") && !q.includes("count")) {
    const resourceId = params[0] as string;
    return citationStore
      .filter((c) => c.resource_id === resourceId)
      .map((c) => ({ slug: c.page_slug })); // wiki_pages.slug
  }

  // ---- /suggest: SELECT ... FROM resources r LEFT JOIN citation_content cc WHERE r.url = ANY(...) ----
  // Tagged template: query has "from resources" + "left join citation_content" + "any($)"
  if (q.includes("from resources") && q.includes("citation_content") && q.includes("any($)")) {
    const urlList = params[0] as string[];
    const results: Record<string, unknown>[] = [];
    for (const url of urlList) {
      const r = suggestResourceStore.get(url);
      if (r) results.push({ ...r });
    }
    // If query has LIMIT 1, return at most 1 (fallback query in suggest)
    if (q.includes("limit 1")) return results.slice(0, 1);
    return results;
  }

  // ---- /suggest: INSERT INTO resources ... unnest ... RETURNING (bulk create for new URLs) ----
  if (q.includes("insert into resources") && q.includes("unnest")) {
    const ids = params[0] as string[];
    const urls = params[1] as string[];
    const results: Record<string, unknown>[] = [];
    for (let i = 0; i < ids.length; i++) {
      const row = { id: ids[i], url: urls[i], title: null, fetched_at: null, has_content: false };
      suggestResourceStore.set(urls[i], row);
      results.push(row);
    }
    return results;
  }

  // ---- Full-text search (raw SQL with to_tsquery or plainto_tsquery) ----
  // Tagged template: params = [prefixQuery, prefixQuery, limit] (interpolated values in order)
  // unsafe(): params = [prefixQuery, limit]
  if ((q.includes("to_tsquery") || q.includes("plainto_tsquery")) && q.includes("resources")) {
    const rawQuery = (params[0] as string);
    // Strip :* suffixes and & operators to get plain search words
    const searchTerm = rawQuery.replace(/:\*/g, "").replace(/\s*&\s*/g, " ").trim().toLowerCase();
    // The limit is always the last param (a number); earlier params are query strings.
    const lastParam = params[params.length - 1];
    const limit = (typeof lastParam === "number" ? lastParam : 20);
    const results: Record<string, unknown>[] = [];
    for (const r of resourceStore.values()) {
      const title = ((r.title as string) || "").toLowerCase();
      const summary = ((r.summary as string) || "").toLowerCase();
      const abstract = ((r.abstract as string) || "").toLowerCase();
      const review = ((r.review as string) || "").toLowerCase();
      if (title.includes(searchTerm) || summary.includes(searchTerm) ||
          abstract.includes(searchTerm) || review.includes(searchTerm)) {
        results.push({ ...r, rank: 1.0 });
      }
    }
    return results.slice(0, limit);
  }

  // ---- SELECT ... FROM resources WHERE url = $1 (lookup) ----
  // Check the WHERE clause portion specifically for "url" = pattern
  if (q.includes('"resources"') && q.includes("where") && !q.includes("order by")) {
    const whereClause = q.split("where")[1] || "";
    if (whereClause.includes('"url"')) {
      const url = params[0] as string;
      for (const r of resourceStore.values()) {
        if (r.url === url) return [r];
      }
      return [];
    }
    // ---- SELECT ... FROM resources WHERE id = $1 ----
    if (whereClause.includes('"id"')) {
      const id = params[0] as string;
      const r = resourceStore.get(id);
      return r ? [r] : [];
    }
  }

  // ---- SELECT ... FROM resources ORDER BY (paginated all) ----
  if (q.includes('"resources"') && q.includes("order by") && q.includes("limit")) {
    const allRows = Array.from(resourceStore.values()).sort((a, b) =>
      (a.id as string).localeCompare(b.id as string)
    );

    // Filter by type if there's a WHERE clause
    let filtered = allRows;
    if (q.includes("where") && params.length >= 3) {
      filtered = allRows.filter((r) => r.type === params[0]);
      const limit = (params[1] as number) || 50;
      const offset = (params[2] as number) || 0;
      return filtered.slice(offset, offset + limit);
    }

    const limit = (params[0] as number) || 50;
    const offset = (params[1] as number) || 0;
    return filtered.slice(offset, offset + limit);
  }

  return [];
}

// Mock the db module before importing routes
vi.mock("../db.js", () => mockDbModule(dispatch));

const { createApp } = await import("../app.js");

// ---- Tests ----

describe("Resources API", () => {
  let app: Hono;

  beforeEach(() => {
    resetStores();
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    app = createApp();
  });

  const sampleResource = {
    id: "abc123def456",
    url: "https://arxiv.org/abs/2310.19852",
    title: "AI Alignment: A Comprehensive Survey",
    type: "paper",
    summary: "A survey of AI alignment techniques",
    authors: ["Ji, Jiaming", "Qiu, Tianyi"],
    tags: ["alignment", "safety"],
    publicationId: "arxiv",
    publishedDate: "2023-10-30",
  };

  describe("POST /api/resources", () => {
    it("upserts a single resource and returns 201", async () => {
      const res = await postJson(app, "/api/resources", sampleResource);
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBe("abc123def456");
      expect(body.url).toBe("https://arxiv.org/abs/2310.19852");
    });

    it("rejects missing required fields", async () => {
      const res = await postJson(app, "/api/resources", {
        id: "test",
        // missing url
      });
      expect(res.status).toBe(400);
    });

    it("rejects invalid URL", async () => {
      const res = await postJson(app, "/api/resources", {
        id: "test",
        url: "not-a-url",
      });
      expect(res.status).toBe(400);
    });

    it("accepts resource with only required fields", async () => {
      const res = await postJson(app, "/api/resources", {
        id: "minimal",
        url: "https://example.com",
      });
      expect(res.status).toBe(201);
    });

    it("handles citedBy field", async () => {
      const res = await postJson(app, "/api/resources", {
        ...sampleResource,
        citedBy: ["page-a", "page-b"],
      });
      expect(res.status).toBe(201);
      expect(citationStore).toHaveLength(2);
      expect(citationStore[0].page_slug).toBe("page-a");
    });

    it("updates existing resource on upsert (same id, different data)", async () => {
      // First insert
      await postJson(app, "/api/resources", sampleResource);
      expect(resourceStore.get("abc123def456")?.title).toBe(
        "AI Alignment: A Comprehensive Survey"
      );

      // Upsert with new title
      const res = await postJson(app, "/api/resources", {
        ...sampleResource,
        title: "Updated Title",
      });
      expect(res.status).toBe(201);
      expect(resourceStore.get("abc123def456")?.title).toBe("Updated Title");
    });

    it("preserves existing enriched fields when upserting bare resource (COALESCE)", async () => {
      // First insert: a fully enriched resource
      await postJson(app, "/api/resources", {
        ...sampleResource,
        summary: "A comprehensive survey of AI alignment approaches.",
        review: "Excellent overview of the field.",
        abstract: "This paper surveys alignment techniques...",
        keyPoints: ["Point 1", "Point 2"],
        authors: ["Author A", "Author B"],
        publishedDate: "2025-01-15",
        tags: ["alignment", "survey"],
      });
      const enriched = resourceStore.get("abc123def456");
      expect(enriched?.summary).toBe("A comprehensive survey of AI alignment approaches.");

      // Upsert with bare resource (only id + url) — should NOT wipe enriched fields
      const res = await postJson(app, "/api/resources", {
        id: "abc123def456",
        url: "https://arxiv.org/abs/2310.12345",
      });
      expect(res.status).toBe(201);

      const afterBare = resourceStore.get("abc123def456");
      // Enriched text fields should be preserved (COALESCE(null, existing) = existing)
      expect(afterBare?.summary).toBe("A comprehensive survey of AI alignment approaches.");
      expect(afterBare?.review).toBe("Excellent overview of the field.");
      expect(afterBare?.abstract).toBe("This paper surveys alignment techniques...");
      expect(afterBare?.published_date).toBe("2025-01-15");
      // Array fields are serialized as JSON strings by Drizzle's PG driver;
      // the important thing is they are preserved (not nulled out)
      expect(afterBare?.authors).toBeTruthy();
      expect(afterBare?.key_points).toBeTruthy();
      expect(afterBare?.tags).toBeTruthy();
    });

    it("overwrites enriched fields when new non-null values are provided", async () => {
      // First insert with summary
      await postJson(app, "/api/resources", {
        ...sampleResource,
        summary: "Original summary",
      });

      // Upsert with new summary — should overwrite
      const res = await postJson(app, "/api/resources", {
        ...sampleResource,
        summary: "Updated summary",
      });
      expect(res.status).toBe(201);

      const updated = resourceStore.get("abc123def456");
      expect(updated?.summary).toBe("Updated summary");
    });
  });

  describe("POST /api/resources/batch", () => {
    it("inserts multiple resources", async () => {
      const res = await postJson(app, "/api/resources/batch", {
        items: [
          { id: "res1", url: "https://example.com/1", type: "paper" },
          { id: "res2", url: "https://example.com/2", type: "web" },
        ],
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.upserted).toBe(2);
      expect(body.results).toHaveLength(2);
    });

    it("rejects empty batch", async () => {
      const res = await postJson(app, "/api/resources/batch", { items: [] });
      expect(res.status).toBe(400);
    });

    it("accepts resources with >100 authors", async () => {
      const manyAuthors = Array.from({ length: 150 }, (_, i) => `Author ${i + 1}`);
      const res = await postJson(app, "/api/resources/batch", {
        items: [
          { id: "big-collab", url: "https://example.com/collab", authors: manyAuthors },
        ],
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.upserted).toBe(1);
    });
  });

  describe("GET /api/resources/search", () => {
    it("searches by title", async () => {
      await postJson(app, "/api/resources", sampleResource);
      await postJson(app, "/api/resources", {
        id: "other",
        url: "https://example.com/other",
        title: "Unrelated paper",
      });

      const res = await app.request("/api/resources/search?q=alignment");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results.length).toBeGreaterThanOrEqual(1);
    });

    it("requires query parameter", async () => {
      const res = await app.request("/api/resources/search");
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/resources/stats", () => {
    it("returns aggregate statistics", async () => {
      await postJson(app, "/api/resources", sampleResource);
      await postJson(app, "/api/resources", {
        id: "res2",
        url: "https://example.com/2",
        type: "web",
        citedBy: ["some-page"],
      });

      const res = await app.request("/api/resources/stats");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.totalResources).toBe(2);
      expect(body.totalCitations).toBe(1);
      expect(body.byType).toHaveProperty("paper");
      expect(body.byType).toHaveProperty("web");
    });

    it("returns zeros when empty", async () => {
      const res = await app.request("/api/resources/stats");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.totalResources).toBe(0);
    });
  });

  describe("GET /api/resources/by-page/:pageId", () => {
    it("returns resources cited by a page", async () => {
      await postJson(app, "/api/resources", {
        ...sampleResource,
        citedBy: ["my-page"],
      });
      await postJson(app, "/api/resources", {
        id: "other",
        url: "https://example.com/other",
        citedBy: ["other-page"],
      });

      const res = await app.request("/api/resources/by-page/my-page");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.resources).toHaveLength(1);
      expect(body.resources[0].id).toBe("abc123def456");
    });

    it("returns empty for unknown page", async () => {
      const res = await app.request("/api/resources/by-page/nonexistent");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.resources).toHaveLength(0);
    });
  });

  describe("GET /api/resources/lookup?url=X", () => {
    it("returns resource by URL", async () => {
      await postJson(app, "/api/resources", sampleResource);

      const res = await app.request(
        `/api/resources/lookup?url=${encodeURIComponent("https://arxiv.org/abs/2310.19852")}`
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe("abc123def456");
    });

    it("returns 404 for unknown URL", async () => {
      const res = await app.request(
        "/api/resources/lookup?url=https://unknown.com"
      );
      expect(res.status).toBe(404);
    });

    it("requires url parameter", async () => {
      const res = await app.request("/api/resources/lookup");
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/resources/:id", () => {
    it("returns resource by ID with citations", async () => {
      await postJson(app, "/api/resources", {
        ...sampleResource,
        citedBy: ["page-a", "page-b"],
      });

      const res = await app.request("/api/resources/abc123def456");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe("abc123def456");
      expect(body.title).toBe("AI Alignment: A Comprehensive Survey");
      expect(body.citedBy).toEqual(["page-a", "page-b"]);
    });

    it("returns 404 for unknown ID", async () => {
      const res = await app.request("/api/resources/nonexistent");
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/resources/all", () => {
    it("returns paginated resources", async () => {
      for (let i = 0; i < 5; i++) {
        await postJson(app, "/api/resources", {
          id: `res-${String(i).padStart(2, "0")}`,
          url: `https://example.com/${i}`,
          type: "paper",
        });
      }

      const res = await app.request("/api/resources/all?limit=2&offset=0");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.resources).toHaveLength(2);
      expect(body.total).toBe(5);
      expect(body.limit).toBe(2);
      expect(body.offset).toBe(0);
    });
  });

  describe("POST /api/resources/suggest — variant collision handling", () => {
    it("resolves both URLs when they are www-variants of each other and one exists in DB", async () => {
      // Pre-populate: the DB has the www version stored
      suggestResourceStore.set("https://www.example.com", {
        id: "existing-res-1",
        url: "https://www.example.com",
        title: "Example Site",
        fetched_at: new Date(),
        has_content: true,
      });

      // Submit both the www and non-www URLs
      const res = await postJson(app, "/api/resources/suggest", {
        urls: ["https://example.com", "https://www.example.com"],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results).toHaveLength(2);

      // Both should resolve to existing resources (not fall through to toCreate)
      // The www URL matches exactly; the non-www URL matches via variant lookup
      const nonWwwResult = body.results.find((r: any) => r.url === "https://example.com");
      const wwwResult = body.results.find((r: any) => r.url === "https://www.example.com");

      expect(wwwResult).toBeDefined();
      expect(wwwResult.resourceId).toBe("existing-res-1");
      expect(wwwResult.contentStatus).toBe("fresh");

      expect(nonWwwResult).toBeDefined();
      expect(nonWwwResult.resourceId).toBe("existing-res-1");
      // Both found via the same existing resource — neither should be "missing" from a newly created resource
      expect(nonWwwResult.contentStatus).toBe("fresh");
    });

    it("resolves both URLs when DB has the non-www version stored", async () => {
      // Pre-populate: the DB has the non-www version stored
      suggestResourceStore.set("https://example.com", {
        id: "existing-res-2",
        url: "https://example.com",
        title: "Example Site",
        fetched_at: new Date(),
        has_content: true,
      });

      const res = await postJson(app, "/api/resources/suggest", {
        urls: ["https://example.com", "https://www.example.com"],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results).toHaveLength(2);

      // Both should resolve to the existing resource
      for (const result of body.results) {
        expect(result.resourceId).toBe("existing-res-2");
        expect(result.contentStatus).toBe("fresh");
      }
    });

    it("prefers exact URL match over variant match when both exist in DB", async () => {
      // DB has both www and non-www as separate resources
      suggestResourceStore.set("https://example.com", {
        id: "res-no-www",
        url: "https://example.com",
        title: "No WWW Version",
        fetched_at: new Date(),
        has_content: true,
      });
      suggestResourceStore.set("https://www.example.com", {
        id: "res-with-www",
        url: "https://www.example.com",
        title: "WWW Version",
        fetched_at: new Date(),
        has_content: true,
      });

      const res = await postJson(app, "/api/resources/suggest", {
        urls: ["https://example.com", "https://www.example.com"],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results).toHaveLength(2);

      const nonWwwResult = body.results.find((r: any) => r.url === "https://example.com");
      const wwwResult = body.results.find((r: any) => r.url === "https://www.example.com");

      // Each input URL should prefer its exact match over the variant
      expect(nonWwwResult.resourceId).toBe("res-no-www");
      expect(wwwResult.resourceId).toBe("res-with-www");
    });

    it("creates new resource only for genuinely unknown URLs", async () => {
      // DB has one URL; submit it along with a truly new URL
      suggestResourceStore.set("https://known.com", {
        id: "known-res",
        url: "https://known.com",
        title: "Known Resource",
        fetched_at: null,
        has_content: false,
      });

      const res = await postJson(app, "/api/resources/suggest", {
        urls: ["https://known.com", "https://brand-new.com"],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results).toHaveLength(2);

      const knownResult = body.results.find((r: any) => r.url === "https://known.com");
      const newResult = body.results.find((r: any) => r.url === "https://brand-new.com");

      expect(knownResult.resourceId).toBe("known-res");
      // The new URL should get a freshly created resource
      expect(newResult.resourceId).toBeTruthy();
      expect(newResult.resourceId).not.toBe("known-res");
      expect(newResult.contentStatus).toBe("missing");
    });

    it("handles trailing slash variants correctly", async () => {
      // DB stores URL with trailing slash
      suggestResourceStore.set("https://example.com/page/", {
        id: "slash-res",
        url: "https://example.com/page/",
        title: "Page With Slash",
        fetched_at: new Date(),
        has_content: true,
      });

      // Request without trailing slash — should match via variant
      const res = await postJson(app, "/api/resources/suggest", {
        urls: ["https://example.com/page"],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results).toHaveLength(1);
      expect(body.results[0].resourceId).toBe("slash-res");
      expect(body.results[0].contentStatus).toBe("fresh");
    });

    it("deduplicates identical input URLs", async () => {
      suggestResourceStore.set("https://example.com", {
        id: "dedup-res",
        url: "https://example.com",
        title: "Dedup Test",
        fetched_at: new Date(),
        has_content: true,
      });

      const res = await postJson(app, "/api/resources/suggest", {
        urls: ["https://example.com", "https://example.com", "https://example.com"],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      // Deduplication via new Set(urls) means 3 identical URLs → 1 unique → 1 result
      expect(body.results).toHaveLength(1);
      for (const result of body.results) {
        expect(result.resourceId).toBe("dedup-res");
      }
    });
  });
});
