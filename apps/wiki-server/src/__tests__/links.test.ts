import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { mockDbModule, postJson } from "./test-utils.js";

// ---- In-memory stores ----

interface LinkRow {
  id: number;
  source_id: string;
  target_id: string;
  link_type: string;
  relationship: string | null;
  weight: number;
  created_at: Date;
}

interface PageRow {
  id: string;
  title: string;
  entity_type: string | null;
  quality: number | null;
  reader_importance: number | null;
  [key: string]: unknown;
}

let linksStore: Map<string, LinkRow>;
let pagesStore: Map<string, PageRow>;
let nextId: number;

function resetStores() {
  linksStore = new Map();
  pagesStore = new Map();
  nextId = 1;
}

function linkKey(sourceId: string, targetId: string, linkType: string) {
  return `${sourceId}|${targetId}|${linkType}`;
}

function dispatch(query: string, params: unknown[]): unknown[] {
  const q = query.toLowerCase();

  // --- page_links: DELETE all ---
  if (q.includes("delete from") && q.includes("page_links")) {
    linksStore.clear();
    return [];
  }

  // --- page_links: INSERT ... ON CONFLICT DO UPDATE (multi-row) ---
  if (q.includes("insert into") && q.includes("page_links")) {
    const COLS = 5;
    const numRows = params.length / COLS;
    const rows: LinkRow[] = [];
    const now = new Date();
    for (let i = 0; i < numRows; i++) {
      const o = i * COLS;
      const row: LinkRow = {
        id: nextId++,
        source_id: params[o] as string,
        target_id: params[o + 1] as string,
        link_type: params[o + 2] as string,
        relationship: (params[o + 3] as string) || null,
        weight: params[o + 4] as number,
        created_at: now,
      };
      const key = linkKey(row.source_id, row.target_id, row.link_type);
      const existing = linksStore.get(key);
      if (existing) {
        // Update on conflict
        existing.weight = row.weight;
        existing.relationship = row.relationship;
        rows.push(existing);
      } else {
        linksStore.set(key, row);
        rows.push(row);
      }
    }
    return rows;
  }

  // --- page_links: DISTINCT ON backlinks query ---
  if (
    q.includes("page_links") &&
    q.includes("distinct on") &&
    q.includes("target_id")
  ) {
    const targetId = params[0] as string;
    const limit = (params[1] as number) || 50;
    const results: Record<string, unknown>[] = [];
    const seen = new Set<string>();

    for (const row of linksStore.values()) {
      if (row.target_id === targetId && !seen.has(row.source_id)) {
        seen.add(row.source_id);
        const page = pagesStore.get(row.source_id);
        results.push({
          source_id: row.source_id,
          link_type: row.link_type,
          relationship: row.relationship,
          weight: row.weight,
          source_title: page?.title || null,
          source_type: page?.entity_type || null,
        });
      }
    }
    return results.slice(0, limit);
  }

  // --- page_links: bidirectional links CTE (related endpoint) ---
  if (q.includes("bidirectional_links") || q.includes("aggregated")) {
    const entityId = params[0] as string;
    const minScore = params[2] as number;
    const limit = (params[3] as number) || 75;

    // Gather bidirectional links
    const neighborScores = new Map<string, number>();
    const neighborRelationship = new Map<string, string | null>();

    for (const row of linksStore.values()) {
      let neighborId: string | null = null;
      if (row.source_id === entityId) neighborId = row.target_id;
      else if (row.target_id === entityId) neighborId = row.source_id;
      if (!neighborId || neighborId === entityId) continue;

      neighborScores.set(
        neighborId,
        (neighborScores.get(neighborId) || 0) + row.weight
      );
      if (
        row.link_type === "yaml_related" &&
        row.relationship &&
        !neighborRelationship.has(neighborId)
      ) {
        neighborRelationship.set(neighborId, row.relationship);
      }
    }

    // Apply quality boost and filter
    const results: Record<string, unknown>[] = [];
    for (const [neighborId, rawScore] of neighborScores) {
      const page = pagesStore.get(neighborId);
      const q2 = page?.quality ?? 5;
      const imp = page?.reader_importance ?? 50;
      const score = rawScore * (1.0 + q2 / 40.0 + imp / 400.0);
      if (score < minScore) continue;

      results.push({
        id: neighborId,
        raw_score: rawScore,
        relationship: neighborRelationship.get(neighborId) || null,
        title: page?.title || null,
        entity_type: page?.entity_type || null,
        quality: page?.quality ?? null,
        reader_importance: page?.reader_importance ?? null,
        score,
      });
    }

    results.sort(
      (a, b) => (b.score as number) - (a.score as number)
    );
    return results.slice(0, limit);
  }

  // --- page_links: graph query ---
  if (
    q.includes("page_links") &&
    (q.includes("source_title") || q.includes("target_title")) &&
    !q.includes("distinct on") &&
    !q.includes("bidirectional")
  ) {
    const entityId = params[0] as string;
    const results: Record<string, unknown>[] = [];

    for (const row of linksStore.values()) {
      if (row.source_id === entityId || row.target_id === entityId) {
        const sourcePage = pagesStore.get(row.source_id);
        const targetPage = pagesStore.get(row.target_id);
        results.push({
          source_id: row.source_id,
          target_id: row.target_id,
          link_type: row.link_type,
          relationship: row.relationship,
          weight: row.weight,
          source_title: sourcePage?.title || null,
          source_type: sourcePage?.entity_type || null,
          target_title: targetPage?.title || null,
          target_type: targetPage?.entity_type || null,
        });
      }
    }

    results.sort(
      (a, b) => (b.weight as number) - (a.weight as number)
    );
    return results;
  }

  // --- page_links: stats (count by type) ---
  if (q.includes("link_type") && q.includes("group by") && q.includes("avg")) {
    const byType = new Map<string, { count: number; totalWeight: number }>();
    for (const row of linksStore.values()) {
      const entry = byType.get(row.link_type) || {
        count: 0,
        totalWeight: 0,
      };
      entry.count++;
      entry.totalWeight += row.weight;
      byType.set(row.link_type, entry);
    }
    return Array.from(byType).map(([type, { count, totalWeight }]) => ({
      link_type: type,
      count,
      avg_weight: (totalWeight / count).toFixed(2),
    }));
  }

  // --- page_links: total count ---
  if (
    q.includes("count(*)") &&
    q.includes("page_links") &&
    !q.includes("distinct")
  ) {
    return [{ total: linksStore.size }];
  }

  // --- page_links: unique sources/targets ---
  if (q.includes("distinct source_id") && q.includes("distinct target_id")) {
    const sources = new Set<string>();
    const targets = new Set<string>();
    for (const row of linksStore.values()) {
      sources.add(row.source_id);
      targets.add(row.target_id);
    }
    return [{ sources: sources.size, targets: targets.size }];
  }

  // --- wiki_pages: INSERT (for seeding) ---
  if (q.includes("insert into") && q.includes("wiki_pages")) {
    const COLS = 17;
    const numRows = params.length / COLS;
    const rows: PageRow[] = [];
    for (let i = 0; i < numRows; i++) {
      const o = i * COLS;
      const row: PageRow = {
        id: params[o] as string,
        title: params[o + 2] as string,
        entity_type: (params[o + 7] as string) || null,
        quality: (params[o + 9] as number) || null,
        reader_importance: (params[o + 10] as number) || null,
      };
      pagesStore.set(row.id, row);
      rows.push(row);
    }
    return rows;
  }

  // --- wiki_pages: search vector update ---
  if (q.includes("update wiki_pages") && q.includes("search_vector")) {
    return [];
  }

  // --- health check fallbacks ---
  if (q.includes("count(*)")) {
    return [{ count: 0 }];
  }
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

function syncLinks(app: Hono, links: unknown[], replace = false) {
  return postJson(app, "/api/links/sync", { links, replace });
}

// ---- Tests ----

describe("Links API", () => {
  let app: Hono;

  beforeEach(() => {
    resetStores();
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    app = createApp();
  });

  // ---- Sync ----

  describe("POST /api/links/sync", () => {
    it("creates new links", async () => {
      const res = await syncLinks(app, [
        {
          sourceId: "anthropic",
          targetId: "ai-safety",
          linkType: "yaml_related",
          relationship: "supports",
          weight: 10,
        },
        {
          sourceId: "openai",
          targetId: "ai-safety",
          linkType: "yaml_related",
          relationship: "contributes-to",
          weight: 10,
        },
      ]);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(2);
    });

    it("upserts on conflict", async () => {
      await syncLinks(app, [
        {
          sourceId: "anthropic",
          targetId: "ai-safety",
          linkType: "yaml_related",
          weight: 5,
        },
      ]);

      const res = await syncLinks(app, [
        {
          sourceId: "anthropic",
          targetId: "ai-safety",
          linkType: "yaml_related",
          weight: 10,
        },
      ]);

      expect(res.status).toBe(200);
      // Weight should be updated
    });

    it("replaces all links when replace=true", async () => {
      await syncLinks(app, [
        {
          sourceId: "old-source",
          targetId: "old-target",
          linkType: "entity_link",
          weight: 5,
        },
      ]);

      const res = await syncLinks(
        app,
        [
          {
            sourceId: "new-source",
            targetId: "new-target",
            linkType: "entity_link",
            weight: 5,
          },
        ],
        true
      );

      expect(res.status).toBe(200);
      // Old links should be deleted
      expect(linksStore.size).toBe(1);
      expect(linksStore.has("new-source|new-target|entity_link")).toBe(true);
    });

    it("rejects empty batch", async () => {
      const res = await syncLinks(app, []);
      expect(res.status).toBe(400);
    });

    it("rejects invalid link type", async () => {
      const res = await syncLinks(app, [
        {
          sourceId: "a",
          targetId: "b",
          linkType: "invalid_type",
          weight: 1,
        },
      ]);
      expect(res.status).toBe(400);
    });
  });

  // ---- Backlinks ----

  describe("GET /api/links/backlinks/:id", () => {
    it("returns backlinks for a target entity", async () => {
      await seedPage(app, "anthropic", "Anthropic", {
        entityType: "organization",
      });
      await seedPage(app, "openai", "OpenAI", { entityType: "organization" });
      await seedPage(app, "ai-safety", "AI Safety", { entityType: "concept" });

      await syncLinks(app, [
        {
          sourceId: "anthropic",
          targetId: "ai-safety",
          linkType: "yaml_related",
          relationship: "supports",
          weight: 10,
        },
        {
          sourceId: "openai",
          targetId: "ai-safety",
          linkType: "entity_link",
          weight: 5,
        },
      ]);

      const res = await app.request("/api/links/backlinks/ai-safety");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.targetId).toBe("ai-safety");
      expect(body.backlinks).toHaveLength(2);
      expect(body.backlinks.map((b: any) => b.id).sort()).toEqual([
        "anthropic",
        "openai",
      ]);
    });

    it("returns empty array for entity with no backlinks", async () => {
      const res = await app.request("/api/links/backlinks/nonexistent");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.backlinks).toHaveLength(0);
    });

    it("includes relationship labels", async () => {
      await syncLinks(app, [
        {
          sourceId: "misalignment",
          targetId: "existential-risk",
          linkType: "yaml_related",
          relationship: "causes",
          weight: 10,
        },
      ]);

      const res = await app.request("/api/links/backlinks/existential-risk");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.backlinks[0].relationship).toBe("causes");
    });
  });

  // ---- Related ----

  describe("GET /api/links/related/:id", () => {
    it("returns related pages with scores", async () => {
      await seedPage(app, "anthropic", "Anthropic", {
        entityType: "organization",
        quality: 80,
        readerImportance: 90,
      });
      await seedPage(app, "openai", "OpenAI", {
        entityType: "organization",
        quality: 70,
        readerImportance: 85,
      });
      await seedPage(app, "ai-safety", "AI Safety", {
        entityType: "concept",
        quality: 60,
        readerImportance: 70,
      });

      await syncLinks(app, [
        {
          sourceId: "anthropic",
          targetId: "ai-safety",
          linkType: "yaml_related",
          weight: 10,
        },
        {
          sourceId: "anthropic",
          targetId: "openai",
          linkType: "entity_link",
          weight: 5,
        },
      ]);

      const res = await app.request("/api/links/related/anthropic");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.entityId).toBe("anthropic");
      expect(body.related.length).toBeGreaterThan(0);
      // Each entry should have id, type, title, score
      for (const item of body.related) {
        expect(item.id).toBeDefined();
        expect(item.type).toBeDefined();
        expect(item.score).toBeGreaterThanOrEqual(MIN_SCORE);
      }
    });

    it("returns empty for entity with no links", async () => {
      const res = await app.request("/api/links/related/nonexistent");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.related).toHaveLength(0);
    });

    it("computes bidirectional scores", async () => {
      await seedPage(app, "a", "Entity A", { quality: 50, readerImportance: 50 });
      await seedPage(app, "b", "Entity B", { quality: 50, readerImportance: 50 });

      // Link from A → B
      await syncLinks(app, [
        {
          sourceId: "a",
          targetId: "b",
          linkType: "yaml_related",
          weight: 10,
        },
      ]);

      // Both A and B should see each other as related
      const resA = await app.request("/api/links/related/a");
      const bodyA = await resA.json();
      expect(bodyA.related.some((r: any) => r.id === "b")).toBe(true);

      const resB = await app.request("/api/links/related/b");
      const bodyB = await resB.json();
      expect(bodyB.related.some((r: any) => r.id === "a")).toBe(true);
    });
  });

  // ---- Graph ----

  describe("GET /api/links/graph/:id", () => {
    it("returns graph data with nodes and edges", async () => {
      await seedPage(app, "anthropic", "Anthropic", {
        entityType: "organization",
      });
      await seedPage(app, "ai-safety", "AI Safety", {
        entityType: "concept",
      });

      await syncLinks(app, [
        {
          sourceId: "anthropic",
          targetId: "ai-safety",
          linkType: "yaml_related",
          relationship: "supports",
          weight: 10,
        },
      ]);

      const res = await app.request("/api/links/graph/anthropic");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.entityId).toBe("anthropic");
      expect(body.nodes).toHaveLength(2);
      expect(body.edges).toHaveLength(1);
      expect(body.edges[0].source).toBe("anthropic");
      expect(body.edges[0].target).toBe("ai-safety");
      expect(body.edges[0].relationship).toBe("supports");
    });
  });

  // ---- Stats ----

  describe("GET /api/links/stats", () => {
    it("returns link statistics", async () => {
      await syncLinks(app, [
        {
          sourceId: "a",
          targetId: "b",
          linkType: "yaml_related",
          weight: 10,
        },
        {
          sourceId: "c",
          targetId: "d",
          linkType: "entity_link",
          weight: 5,
        },
        {
          sourceId: "a",
          targetId: "d",
          linkType: "entity_link",
          weight: 5,
        },
      ]);

      const res = await app.request("/api/links/stats");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(3);
      expect(body.byType).toHaveLength(2);
    });
  });
});

// Reference constant from the route
const MIN_SCORE = 1.0;
