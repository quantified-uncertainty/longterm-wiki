import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { mockDbModule, postJson } from "./test-utils.js";

// ---- In-memory store simulating Postgres entities table ----

let entitiesStore: Map<string, Record<string, unknown>>;

function resetStores() {
  entitiesStore = new Map();
}

function dispatch(query: string, params: unknown[]): unknown[] {
  const q = query.toLowerCase();

  // Debug: uncomment to see queries

  // --- entities: INSERT ... ON CONFLICT DO UPDATE (supports multi-row) ---
  if (q.includes("insert into") && q.includes('"entities"')) {
    const COLS = 13;
    const numRows = params.length / COLS;
    const rows: Record<string, unknown>[] = [];
    const now = new Date();
    for (let i = 0; i < numRows; i++) {
      const o = i * COLS;
      const id = params[o] as string;
      const existing = entitiesStore.get(id);

      const row: Record<string, unknown> = {
        id,
        numeric_id: params[o + 1],
        entity_type: params[o + 2],
        title: params[o + 3],
        description: params[o + 4],
        website: params[o + 5],
        tags: params[o + 6],
        clusters: params[o + 7],
        status: params[o + 8],
        last_updated: params[o + 9],
        custom_fields: params[o + 10],
        related_entries: params[o + 11],
        sources: params[o + 12],
        synced_at: now,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };
      entitiesStore.set(id, row);
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

  // --- entities: SELECT with WHERE + OR (get by id or numeric_id) ---
  if (
    q.includes('"entities"') &&
    q.includes("where") &&
    q.includes(" or ") &&
    !q.includes("count(*)")
  ) {
    const id = params[0] as string;
    const numericId = params[1] as string;
    const results: Record<string, unknown>[] = [];
    for (const row of entitiesStore.values()) {
      if (row.id === id || row.numeric_id === numericId) {
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
        numericId: opts.numericId ?? `E${Math.floor(Math.random() * 1000)}`,
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
            title: "Anthropic",
            entityType: "organization",
            numericId: "E22",
            description: "AI safety company",
          },
          {
            id: "openai",
            title: "OpenAI",
            entityType: "organization",
            numericId: "E43",
            description: "AI research lab",
          },
        ],
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.upserted).toBe(2);
    });

    it("updates existing entities", async () => {
      await seedEntity(app, "anthropic", "Anthropic");

      const res = await postJson(app, "/api/entities/sync", {
        entities: [
          {
            id: "anthropic",
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
        entities: [{ id: "no-title", entityType: "concept" }],
      });
      expect(res.status).toBe(400);
    });

    it("rejects entities without entityType", async () => {
      const res = await postJson(app, "/api/entities/sync", {
        entities: [{ id: "no-type", title: "No Type" }],
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
        numericId: "E22",
        description: "AI safety company",
      });

      const res = await app.request("/api/entities/anthropic");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe("anthropic");
      expect(body.title).toBe("Anthropic");
      expect(body.numericId).toBe("E22");
    });

    it("returns entity by numeric ID", async () => {
      await seedEntity(app, "anthropic", "Anthropic", { numericId: "E22" });

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
      const res = await postJson(app, "/api/entities/sync", {
        entities: [
          {
            id: "anthropic",
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

  // ---- Auth ----

  describe("Bearer auth", () => {
    it("rejects unauthenticated sync when API key is set", async () => {
      process.env.LONGTERMWIKI_SERVER_API_KEY = "test-secret";
      const authedApp = createApp();

      const res = await postJson(authedApp, "/api/entities/sync", {
        entities: [
          {
            id: "anthropic",
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
              title: "Anthropic",
              entityType: "organization",
            },
          ],
        }),
      });

      expect(res.status).toBe(200);
    });
  });
});
