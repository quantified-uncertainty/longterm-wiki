import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { mockDbModule, postJson } from "./test-utils.js";

// ---- In-memory store ----

let claimStore: Map<number, Record<string, unknown>>;
let nextId: number;

function resetStores() {
  claimStore = new Map();
  nextId = 1;
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

  // ---- INSERT INTO claims ----
  if (q.includes("insert into") && q.includes('"claims"')) {
    const now = new Date();
    const id = nextId++;
    const row: Record<string, unknown> = {
      id,
      entity_id: params[0],
      entity_type: params[1],
      claim_type: params[2],
      claim_text: params[3],
      value: params[4],
      unit: params[5],
      confidence: params[6],
      source_quote: params[7],
      created_at: now,
      updated_at: now,
    };
    claimStore.set(id, row);
    return [row];
  }

  // ---- DELETE FROM claims WHERE entity_id = $1 ----
  if (q.includes("delete") && q.includes('"claims"') && q.includes("where")) {
    const entityId = params[0] as string;
    const deleted: Record<string, unknown>[] = [];
    for (const [id, row] of claimStore) {
      if (row.entity_id === entityId) {
        deleted.push(row);
        claimStore.delete(id);
      }
    }
    return deleted;
  }

  // ---- SELECT count(*) FROM claims with GROUP BY claim_type ----
  if (
    q.includes("count(*)") &&
    q.includes('"claims"') &&
    q.includes("group by") &&
    q.includes("claim_type")
  ) {
    const counts: Record<string, number> = {};
    for (const r of claimStore.values()) {
      const t = r.claim_type as string;
      counts[t] = (counts[t] || 0) + 1;
    }
    return Object.entries(counts)
      .map(([claim_type, count]) => ({ claim_type, count }))
      .sort((a, b) => b.count - a.count);
  }

  // ---- SELECT count(*) FROM claims with GROUP BY entity_type ----
  if (
    q.includes("count(*)") &&
    q.includes('"claims"') &&
    q.includes("group by") &&
    q.includes("entity_type")
  ) {
    const counts: Record<string, number> = {};
    for (const r of claimStore.values()) {
      const t = r.entity_type as string;
      counts[t] = (counts[t] || 0) + 1;
    }
    return Object.entries(counts)
      .map(([entity_type, count]) => ({ entity_type, count }))
      .sort((a, b) => b.count - a.count);
  }

  // ---- SELECT count(*) FROM claims (no GROUP BY, with optional WHERE) ----
  if (
    q.includes("count(*)") &&
    q.includes('"claims"') &&
    !q.includes("group by")
  ) {
    if (q.includes("where")) {
      let count = 0;
      for (const r of claimStore.values()) {
        // Check both entityType and claimType filters
        let match = true;
        let paramIdx = 0;
        if (q.includes("entity_type")) {
          if (r.entity_type !== params[paramIdx]) match = false;
          paramIdx++;
        }
        if (q.includes("claim_type")) {
          if (r.claim_type !== params[paramIdx]) match = false;
        }
        if (match) count++;
      }
      return [{ count }];
    }
    return [{ count: claimStore.size }];
  }

  // ---- SELECT ... FROM claims WHERE entity_id = $1 (by-entity) ----
  if (
    q.includes('"claims"') &&
    q.includes("where") &&
    q.includes("order by")
  ) {
    const whereClause = q.split("where")[1] || "";
    if (whereClause.includes('"entity_id"')) {
      const entityId = params[0] as string;
      return Array.from(claimStore.values())
        .filter((r) => r.entity_id === entityId)
        .sort((a, b) => {
          const typeCompare = (a.claim_type as string).localeCompare(
            b.claim_type as string
          );
          if (typeCompare !== 0) return typeCompare;
          return (a.id as number) - (b.id as number);
        });
    }
  }

  // ---- SELECT ... FROM claims WHERE id = $1 (get by ID) ----
  if (
    q.includes('"claims"') &&
    q.includes("where") &&
    q.includes("limit") &&
    !q.includes("order by")
  ) {
    const whereClause = q.split("where")[1] || "";
    if (whereClause.includes('"id"')) {
      const id = params[0] as number;
      const r = claimStore.get(id);
      return r ? [r] : [];
    }
  }

  // ---- SELECT ... FROM claims ORDER BY (paginated all) ----
  if (
    q.includes('"claims"') &&
    q.includes("order by") &&
    q.includes("limit")
  ) {
    const allRows = Array.from(claimStore.values()).sort(
      (a, b) => (a.id as number) - (b.id as number)
    );

    // Filter by conditions if there's a WHERE clause
    let filtered = allRows;
    if (q.includes("where") && params.length >= 3) {
      filtered = allRows.filter((r) => {
        let match = true;
        let paramIdx = 0;
        if (q.includes("entity_type")) {
          if (r.entity_type !== params[paramIdx]) match = false;
          paramIdx++;
        }
        if (q.includes("claim_type")) {
          if (r.claim_type !== params[paramIdx]) match = false;
          paramIdx++;
        }
        return match;
      });
      // Last two params are limit and offset
      const limit = (params[params.length - 2] as number) || 50;
      const offset = (params[params.length - 1] as number) || 0;
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

describe("Claims API", () => {
  let app: Hono;

  beforeEach(() => {
    resetStores();
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    app = createApp();
  });

  const sampleClaim = {
    entityId: "anthropic",
    entityType: "organization",
    claimType: "founding_date",
    claimText: "Anthropic was founded in 2021",
    value: "2021",
    unit: "year",
    confidence: "high",
    sourceQuote: "Founded in 2021 by former members of OpenAI",
  };

  describe("POST /api/claims", () => {
    it("inserts a single claim and returns 201", async () => {
      const res = await postJson(app, "/api/claims", sampleClaim);
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.entityId).toBe("anthropic");
      expect(body.claimType).toBe("founding_date");
      expect(body.id).toBeDefined();
    });

    it("rejects missing required fields", async () => {
      const res = await postJson(app, "/api/claims", {
        entityId: "test",
        entityType: "concept",
        // missing claimType and claimText
      });
      expect(res.status).toBe(400);
    });

    it("accepts claim with only required fields", async () => {
      const res = await postJson(app, "/api/claims", {
        entityId: "minimal",
        entityType: "concept",
        claimType: "definition",
        claimText: "A minimal claim",
      });
      expect(res.status).toBe(201);
    });

    it("assigns unique IDs to each claim", async () => {
      const res1 = await postJson(app, "/api/claims", sampleClaim);
      const res2 = await postJson(app, "/api/claims", {
        ...sampleClaim,
        claimText: "Another claim",
      });
      const body1 = await res1.json();
      const body2 = await res2.json();
      expect(body1.id).not.toBe(body2.id);
    });
  });

  describe("POST /api/claims/batch", () => {
    it("inserts multiple claims", async () => {
      const res = await postJson(app, "/api/claims/batch", {
        items: [
          {
            entityId: "anthropic",
            entityType: "organization",
            claimType: "founding_date",
            claimText: "Founded in 2021",
          },
          {
            entityId: "anthropic",
            entityType: "organization",
            claimType: "employee_count",
            claimText: "Has 1000+ employees",
          },
        ],
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.inserted).toBe(2);
      expect(body.results).toHaveLength(2);
    });

    it("rejects empty batch", async () => {
      const res = await postJson(app, "/api/claims/batch", { items: [] });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/claims/clear", () => {
    it("deletes all claims for an entity", async () => {
      await postJson(app, "/api/claims", sampleClaim);
      await postJson(app, "/api/claims", {
        ...sampleClaim,
        claimType: "employee_count",
        claimText: "Has 1000+ employees",
      });
      await postJson(app, "/api/claims", {
        entityId: "miri",
        entityType: "organization",
        claimType: "founding_date",
        claimText: "Founded in 2000",
      });

      expect(claimStore.size).toBe(3);

      const res = await postJson(app, "/api/claims/clear", {
        entityId: "anthropic",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(2);
      expect(claimStore.size).toBe(1);
    });

    it("returns 0 for unknown entity", async () => {
      const res = await postJson(app, "/api/claims/clear", {
        entityId: "nonexistent",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(0);
    });
  });

  describe("GET /api/claims/stats", () => {
    it("returns aggregate statistics", async () => {
      await postJson(app, "/api/claims", sampleClaim);
      await postJson(app, "/api/claims", {
        entityId: "miri",
        entityType: "organization",
        claimType: "founding_date",
        claimText: "Founded in 2000",
      });
      await postJson(app, "/api/claims", {
        entityId: "alignment",
        entityType: "concept",
        claimType: "definition",
        claimText: "AI alignment means...",
      });

      const res = await app.request("/api/claims/stats");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(3);
      expect(body.byClaimType).toHaveProperty("founding_date");
      expect(body.byClaimType.founding_date).toBe(2);
      expect(body.byEntityType).toHaveProperty("organization");
    });

    it("returns zeros when empty", async () => {
      const res = await app.request("/api/claims/stats");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(0);
    });
  });

  describe("GET /api/claims/by-entity/:entityId", () => {
    it("returns claims for an entity", async () => {
      await postJson(app, "/api/claims", sampleClaim);
      await postJson(app, "/api/claims", {
        ...sampleClaim,
        claimType: "employee_count",
        claimText: "Has 1000+ employees",
      });
      await postJson(app, "/api/claims", {
        entityId: "miri",
        entityType: "organization",
        claimType: "founding_date",
        claimText: "Founded in 2000",
      });

      const res = await app.request("/api/claims/by-entity/anthropic");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.claims).toHaveLength(2);
    });

    it("returns empty for unknown entity", async () => {
      const res = await app.request("/api/claims/by-entity/nonexistent");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.claims).toHaveLength(0);
    });
  });

  describe("GET /api/claims/all", () => {
    it("returns paginated claims", async () => {
      for (let i = 0; i < 5; i++) {
        await postJson(app, "/api/claims", {
          entityId: `entity-${i}`,
          entityType: "concept",
          claimType: "definition",
          claimText: `Claim ${i}`,
        });
      }

      const res = await app.request("/api/claims/all?limit=2&offset=0");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.claims).toHaveLength(2);
      expect(body.total).toBe(5);
      expect(body.limit).toBe(2);
      expect(body.offset).toBe(0);
    });
  });

  describe("GET /api/claims/:id", () => {
    it("returns claim by ID", async () => {
      const createRes = await postJson(app, "/api/claims", sampleClaim);
      const created = await createRes.json();

      const res = await app.request(`/api/claims/${created.id}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.entityId).toBe("anthropic");
      expect(body.claimText).toBe("Anthropic was founded in 2021");
    });

    it("returns 404 for unknown ID", async () => {
      const res = await app.request("/api/claims/999");
      expect(res.status).toBe(404);
    });

    it("returns 400 for non-numeric ID", async () => {
      const res = await app.request("/api/claims/abc");
      expect(res.status).toBe(400);
    });
  });

  describe("Bearer auth", () => {
    it("rejects unauthenticated requests when API key is set", async () => {
      process.env.LONGTERMWIKI_SERVER_API_KEY = "test-key";
      const authedApp = createApp();

      const res = await authedApp.request("/api/claims/stats");
      expect(res.status).toBe(401);
    });

    it("allows authenticated requests", async () => {
      process.env.LONGTERMWIKI_SERVER_API_KEY = "test-key";
      const authedApp = createApp();

      const res = await authedApp.request("/api/claims/stats", {
        headers: { Authorization: "Bearer test-key" },
      });
      expect(res.status).toBe(200);
    });
  });
});
