import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { mockDbModule } from "./test-utils.js";

// ---- In-memory stores ----

interface VerdictRecord {
  fact_id: string;
  verdict: string;
  confidence: number | null;
  reasoning: string | null;
  sources_checked: number;
  needs_recheck: boolean;
  last_computed_at: string;
  created_at: string;
  updated_at: string;
}

interface VerificationRecord {
  id: number;
  fact_id: string;
  resource_id: string;
  verdict: string;
  confidence: number | null;
  extracted_value: string | null;
  checker_model: string | null;
  is_primary_source: boolean;
  checked_at: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface FactRecord {
  fact_id: string;
  entity_id: string;
}

let verdicts: VerdictRecord[];
let verifications: VerificationRecord[];
let factsStore: FactRecord[];

function resetStores() {
  const now = new Date().toISOString();
  verdicts = [
    {
      fact_id: "f_abc123",
      verdict: "confirmed",
      confidence: 0.95,
      reasoning: "Matched multiple sources",
      sources_checked: 3,
      needs_recheck: false,
      last_computed_at: now,
      created_at: now,
      updated_at: now,
    },
    {
      fact_id: "f_def456",
      verdict: "contradicted",
      confidence: 0.8,
      reasoning: "Source shows different value",
      sources_checked: 2,
      needs_recheck: true,
      last_computed_at: now,
      created_at: now,
      updated_at: now,
    },
    {
      fact_id: "f_ghi789",
      verdict: "confirmed",
      confidence: 0.7,
      reasoning: null,
      sources_checked: 1,
      needs_recheck: false,
      last_computed_at: now,
      created_at: now,
      updated_at: now,
    },
  ];
  verifications = [
    {
      id: 1,
      fact_id: "f_abc123",
      resource_id: "r_src1",
      verdict: "supports",
      confidence: 0.9,
      extracted_value: "$14B",
      checker_model: "claude-3-haiku",
      is_primary_source: true,
      checked_at: now,
      notes: "Direct match",
      created_at: now,
      updated_at: now,
    },
  ];
  factsStore = [
    { fact_id: "f_abc123", entity_id: "anthropic" },
    { fact_id: "f_def456", entity_id: "anthropic" },
    { fact_id: "f_ghi789", entity_id: "openai" },
  ];
}

function dispatch(query: string, params: unknown[]): unknown[] {
  const q = query.toLowerCase();

  // COUNT(*) with optional WHERE — stats and verdict list total
  if (q.includes("count(") && q.includes("kb_fact_verdicts")) {
    // Stats aggregation: count + filter + avg
    if (q.includes("avg(") || q.includes("filter")) {
      const total = verdicts.length;
      const needsRecheck = verdicts.filter((v) => v.needs_recheck).length;
      const avgConf =
        verdicts.reduce((sum, v) => sum + (v.confidence ?? 0), 0) /
        (total || 1);
      return [{ total, needs_recheck: needsRecheck, avg_confidence: avgConf }];
    }

    // Group by verdict
    if (q.includes("group by")) {
      const groups = new Map<string, number>();
      for (const v of verdicts) {
        groups.set(v.verdict, (groups.get(v.verdict) ?? 0) + 1);
      }
      return [...groups.entries()].map(([verdict, count]) => ({ verdict, count }));
    }

    // Simple count for verdict list pagination
    let filtered = verdicts;
    if (q.includes("where")) {
      if (params.some((p) => typeof p === "string" && verdicts.some((v) => v.verdict === p))) {
        const verdictFilter = params.find(
          (p) => typeof p === "string" && verdicts.some((v) => v.verdict === p)
        ) as string;
        filtered = filtered.filter((v) => v.verdict === verdictFilter);
      }
    }
    return [{ count: filtered.length }];
  }

  // SELECT from kb_fact_verdicts with WHERE fact_id = ? (single verdict lookup)
  if (q.includes("kb_fact_verdicts") && q.includes("limit")) {
    if (params.length > 0) {
      // Check for verdict filter or fact_id filter
      const factIdParam = params.find(
        (p) => typeof p === "string" && (p as string).startsWith("f_")
      );
      const verdictParam = params.find(
        (p) => typeof p === "string" && verdicts.some((v) => v.verdict === p)
      );

      if (factIdParam) {
        return verdicts.filter((v) => v.fact_id === factIdParam);
      }
      if (verdictParam) {
        return verdicts.filter((v) => v.verdict === verdictParam);
      }
    }
    return verdicts;
  }

  // SELECT from kb_fact_resource_verifications
  if (q.includes("kb_fact_resource_verifications")) {
    const factId = params.find(
      (p) => typeof p === "string" && (p as string).startsWith("f_")
    );
    if (factId) {
      return verifications.filter((v) => v.fact_id === factId);
    }
    return verifications;
  }

  // SELECT from facts (entity_id filtering)
  if (q.includes('"facts"') && q.includes("entity_id")) {
    const entityId = params[0] as string;
    return factsStore
      .filter((f) => f.entity_id === entityId)
      .map((f) => ({ fact_id: f.fact_id }));
  }

  return [];
}

// ---- Mock setup ----

vi.mock("../db.js", () => mockDbModule(dispatch));

let app: Hono;

beforeEach(async () => {
  resetStores();
  const { kbVerificationsRoute } = await import(
    "../routes/kb-verifications.js"
  );
  app = new Hono().route("/api/kb-verifications", kbVerificationsRoute);
});

// ---- Tests ----

describe("GET /api/kb-verifications/stats", () => {
  it("returns aggregate stats", async () => {
    const res = await app.request("/api/kb-verifications/stats");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total_facts).toBe(3);
    expect(body.needs_recheck).toBeGreaterThanOrEqual(0);
    expect(body.avg_confidence).toBeGreaterThan(0);
    expect(body.by_verdict).toBeDefined();
  });
});

describe("GET /api/kb-verifications/verdicts", () => {
  it("returns verdicts list with pagination", async () => {
    const res = await app.request("/api/kb-verifications/verdicts?limit=10");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verdicts).toBeInstanceOf(Array);
    expect(body.total).toBeGreaterThanOrEqual(0);
  });

  it("validates limit parameter", async () => {
    const res = await app.request("/api/kb-verifications/verdicts?limit=999");
    expect(res.status).toBe(400);
  });

  it("validates offset parameter", async () => {
    const res = await app.request("/api/kb-verifications/verdicts?offset=-1");
    expect(res.status).toBe(400);
  });
});

describe("GET /api/kb-verifications/verdicts/:factId", () => {
  it("returns verdict and verifications for existing fact", async () => {
    const res = await app.request(
      "/api/kb-verifications/verdicts/f_abc123"
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verdict).toBeDefined();
    expect(body.verdict.factId).toBe("f_abc123");
    expect(body.verifications).toBeInstanceOf(Array);
  });

  it("returns 404 for non-existent fact", async () => {
    const res = await app.request(
      "/api/kb-verifications/verdicts/f_nonexistent"
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 for overly long factId", async () => {
    const longId = "f_" + "x".repeat(200);
    const res = await app.request(
      `/api/kb-verifications/verdicts/${longId}`
    );
    expect(res.status).toBe(404);
  });
});
