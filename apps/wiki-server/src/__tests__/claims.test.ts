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

/** Parse a JSONB param that may arrive as a JSON string from Drizzle */
function parseJsonbParam(val: unknown): unknown {
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch { return val; }
  }
  return val ?? null;
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
    // Count parameters per row: 8 original + 6 enhanced columns = 14
    const PARAMS_PER_ROW = 14;
    const rowCount = Math.max(1, Math.floor(params.length / PARAMS_PER_ROW));
    const results: Record<string, unknown>[] = [];

    for (let i = 0; i < rowCount; i++) {
      const off = i * PARAMS_PER_ROW;
      const id = nextId++;
      const row: Record<string, unknown> = {
        id,
        entity_id: params[off],
        entity_type: params[off + 1],
        claim_type: params[off + 2],
        claim_text: params[off + 3],
        value: params[off + 4],
        unit: params[off + 5],
        confidence: params[off + 6],
        source_quote: params[off + 7],
        // Enhanced fields (migration 0028)
        // JSONB values arrive as JSON strings from Drizzle — parse them back
        claim_category: params[off + 8],
        related_entities: parseJsonbParam(params[off + 9]),
        fact_id: params[off + 10],
        resource_ids: parseJsonbParam(params[off + 11]),
        section: params[off + 12],
        footnote_refs: params[off + 13],
        created_at: now,
        updated_at: now,
      };
      claimStore.set(id, row);
      results.push(row);
    }
    return results;
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

  // ---- SELECT count(*) FROM claims with GROUP BY claim_category ----
  if (
    q.includes("count(*)") &&
    q.includes('"claims"') &&
    q.includes("group by") &&
    q.includes("claim_category")
  ) {
    const counts: Record<string, number> = {};
    for (const r of claimStore.values()) {
      const t = (r.claim_category as string) ?? "uncategorized";
      counts[t] = (counts[t] || 0) + 1;
    }
    return Object.entries(counts)
      .map(([claim_category, count]) => ({ claim_category, count }))
      .sort((a, b) => b.count - a.count);
  }

  // ---- SELECT count(*) FROM claims WHERE related_entities IS NOT NULL (multi-entity) ----
  if (
    q.includes("count(*)") &&
    q.includes('"claims"') &&
    q.includes("related_entities") &&
    q.includes("is not null")
  ) {
    let count = 0;
    for (const r of claimStore.values()) {
      const re = r.related_entities;
      if (re && Array.isArray(re) && re.length > 0) count++;
    }
    return [{ count }];
  }

  // ---- SELECT count(*) FROM claims WHERE fact_id IS NOT NULL ----
  if (
    q.includes("count(*)") &&
    q.includes('"claims"') &&
    q.includes("fact_id") &&
    q.includes("is not null")
  ) {
    let count = 0;
    for (const r of claimStore.values()) {
      if (r.fact_id) count++;
    }
    return [{ count }];
  }

  // ---- SELECT count(*) FROM claims (no GROUP BY, with optional WHERE) ----
  if (
    q.includes("count(*)") &&
    q.includes('"claims"') &&
    !q.includes("group by")
  ) {
    if (q.includes("where")) {
      // Extract WHERE portion to avoid matching column names in SELECT
      const whereClause = q.split("where")[1] ?? "";
      let count = 0;
      for (const r of claimStore.values()) {
        // Check entityType, claimType, and claimCategory filters
        let match = true;
        let paramIdx = 0;
        if (whereClause.includes("entity_type")) {
          if (r.entity_type !== params[paramIdx]) match = false;
          paramIdx++;
        }
        if (whereClause.includes("claim_type")) {
          if (r.claim_type !== params[paramIdx]) match = false;
          paramIdx++;
        }
        if (whereClause.includes("claim_category")) {
          if (r.claim_category !== params[paramIdx]) match = false;
        }
        if (match) count++;
      }
      return [{ count }];
    }
    return [{ count: claimStore.size }];
  }

  // ---- SELECT ... FROM claims WHERE entity_id = $1 OR related_entities @> ... (by-entity) ----
  // Distinguish from /all queries by checking the WHERE clause specifically uses "entity_id" =
  if (
    q.includes('"claims"') &&
    q.includes("where") &&
    q.includes("order by") &&
    !q.includes("limit") &&
    (q.includes('"entity_id" =') || q.includes("related_entities @>"))
  ) {
    const entityId = params[0] as string;
    return Array.from(claimStore.values())
      .filter((r) => {
        if (r.entity_id === entityId) return true;
        // Check relatedEntities JSONB array
        const re = r.related_entities;
        if (Array.isArray(re) && re.includes(entityId)) return true;
        return false;
      })
      .sort((a, b) => {
        const typeCompare = (a.claim_type as string).localeCompare(
          b.claim_type as string
        );
        if (typeCompare !== 0) return typeCompare;
        return (a.id as number) - (b.id as number);
      });
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
    // Extract only the WHERE portion to avoid matching column names in SELECT
    let filtered = allRows;
    const whereIdx = q.indexOf(" where ");
    const whereClause = whereIdx >= 0 ? q.slice(whereIdx, q.indexOf("order by", whereIdx)) : "";
    if (whereClause) {
      // Count filter params (before limit/offset)
      let filterCount = 0;
      if (whereClause.includes("entity_type")) filterCount++;
      if (whereClause.includes("claim_type")) filterCount++;
      if (whereClause.includes("claim_category")) filterCount++;

      filtered = allRows.filter((r) => {
        let match = true;
        let paramIdx = 0;
        if (whereClause.includes("entity_type")) {
          if (r.entity_type !== params[paramIdx]) match = false;
          paramIdx++;
        }
        if (whereClause.includes("claim_type")) {
          if (r.claim_type !== params[paramIdx]) match = false;
          paramIdx++;
        }
        if (whereClause.includes("claim_category")) {
          if (r.claim_category !== params[paramIdx]) match = false;
          paramIdx++;
        }
        return match;
      });
      // Limit/offset come after filter params
      const limit = (params[filterCount] as number) || 50;
      const offset = (params[filterCount + 1] as number) || 0;
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

  // =======================================================================
  // Enhanced fields tests (migration 0028)
  // =======================================================================

  const enhancedClaim = {
    entityId: "anthropic",
    entityType: "organization",
    claimType: "numeric",
    claimText: "Anthropic raised $7.3B in funding",
    value: "Funding",
    unit: "1,3",
    confidence: "unverified",
    sourceQuote: "The company has raised over $7 billion",
    claimCategory: "factual",
    relatedEntities: ["google", "amazon"],
    factId: "anthropic.total_funding",
    resourceIds: ["res-bloomberg-2024"],
    section: "Funding History",
    footnoteRefs: "1,3",
  };

  describe("Enhanced fields round-trip", () => {
    it("stores and returns all enhanced fields via GET by ID", async () => {
      const createRes = await postJson(app, "/api/claims", enhancedClaim);
      expect(createRes.status).toBe(201);
      const created = await createRes.json();

      const res = await app.request(`/api/claims/${created.id}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.claimCategory).toBe("factual");
      expect(body.relatedEntities).toEqual(["google", "amazon"]);
      expect(body.factId).toBe("anthropic.total_funding");
      expect(body.resourceIds).toEqual(["res-bloomberg-2024"]);
      expect(body.section).toBe("Funding History");
      expect(body.footnoteRefs).toBe("1,3");
    });

    it("stores enhanced fields via batch insert", async () => {
      const res = await postJson(app, "/api/claims/batch", {
        items: [
          enhancedClaim,
          {
            entityId: "openai",
            entityType: "organization",
            claimType: "relational",
            claimText: "OpenAI competes with Anthropic",
            claimCategory: "relational",
            relatedEntities: ["anthropic"],
            section: "Competition",
          },
        ],
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.inserted).toBe(2);
    });

    it("returns null for enhanced fields when not provided", async () => {
      const createRes = await postJson(app, "/api/claims", {
        entityId: "minimal",
        entityType: "concept",
        claimType: "factual",
        claimText: "A claim without enhanced fields",
      });
      const created = await createRes.json();

      const res = await app.request(`/api/claims/${created.id}`);
      const body = await res.json();
      expect(body.claimCategory).toBeNull();
      expect(body.relatedEntities).toBeNull();
      expect(body.factId).toBeNull();
      expect(body.resourceIds).toBeNull();
    });
  });

  describe("Multi-entity claims via relatedEntities", () => {
    it("returns claims where entity appears in relatedEntities", async () => {
      // Insert a claim on anthropic that mentions google
      await postJson(app, "/api/claims", enhancedClaim);

      // Insert a direct claim on google
      await postJson(app, "/api/claims", {
        entityId: "google",
        entityType: "organization",
        claimType: "factual",
        claimText: "Google invested in Anthropic",
      });

      // Query for google — should get both: direct + via relatedEntities
      const res = await app.request("/api/claims/by-entity/google");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.claims).toHaveLength(2);
      // One is the direct google claim, one is the anthropic claim mentioning google
      const entityIds = body.claims.map((c: { entityId: string }) => c.entityId).sort();
      expect(entityIds).toEqual(["anthropic", "google"]);
    });

    it("does not double-count when entity is both primary and related", async () => {
      // Insert a claim where entityId is anthropic and relatedEntities also includes anthropic
      await postJson(app, "/api/claims", {
        ...enhancedClaim,
        relatedEntities: ["anthropic"], // self-referential
      });

      const res = await app.request("/api/claims/by-entity/anthropic");
      const body = await res.json();
      // Should still only appear once
      expect(body.claims).toHaveLength(1);
    });
  });

  describe("Stats with enhanced fields", () => {
    it("returns byClaimCategory breakdown", async () => {
      await postJson(app, "/api/claims", {
        ...enhancedClaim,
        claimCategory: "factual",
      });
      await postJson(app, "/api/claims", {
        entityId: "openai",
        entityType: "organization",
        claimType: "evaluative",
        claimText: "OpenAI is considered a leader",
        claimCategory: "opinion",
      });

      const res = await app.request("/api/claims/stats");
      const body = await res.json();
      expect(body.total).toBe(2);
      expect(body.byClaimCategory).toHaveProperty("factual", 1);
      expect(body.byClaimCategory).toHaveProperty("opinion", 1);
    });

    it("returns multiEntityClaims count", async () => {
      await postJson(app, "/api/claims", enhancedClaim); // has relatedEntities
      await postJson(app, "/api/claims", {
        entityId: "miri",
        entityType: "organization",
        claimType: "factual",
        claimText: "MIRI was founded in 2000",
        // no relatedEntities
      });

      const res = await app.request("/api/claims/stats");
      const body = await res.json();
      expect(body.multiEntityClaims).toBe(1);
    });

    it("returns factLinkedClaims count", async () => {
      await postJson(app, "/api/claims", enhancedClaim); // has factId
      await postJson(app, "/api/claims", {
        entityId: "miri",
        entityType: "organization",
        claimType: "factual",
        claimText: "MIRI was founded in 2000",
        // no factId
      });

      const res = await app.request("/api/claims/stats");
      const body = await res.json();
      expect(body.factLinkedClaims).toBe(1);
    });
  });

  describe("Filtering by claimCategory", () => {
    it("filters /all endpoint by claimCategory", async () => {
      await postJson(app, "/api/claims", {
        ...enhancedClaim,
        claimCategory: "factual",
      });
      await postJson(app, "/api/claims", {
        entityId: "openai",
        entityType: "organization",
        claimType: "evaluative",
        claimText: "OpenAI is a leader",
        claimCategory: "opinion",
      });
      await postJson(app, "/api/claims", {
        entityId: "miri",
        entityType: "organization",
        claimType: "speculative",
        claimText: "MIRI may achieve breakthroughs",
        claimCategory: "speculative",
      });

      const res = await app.request("/api/claims/all?claimCategory=opinion");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.claims).toHaveLength(1);
      expect(body.claims[0].claimCategory).toBe("opinion");
      expect(body.total).toBe(1);
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
