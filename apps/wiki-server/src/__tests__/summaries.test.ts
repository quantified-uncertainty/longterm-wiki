import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { mockDbModule, postJson } from "./test-utils.js";

// ---- In-memory store ----

let summaryStore: Map<string, Record<string, unknown>>;

function resetStores() {
  summaryStore = new Map();
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

  // ---- INSERT INTO summaries ... ON CONFLICT (supports multi-row) ----
  if (q.includes("insert into") && q.includes('"summaries"')) {
    const now = new Date();
    const PARAMS_PER_ROW = 9;
    const rowCount = Math.max(1, Math.floor(params.length / PARAMS_PER_ROW));
    const results: Record<string, unknown>[] = [];

    for (let i = 0; i < rowCount; i++) {
      const off = i * PARAMS_PER_ROW;
      const entityId = params[off] as string;
      const existing = summaryStore.get(entityId);

      const row: Record<string, unknown> = {
        entity_id: entityId,
        entity_type: params[off + 1],
        one_liner: params[off + 2],
        summary: params[off + 3],
        review: params[off + 4],
        key_points: params[off + 5],
        key_claims: params[off + 6],
        model: params[off + 7],
        tokens_used: params[off + 8],
        generated_at: now,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };
      summaryStore.set(entityId, row);
      results.push(row);
    }
    return results;
  }

  // ---- SELECT count(*) FROM summaries with GROUP BY entity_type ----
  if (
    q.includes("count(*)") &&
    q.includes('"summaries"') &&
    q.includes("group by") &&
    q.includes("entity_type")
  ) {
    const counts: Record<string, number> = {};
    for (const r of summaryStore.values()) {
      const t = (r.entity_type as string) ?? "unknown";
      counts[t] = (counts[t] || 0) + 1;
    }
    return Object.entries(counts)
      .map(([entity_type, count]) => ({ entity_type, count }))
      .sort((a, b) => b.count - a.count);
  }

  // ---- SELECT count(*) FROM summaries with GROUP BY model ----
  if (
    q.includes("count(*)") &&
    q.includes('"summaries"') &&
    q.includes("group by") &&
    q.includes("model")
  ) {
    const counts: Record<string, number> = {};
    for (const r of summaryStore.values()) {
      const m = (r.model as string) ?? "unknown";
      counts[m] = (counts[m] || 0) + 1;
    }
    return Object.entries(counts)
      .map(([model, count]) => ({ model, count }))
      .sort((a, b) => b.count - a.count);
  }

  // ---- SELECT count(*) FROM summaries (no GROUP BY, with optional WHERE) ----
  if (
    q.includes("count(*)") &&
    q.includes('"summaries"') &&
    !q.includes("group by")
  ) {
    if (q.includes("where") && params.length > 0) {
      let count = 0;
      for (const r of summaryStore.values()) {
        if (r.entity_type === params[0]) count++;
      }
      return [{ count }];
    }
    return [{ count: summaryStore.size }];
  }

  // ---- SELECT ... FROM summaries WHERE entity_id = $1 ----
  if (
    q.includes('"summaries"') &&
    q.includes("where") &&
    !q.includes("order by")
  ) {
    const entityId = params[0] as string;
    const r = summaryStore.get(entityId);
    return r ? [r] : [];
  }

  // ---- SELECT ... FROM summaries ORDER BY (paginated all) ----
  if (
    q.includes('"summaries"') &&
    q.includes("order by") &&
    q.includes("limit")
  ) {
    const allRows = Array.from(summaryStore.values()).sort((a, b) =>
      (a.entity_id as string).localeCompare(b.entity_id as string)
    );

    // Filter by entity_type if there's a WHERE clause
    let filtered = allRows;
    if (q.includes("where") && params.length >= 3) {
      filtered = allRows.filter((r) => r.entity_type === params[0]);
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

describe("Summaries API", () => {
  let app: Hono;

  beforeEach(() => {
    resetStores();
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    app = createApp();
  });

  const sampleSummary = {
    entityId: "anthropic",
    entityType: "organization",
    oneLiner: "An AI safety company",
    summary: "Anthropic is an AI safety company founded in 2021.",
    review: "Good overview of the organization.",
    keyPoints: ["Founded in 2021", "Focus on AI safety"],
    keyClaims: ["Leading AI safety lab"],
    model: "claude-3-opus",
    tokensUsed: 1500,
  };

  describe("POST /api/summaries", () => {
    it("upserts a single summary and returns 201", async () => {
      const res = await postJson(app, "/api/summaries", sampleSummary);
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.entityId).toBe("anthropic");
      expect(body.entityType).toBe("organization");
    });

    it("rejects missing required fields", async () => {
      const res = await postJson(app, "/api/summaries", {
        entityId: "test",
        // missing entityType
      });
      expect(res.status).toBe(400);
    });

    it("accepts summary with only required fields", async () => {
      const res = await postJson(app, "/api/summaries", {
        entityId: "minimal",
        entityType: "concept",
      });
      expect(res.status).toBe(201);
    });

    it("updates existing summary on upsert", async () => {
      await postJson(app, "/api/summaries", sampleSummary);
      expect(summaryStore.get("anthropic")?.one_liner).toBe(
        "An AI safety company"
      );

      const res = await postJson(app, "/api/summaries", {
        ...sampleSummary,
        oneLiner: "Updated one-liner",
      });
      expect(res.status).toBe(201);
      expect(summaryStore.get("anthropic")?.one_liner).toBe(
        "Updated one-liner"
      );
    });
  });

  describe("POST /api/summaries/batch", () => {
    it("inserts multiple summaries", async () => {
      const res = await postJson(app, "/api/summaries/batch", {
        items: [
          { entityId: "org1", entityType: "organization", oneLiner: "Org 1" },
          { entityId: "org2", entityType: "organization", oneLiner: "Org 2" },
        ],
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.inserted).toBe(2);
      expect(body.results).toHaveLength(2);
    });

    it("rejects empty batch", async () => {
      const res = await postJson(app, "/api/summaries/batch", { items: [] });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/summaries/stats", () => {
    it("returns aggregate statistics", async () => {
      await postJson(app, "/api/summaries", sampleSummary);
      await postJson(app, "/api/summaries", {
        entityId: "miri",
        entityType: "organization",
        model: "claude-3-opus",
      });
      await postJson(app, "/api/summaries", {
        entityId: "alignment",
        entityType: "concept",
        model: "gpt-4",
      });

      const res = await app.request("/api/summaries/stats");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(3);
      expect(body.byType).toHaveProperty("organization");
      expect(body.byType.organization).toBe(2);
      expect(body.byType).toHaveProperty("concept");
    });

    it("returns zeros when empty", async () => {
      const res = await app.request("/api/summaries/stats");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(0);
    });
  });

  describe("GET /api/summaries/all", () => {
    it("returns paginated summaries", async () => {
      for (let i = 0; i < 5; i++) {
        await postJson(app, "/api/summaries", {
          entityId: `entity-${String(i).padStart(2, "0")}`,
          entityType: "concept",
        });
      }

      const res = await app.request("/api/summaries/all?limit=2&offset=0");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.summaries).toHaveLength(2);
      expect(body.total).toBe(5);
      expect(body.limit).toBe(2);
      expect(body.offset).toBe(0);
    });
  });

  describe("GET /api/summaries/:entityId", () => {
    it("returns summary by entity ID", async () => {
      await postJson(app, "/api/summaries", sampleSummary);

      const res = await app.request("/api/summaries/anthropic");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.entityId).toBe("anthropic");
      expect(body.oneLiner).toBe("An AI safety company");
    });

    it("returns 404 for unknown entity ID", async () => {
      const res = await app.request("/api/summaries/nonexistent");
      expect(res.status).toBe(404);
    });
  });

  describe("Bearer auth", () => {
    it("rejects unauthenticated requests when API key is set", async () => {
      process.env.LONGTERMWIKI_SERVER_API_KEY = "test-key";
      const authedApp = createApp();

      const res = await authedApp.request("/api/summaries/stats");
      expect(res.status).toBe(401);
    });

    it("allows authenticated requests", async () => {
      process.env.LONGTERMWIKI_SERVER_API_KEY = "test-key";
      const authedApp = createApp();

      const res = await authedApp.request("/api/summaries/stats", {
        headers: { Authorization: "Bearer test-key" },
      });
      expect(res.status).toBe(200);
    });
  });
});