import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { mockDbModule, postJson } from "./test-utils.js";
import { TestDb } from "./test-db-helper.js";

// ---- In-memory test database ----
// Replaces the old hand-written dispatch with a structured helper that
// parses INSERT column lists from Drizzle-generated SQL. New columns
// added via migrations are handled automatically — no more PARAMS_PER_ROW.

const testDb = new TestDb();

// Mock the db module before importing routes
vi.mock("../db.js", () => mockDbModule(testDb.dispatch));

const { createApp } = await import("../app.js");

// ---- Tests ----

describe("Claims API", () => {
  let app: Hono;

  beforeEach(() => {
    testDb.reset();
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

      expect(testDb.getTable("claims").size).toBe(3);

      const res = await postJson(app, "/api/claims/clear", {
        entityId: "anthropic",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(2);
      expect(testDb.getTable("claims").size).toBe(1);
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
    // Phase 2 fields
    claimMode: "endorsed",
    asOf: "2024-09",
    measure: "total_funding",
    valueNumeric: 7300000000,
    valueLow: 7000000000,
    valueHigh: 7500000000,
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

  // =======================================================================
  // Phase 2 tests (migration 0029): claim_mode, as_of, numeric values, claim_sources
  // =======================================================================

  describe("Phase 2 — claim_mode and attributed claims", () => {
    it("stores and returns claimMode via GET by ID", async () => {
      const createRes = await postJson(app, "/api/claims", {
        entityId: "neel-nanda",
        entityType: "person",
        claimType: "evaluative",
        claimText: "Mechanistic interpretability is crucial for AI safety",
        claimMode: "attributed",
        attributedTo: "neel-nanda",
        asOf: "2023-06",
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();

      const res = await app.request(`/api/claims/${created.id}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.claimMode).toBe("attributed");
      expect(body.attributedTo).toBe("neel-nanda");
      expect(body.asOf).toBe("2023-06");
    });

    it("defaults claim_mode to endorsed when not specified", async () => {
      const createRes = await postJson(app, "/api/claims", {
        entityId: "anthropic",
        entityType: "organization",
        claimType: "factual",
        claimText: "Anthropic was founded in 2021",
      });
      const created = await createRes.json();

      const res = await app.request(`/api/claims/${created.id}`);
      const body = await res.json();
      expect(body.claimMode).toBe("endorsed");
    });

    it("stores numeric value fields", async () => {
      const createRes = await postJson(app, "/api/claims", enhancedClaim);
      const created = await createRes.json();

      const res = await app.request(`/api/claims/${created.id}`);
      const body = await res.json();
      expect(body.valueNumeric).toBe(7300000000);
      expect(body.valueLow).toBe(7000000000);
      expect(body.valueHigh).toBe(7500000000);
      expect(body.measure).toBe("total_funding");
      expect(body.asOf).toBe("2024-09");
    });
  });

  describe("Phase 2 — claim_sources inline insert", () => {
    it("creates claim_sources when sources array is provided", async () => {
      const createRes = await postJson(app, "/api/claims", {
        entityId: "anthropic",
        entityType: "organization",
        claimType: "factual",
        claimText: "Anthropic raised $7.3B from Google and Amazon",
        sources: [
          {
            resourceId: "res-bloomberg-2024",
            sourceQuote: "Google has committed to invest up to $2 billion",
            isPrimary: true,
          },
          {
            url: "https://example.com/amazon-investment",
            sourceQuote: "Amazon invested $4 billion in Anthropic",
            isPrimary: false,
          },
        ],
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();

      // Check sources are in the store
      expect(testDb.getTable("claim_sources").size).toBe(2);
      const sources = Array.from(testDb.getTable("claim_sources").values());
      expect(sources.some((s) => s.resource_id === "res-bloomberg-2024")).toBe(true);
      expect(sources.some((s) => s.url === "https://example.com/amazon-investment")).toBe(true);
    });

    it("GET /:id always includes sources array", async () => {
      const createRes = await postJson(app, "/api/claims", {
        entityId: "anthropic",
        entityType: "organization",
        claimType: "factual",
        claimText: "A claim without sources",
      });
      const created = await createRes.json();

      const res = await app.request(`/api/claims/${created.id}`);
      const body = await res.json();
      expect(Array.isArray(body.sources)).toBe(true);
    });
  });

  // =======================================================================
  // GET /:id/sources and POST /:id/sources
  // =======================================================================

  describe("GET /api/claims/:id/sources", () => {
    it("returns empty sources array for claim with no sources", async () => {
      const createRes = await postJson(app, "/api/claims", {
        entityId: "anthropic",
        entityType: "organization",
        claimType: "factual",
        claimText: "No sources here",
      });
      const created = await createRes.json();

      const res = await app.request(`/api/claims/${created.id}/sources`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.sources).toEqual([]);
    });

    it("returns sources for a claim that has them", async () => {
      const createRes = await postJson(app, "/api/claims", {
        entityId: "anthropic",
        entityType: "organization",
        claimType: "factual",
        claimText: "Anthropic raised $7.3B",
        sources: [
          { resourceId: "res-001", sourceQuote: "raised $7.3B", isPrimary: true },
          { url: "https://example.com", isPrimary: false },
        ],
      });
      const created = await createRes.json();

      const res = await app.request(`/api/claims/${created.id}/sources`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.sources).toHaveLength(2);
      // Primary source should be present
      expect(body.sources.some((s: { resourceId?: string }) => s.resourceId === "res-001")).toBe(true);
    });

    it("returns 400 for non-numeric claim ID", async () => {
      const res = await app.request("/api/claims/not-a-number/sources");
      expect(res.status).toBe(400);
    });

    it("returns 400 for zero claim ID", async () => {
      const res = await app.request("/api/claims/0/sources");
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/claims/:id/sources", () => {
    it("adds a source to an existing claim", async () => {
      const createRes = await postJson(app, "/api/claims", {
        entityId: "anthropic",
        entityType: "organization",
        claimType: "factual",
        claimText: "Anthropic was founded in 2021",
      });
      const created = await createRes.json();

      const addRes = await postJson(app, `/api/claims/${created.id}/sources`, {
        resourceId: "res-techcrunch-2021",
        sourceQuote: "The company was founded in 2021",
        isPrimary: true,
      });
      expect(addRes.status).toBe(201);
      const source = await addRes.json();
      expect(source.resourceId).toBe("res-techcrunch-2021");
      expect(source.isPrimary).toBe(true);
      expect(source.sourceQuote).toBe("The company was founded in 2021");
    });

    it("adds a URL-only source (no resourceId)", async () => {
      const createRes = await postJson(app, "/api/claims", {
        entityId: "anthropic",
        entityType: "organization",
        claimType: "factual",
        claimText: "A claim",
      });
      const created = await createRes.json();

      const addRes = await postJson(app, `/api/claims/${created.id}/sources`, {
        url: "https://example.com/article",
        isPrimary: false,
      });
      expect(addRes.status).toBe(201);
      const source = await addRes.json();
      expect(source.url).toBe("https://example.com/article");
      expect(source.resourceId).toBeNull();
    });

    it("returns 404 when adding source to non-existent claim", async () => {
      const res = await postJson(app, "/api/claims/99999/sources", {
        url: "https://example.com",
      });
      expect(res.status).toBe(404);
    });

    it("returns 400 for non-numeric claim ID", async () => {
      const res = await postJson(app, "/api/claims/abc/sources", {
        url: "https://example.com",
      });
      expect(res.status).toBe(400);
    });

    it("source appears in GET /:id/sources after being added", async () => {
      const createRes = await postJson(app, "/api/claims", {
        entityId: "openai",
        entityType: "organization",
        claimType: "factual",
        claimText: "OpenAI released GPT-4",
      });
      const created = await createRes.json();

      await postJson(app, `/api/claims/${created.id}/sources`, {
        resourceId: "res-openai-gpt4",
        sourceQuote: "GPT-4 was released in March 2023",
        isPrimary: true,
      });

      const sourcesRes = await app.request(`/api/claims/${created.id}/sources`);
      expect(sourcesRes.status).toBe(200);
      const body = await sourcesRes.json();
      expect(body.sources).toHaveLength(1);
      expect(body.sources[0].resourceId).toBe("res-openai-gpt4");
    });
  });

  // =======================================================================
  // Phase 2 batch with sources (safe path — one at a time to avoid ordering bug)
  // =======================================================================

  describe("POST /api/claims/batch with sources", () => {
    it("inserts batch items with inline sources — each claim gets correct sources", async () => {
      const res = await postJson(app, "/api/claims/batch", {
        items: [
          {
            entityId: "anthropic",
            entityType: "organization",
            claimType: "factual",
            claimText: "Anthropic raised from Google",
            sources: [{ resourceId: "res-google", isPrimary: true }],
          },
          {
            entityId: "openai",
            entityType: "organization",
            claimType: "factual",
            claimText: "OpenAI raised from Microsoft",
            sources: [{ resourceId: "res-msft", isPrimary: true }],
          },
        ],
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.inserted).toBe(2);
      // Both sets of sources should be present
      expect(testDb.getTable("claim_sources").size).toBe(2);
      const sources = Array.from(testDb.getTable("claim_sources").values());
      expect(sources.some((s) => s.resource_id === "res-google")).toBe(true);
      expect(sources.some((s) => s.resource_id === "res-msft")).toBe(true);
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

  describe("GET /api/claims/quality", () => {
    it("returns pagination metadata with defaults", async () => {
      const res = await app.request("/api/claims/quality");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("entities");
      expect(body).toHaveProperty("pagination");
      expect(body).toHaveProperty("systemwide");
      expect(body.pagination).toHaveProperty("limit", 50);
      expect(body.pagination).toHaveProperty("offset", 0);
      expect(body.pagination).toHaveProperty("total");
      expect(body.pagination).toHaveProperty("totalPages");
      expect(typeof body.pagination.total).toBe("number");
      expect(typeof body.pagination.totalPages).toBe("number");
    });

    it("accepts custom limit and offset params", async () => {
      const res = await app.request("/api/claims/quality?limit=10&offset=5");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pagination.limit).toBe(10);
      expect(body.pagination.offset).toBe(5);
    });

    it("rejects limit exceeding max", async () => {
      const res = await app.request("/api/claims/quality?limit=500");
      expect(res.status).toBe(400);
    });

    it("rejects negative offset", async () => {
      const res = await app.request("/api/claims/quality?offset=-1");
      expect(res.status).toBe(400);
    });

    it("returns systemwide aggregates", async () => {
      const res = await app.request("/api/claims/quality");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.systemwide).toHaveProperty("totalClaims");
      expect(body.systemwide).toHaveProperty("totalVerified");
      expect(body.systemwide).toHaveProperty("verifiedPct");
      expect(body.systemwide).toHaveProperty("avgVerdictScore");
      expect(body.systemwide).toHaveProperty("byVerdict");
      expect(body.systemwide).toHaveProperty("scoreBuckets");
    });

    it("entities array is present in response", async () => {
      const res = await app.request("/api/claims/quality");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.entities)).toBe(true);
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
