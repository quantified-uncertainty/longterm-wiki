/**
 * Tests for GET /api/claims/quality and GET /api/claims/all with filter params.
 *
 * The /quality endpoint uses rawDb.unsafe() for aggregation queries,
 * so we mock the db module with a custom dispatcher that returns shaped data.
 *
 * The /all endpoint uses Drizzle's query builder, so we test it via the
 * TestDb in-memory store with claims inserted through POST /api/claims.
 */

import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { mockDbModule, type SqlDispatcher } from "./test-utils.js";

// Mock pino-dependent modules that are imported via monitoring/claims routes
// through utils.ts → logger.ts → pino (not installed in local node_modules)
vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
  },
}));

vi.mock("../auth.js", () => ({
  requireAuth: () => (c: unknown, next: () => Promise<void>) => next(),
  resolveScopes: vi.fn(() => ["project", "content"]),
  getKeyConfig: vi.fn(() => ({})),
  type: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Section 1: GET /api/claims/quality — raw SQL aggregation tests
// ---------------------------------------------------------------------------

/**
 * Build a dispatch function from fixed quality scenario data.
 * The /quality endpoint uses 5 rawDb.unsafe() calls (not Drizzle builder),
 * so we match them by SQL patterns.
 */
function buildQualityDispatch(options: {
  // Per-entity rows
  perEntityRows?: Array<{
    entity_id: string;
    total_claims: number;
    verified_count: number;
    avg_verdict_score: number | null;
    min_verdict_score: number | null;
    max_verdict_score: number | null;
  }>;
  // Total distinct entities for pagination
  totalEntities?: number;
  // Systemwide aggregates
  systemwide?: {
    total_claims: number;
    total_verified: number;
    avg_score: number | null;
  };
  // Verdict distribution
  verdictRows?: Array<{ verdict: string | null; cnt: number }>;
  // Score bucket distribution
  bucketRows?: Array<{ bucket: string; cnt: number }>;
}): SqlDispatcher {
  return (query: string, _params: unknown[]) => {
    const q = query.toLowerCase();

    // Health check fallbacks
    if (q.includes("count(*)") && q.includes("entity_ids")) {
      return [{ count: 0 }];
    }
    if (q.includes("last_value")) {
      return [{ last_value: 0, is_called: false }];
    }

    // Ref-check pass-through
    if (q.includes("as id from") && q.includes("where") && q.includes(" in ")) {
      return _params.map((p) => ({ id: p }));
    }

    // 1. Per-entity quality metrics (GROUP BY entity_id, ORDER BY count DESC)
    if (q.includes("group by entity_id") && q.includes("order by count(*)")) {
      return options.perEntityRows ?? [];
    }

    // 2. Total distinct entities
    if (q.includes("count(distinct entity_id)") || (q.includes("count(distinct") && q.includes("entity_id"))) {
      return [{ cnt: String(options.totalEntities ?? 0) }];
    }

    // 3. Systemwide aggregates (contains total_claims, total_verified, avg_score)
    if (q.includes("total_claims") && q.includes("total_verified") && q.includes("avg_score")) {
      const sw = options.systemwide ?? { total_claims: 0, total_verified: 0, avg_score: null };
      return [sw];
    }

    // 4. Verdict distribution (GROUP BY claim_verdict)
    if (q.includes("claim_verdict as verdict") && q.includes("group by claim_verdict")) {
      return options.verdictRows ?? [];
    }

    // 5. Score buckets (CASE WHEN claim_verdict_score < ...)
    if (q.includes("claim_verdict_score") && q.includes("case") && q.includes("bucket")) {
      return options.bucketRows ?? [];
    }

    return [];
  };
}

async function createQualityApp(dispatch: SqlDispatcher) {
  vi.resetModules();
  vi.doMock("../db.js", () => mockDbModule(dispatch));
  const { claimsRoute } = await import("../routes/claims.js");
  const app = new Hono().route("/api/claims", claimsRoute);
  return app;
}

describe("GET /api/claims/quality", () => {
  it("returns correct response shape on empty database", async () => {
    const app = await createQualityApp(buildQualityDispatch({}));
    const res = await app.request("/api/claims/quality");
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("entities");
    expect(body).toHaveProperty("pagination");
    expect(body).toHaveProperty("systemwide");

    const pagination = body.pagination as Record<string, unknown>;
    expect(pagination.total).toBe(0);
    expect(pagination.totalPages).toBe(0);
    expect(pagination.limit).toBe(50); // default limit
    expect(pagination.offset).toBe(0);

    const systemwide = body.systemwide as Record<string, unknown>;
    expect(systemwide.totalClaims).toBe(0);
    expect(systemwide.totalVerified).toBe(0);
    expect(systemwide.verifiedPct).toBe(0);
    expect(systemwide.avgVerdictScore).toBeNull();
    expect(systemwide.byVerdict).toEqual({});
    expect(systemwide.scoreBuckets).toEqual({});
  });

  it("aggregates per-entity quality metrics correctly", async () => {
    const app = await createQualityApp(
      buildQualityDispatch({
        perEntityRows: [
          {
            entity_id: "anthropic",
            total_claims: 10,
            verified_count: 8,
            avg_verdict_score: 0.75,
            min_verdict_score: 0.5,
            max_verdict_score: 0.95,
          },
          {
            entity_id: "openai",
            total_claims: 5,
            verified_count: 0,
            avg_verdict_score: null,
            min_verdict_score: null,
            max_verdict_score: null,
          },
        ],
        totalEntities: 2,
        systemwide: { total_claims: 15, total_verified: 8, avg_score: 0.75 },
      })
    );

    const res = await app.request("/api/claims/quality");
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    const entities = body.entities as Array<Record<string, unknown>>;
    expect(entities).toHaveLength(2);

    // First entity: anthropic
    const anthropic = entities[0];
    expect(anthropic.entityId).toBe("anthropic");
    expect(anthropic.totalClaims).toBe(10);
    expect(anthropic.verifiedCount).toBe(8);
    expect(anthropic.verifiedPct).toBe(80); // 8/10 * 100
    expect(anthropic.avgVerdictScore).toBe(0.75);
    expect(anthropic.minVerdictScore).toBe(0.5);
    expect(anthropic.maxVerdictScore).toBe(0.95);

    // Second entity: openai (no verified claims)
    const openai = entities[1];
    expect(openai.entityId).toBe("openai");
    expect(openai.totalClaims).toBe(5);
    expect(openai.verifiedCount).toBe(0);
    expect(openai.verifiedPct).toBe(0);
    expect(openai.avgVerdictScore).toBeNull();
    expect(openai.minVerdictScore).toBeNull();
    expect(openai.maxVerdictScore).toBeNull();
  });

  it("handles null verdict scores correctly", async () => {
    const app = await createQualityApp(
      buildQualityDispatch({
        perEntityRows: [
          {
            entity_id: "miri",
            total_claims: 3,
            verified_count: 0,
            avg_verdict_score: null,
            min_verdict_score: null,
            max_verdict_score: null,
          },
        ],
        totalEntities: 1,
        systemwide: { total_claims: 3, total_verified: 0, avg_score: null },
      })
    );

    const res = await app.request("/api/claims/quality");
    const body = (await res.json()) as Record<string, unknown>;
    const systemwide = body.systemwide as Record<string, unknown>;

    expect(systemwide.avgVerdictScore).toBeNull();
    expect(systemwide.verifiedPct).toBe(0);
  });

  it("computes verifiedPct correctly (rounds to nearest integer)", async () => {
    const app = await createQualityApp(
      buildQualityDispatch({
        perEntityRows: [
          {
            entity_id: "test",
            total_claims: 3,
            verified_count: 1,
            avg_verdict_score: 0.6667,
            min_verdict_score: 0.6667,
            max_verdict_score: 0.6667,
          },
        ],
        totalEntities: 1,
        systemwide: { total_claims: 3, total_verified: 1, avg_score: 0.6667 },
      })
    );

    const res = await app.request("/api/claims/quality");
    const body = (await res.json()) as Record<string, unknown>;
    const entities = body.entities as Array<Record<string, unknown>>;
    // 1/3 = 33.33% → rounds to 33
    expect(entities[0].verifiedPct).toBe(33);
    // System-wide: same ratio
    const systemwide = body.systemwide as Record<string, unknown>;
    expect(systemwide.verifiedPct).toBe(33);
  });

  it("rounds avgVerdictScore to 2 decimal places", async () => {
    const app = await createQualityApp(
      buildQualityDispatch({
        perEntityRows: [
          {
            entity_id: "test",
            total_claims: 1,
            verified_count: 1,
            avg_verdict_score: 0.66666667,
            min_verdict_score: 0.66666667,
            max_verdict_score: 0.66666667,
          },
        ],
        totalEntities: 1,
        systemwide: { total_claims: 1, total_verified: 1, avg_score: 0.66666667 },
      })
    );

    const res = await app.request("/api/claims/quality");
    const body = (await res.json()) as Record<string, unknown>;
    const entities = body.entities as Array<Record<string, unknown>>;
    // Should be rounded to 2 decimal places: 0.67
    expect(entities[0].avgVerdictScore).toBe(0.67);
    const systemwide = body.systemwide as Record<string, unknown>;
    expect(systemwide.avgVerdictScore).toBe(0.67);
  });

  it("returns verdict distribution in systemwide", async () => {
    const app = await createQualityApp(
      buildQualityDispatch({
        systemwide: { total_claims: 5, total_verified: 3, avg_score: 0.8 },
        verdictRows: [
          { verdict: "correct", cnt: 2 },
          { verdict: "mostly_correct", cnt: 1 },
          { verdict: null, cnt: 2 }, // unverified
        ],
      })
    );

    const res = await app.request("/api/claims/quality");
    const body = (await res.json()) as Record<string, unknown>;
    const systemwide = body.systemwide as Record<string, unknown>;
    const byVerdict = systemwide.byVerdict as Record<string, number>;

    expect(byVerdict.correct).toBe(2);
    expect(byVerdict.mostly_correct).toBe(1);
    expect(byVerdict.unverified).toBe(2); // null verdict → 'unverified' key
  });

  it("returns score bucket distribution in systemwide", async () => {
    const app = await createQualityApp(
      buildQualityDispatch({
        systemwide: { total_claims: 5, total_verified: 5, avg_score: 0.6 },
        bucketRows: [
          { bucket: "0-20", cnt: 1 },
          { bucket: "40-60", cnt: 2 },
          { bucket: "80-100", cnt: 2 },
        ],
      })
    );

    const res = await app.request("/api/claims/quality");
    const body = (await res.json()) as Record<string, unknown>;
    const systemwide = body.systemwide as Record<string, unknown>;
    const scoreBuckets = systemwide.scoreBuckets as Record<string, number>;

    expect(scoreBuckets["0-20"]).toBe(1);
    expect(scoreBuckets["40-60"]).toBe(2);
    expect(scoreBuckets["80-100"]).toBe(2);
    // Absent buckets should not be present
    expect(scoreBuckets["20-40"]).toBeUndefined();
  });

  it("returns correct pagination metadata", async () => {
    const app = await createQualityApp(
      buildQualityDispatch({
        totalEntities: 120,
        systemwide: { total_claims: 500, total_verified: 0, avg_score: null },
      })
    );

    const res = await app.request("/api/claims/quality?limit=10&offset=20");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const pagination = body.pagination as Record<string, unknown>;

    expect(pagination.limit).toBe(10);
    expect(pagination.offset).toBe(20);
    expect(pagination.total).toBe(120);
    expect(pagination.totalPages).toBe(12); // ceil(120/10)
  });

  it("rejects invalid pagination params", async () => {
    const app = await createQualityApp(buildQualityDispatch({}));
    const res = await app.request("/api/claims/quality?limit=999999");
    expect(res.status).toBe(400);
  });

  it("boundary: score 0.0 and 1.0 are returned correctly", async () => {
    const app = await createQualityApp(
      buildQualityDispatch({
        perEntityRows: [
          {
            entity_id: "boundary-test",
            total_claims: 2,
            verified_count: 2,
            avg_verdict_score: 0.5,
            min_verdict_score: 0.0,
            max_verdict_score: 1.0,
          },
        ],
        totalEntities: 1,
        systemwide: { total_claims: 2, total_verified: 2, avg_score: 0.5 },
      })
    );

    const res = await app.request("/api/claims/quality");
    const body = (await res.json()) as Record<string, unknown>;
    const entities = body.entities as Array<Record<string, unknown>>;

    expect(entities[0].minVerdictScore).toBe(0);
    expect(entities[0].maxVerdictScore).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Section 2: GET /api/claims/all — filter param validation tests
//
// These tests verify that the Zod schema (PaginationQuery) correctly validates
// the new filter parameters: minVerdictScore, maxVerdictScore, verifiedOnly,
// sort=verdict_score.
//
// We use the same vi.doMock + direct route import pattern as Section 1
// to avoid importing app.ts (which pulls in pino via rate-limit.ts).
// ---------------------------------------------------------------------------

/**
 * Build a dispatch function that returns empty results for /all queries.
 * Used for schema validation tests that only need to check HTTP status codes.
 */
function buildAllDispatch(): SqlDispatcher {
  return (query: string, params: unknown[]) => {
    const q = query.toLowerCase();

    // Health check fallbacks
    if (q.includes("count(*)") && q.includes("entity_ids")) {
      return [{ count: 0 }];
    }
    if (q.includes("last_value")) {
      return [{ last_value: 0, is_called: false }];
    }

    // Ref-check pass-through
    if (q.includes("as id from") && q.includes("where") && q.includes(" in ")) {
      return params.map((p) => ({ id: p }));
    }

    // INSERT (for claim creation)
    if (q.startsWith("insert")) {
      return [{ id: 1, entity_id: "test", claim_type: "factual" }];
    }

    // COUNT queries for /all
    if (q.includes("count(*)") && (q.includes("claims") || q.includes("from"))) {
      return [{ count: 0 }];
    }

    // SELECT for /all (paginated)
    if (q.includes("from") && q.includes("order by") && q.includes("limit")) {
      return [];
    }

    return [];
  };
}

async function createAllApp(dispatch: SqlDispatcher) {
  vi.resetModules();
  vi.doMock("../db.js", () => mockDbModule(dispatch));
  const { claimsRoute } = await import("../routes/claims.js");
  const app = new Hono().route("/api/claims", claimsRoute);
  return app;
}

describe("GET /api/claims/all — filter param schema validation", () => {
  it("accepts verifiedOnly=true parameter", async () => {
    const app = await createAllApp(buildAllDispatch());
    const res = await app.request("/api/claims/all?verifiedOnly=true");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("claims");
    expect(body).toHaveProperty("total");
  });

  it("accepts verifiedOnly=false parameter", async () => {
    const app = await createAllApp(buildAllDispatch());
    const res = await app.request("/api/claims/all?verifiedOnly=false");
    expect(res.status).toBe(200);
  });

  it("accepts sort=verdict_score parameter", async () => {
    const app = await createAllApp(buildAllDispatch());
    const res = await app.request("/api/claims/all?sort=verdict_score");
    expect(res.status).toBe(200);
  });

  it("rejects invalid sort value", async () => {
    const app = await createAllApp(buildAllDispatch());
    const res = await app.request("/api/claims/all?sort=invalid_sort");
    expect(res.status).toBe(400);
  });

  it("accepts minVerdictScore=0.5", async () => {
    const app = await createAllApp(buildAllDispatch());
    const res = await app.request("/api/claims/all?minVerdictScore=0.5");
    expect(res.status).toBe(200);
  });

  it("accepts maxVerdictScore=0.8", async () => {
    const app = await createAllApp(buildAllDispatch());
    const res = await app.request("/api/claims/all?maxVerdictScore=0.8");
    expect(res.status).toBe(200);
  });

  it("rejects minVerdictScore below 0", async () => {
    const app = await createAllApp(buildAllDispatch());
    const res = await app.request("/api/claims/all?minVerdictScore=-0.1");
    expect(res.status).toBe(400);
  });

  it("rejects maxVerdictScore above 1", async () => {
    const app = await createAllApp(buildAllDispatch());
    const res = await app.request("/api/claims/all?maxVerdictScore=1.5");
    expect(res.status).toBe(400);
  });

  it("accepts boundary value minVerdictScore=0", async () => {
    const app = await createAllApp(buildAllDispatch());
    const res = await app.request("/api/claims/all?minVerdictScore=0");
    expect(res.status).toBe(200);
  });

  it("accepts boundary value maxVerdictScore=1", async () => {
    const app = await createAllApp(buildAllDispatch());
    const res = await app.request("/api/claims/all?maxVerdictScore=1");
    expect(res.status).toBe(200);
  });

  it("accepts combined minVerdictScore + maxVerdictScore", async () => {
    const app = await createAllApp(buildAllDispatch());
    const res = await app.request(
      "/api/claims/all?minVerdictScore=0.3&maxVerdictScore=0.8"
    );
    expect(res.status).toBe(200);
  });

  it("accepts verifiedOnly + sort=verdict_score together", async () => {
    const app = await createAllApp(buildAllDispatch());
    const res = await app.request(
      "/api/claims/all?verifiedOnly=true&sort=verdict_score"
    );
    expect(res.status).toBe(200);
  });

  it("accepts all new filter params combined", async () => {
    const app = await createAllApp(buildAllDispatch());
    const res = await app.request(
      "/api/claims/all?minVerdictScore=0.3&maxVerdictScore=0.9&verifiedOnly=true&sort=verdict_score"
    );
    expect(res.status).toBe(200);
  });

  it("response always includes claims, total, limit, offset fields", async () => {
    const app = await createAllApp(buildAllDispatch());
    const res = await app.request(
      "/api/claims/all?minVerdictScore=0.5&sort=verdict_score&limit=10&offset=0"
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("claims");
    expect(body).toHaveProperty("total");
    expect(body).toHaveProperty("limit");
    expect(body).toHaveProperty("offset");
  });

  it("all pre-existing valid sort values are still accepted", async () => {
    const validSortValues = ["newest", "entity", "confidence", "as_of", "verdict", "verdict_score"];
    for (const sort of validSortValues) {
      const app = await createAllApp(buildAllDispatch());
      const res = await app.request(`/api/claims/all?sort=${sort}`);
      expect(res.status).toBe(200);
    }
  });
});
