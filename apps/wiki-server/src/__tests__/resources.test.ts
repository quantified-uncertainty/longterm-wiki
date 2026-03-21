import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { mockDbModule, postJson } from "./test-utils.js";

// ---- In-memory stores ----

let resourceStore: Map<string, Record<string, unknown>>;
let citationStore: Array<{ resource_id: string; page_id: string; page_id_int: number; created_at: Date }>;

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

  // ---- entity_ids: SELECT WHERE slug (for resolvePageIntId/resolvePageIntIds) ----
  if (q.includes("entity_ids") && q.includes("where") && q.includes("slug")) {
    // Allocating on first use mirrors production where all page slugs have entity_ids.
    // Phase C verified zero NULLs, so every slug encountered here will have an ID.
    return params.map((p) => ({ wiki_id: getIntIdForSlug(String(p)), slug: p }));
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
  // Phase D2a: page_id_old is no longer sent. Params: resource_id, page_id_int
  if (q.includes("insert into") && q.includes("resource_citations")) {
    const COLS = 2; // Phase D2a: resource_id, page_id_int
    const numRows = params.length / COLS;
    for (let i = 0; i < numRows; i++) {
      const o = i * COLS;
      const resourceId = params[o] as string;
      const pageIdInt = params[o + 1] as number;
      const slug = slugFromIntId(pageIdInt) ?? `page-${pageIdInt}`;
      const exists = citationStore.some(
        (c) => c.resource_id === resourceId && c.page_id_int === pageIdInt
      );
      if (!exists) {
        citationStore.push({
          resource_id: resourceId,
          page_id: slug,
          page_id_int: pageIdInt,
          created_at: new Date(),
        });
      }
    }
    return [];
  }

  // ---- SELECT count(distinct page_id_int) FROM resource_citations ----
  if (q.includes("count(distinct") && q.includes("resource_citations")) {
    const uniquePages = new Set(citationStore.map((c) => c.page_id_int));
    return [{ page_id_int: uniquePages.size }];
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

  // ---- SELECT ... FROM resource_citations INNER JOIN resources (by-page, Phase 4b) ----
  if (q.includes("resource_citations") && q.includes("inner join") && q.includes('"resources"')) {
    const intId = params[0] as number;
    const results: Record<string, unknown>[] = [];
    for (const c of citationStore) {
      if (c.page_id_int === intId) {
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

  // ---- SELECT wiki_pages.id FROM resource_citations LEFT JOIN wiki_pages WHERE resource_id = $1 ----
  // Phase D2a: returns slug via LEFT JOIN wiki_pages (simulated by slugFromIntId)
  if (q.includes("resource_citations") && q.includes("where") && !q.includes("delete") && !q.includes("count")) {
    const resourceId = params[0] as string;
    return citationStore
      .filter((c) => c.resource_id === resourceId)
      .map((c) => ({ id: c.page_id })); // wiki_pages.id = slug
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
      expect(citationStore[0].page_id).toBe("page-a");
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
});
