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
  resource_id: string | null;
  verdict: string;
  confidence: number | null;
  extracted_value: string | null;
  checker_model: string | null;
  is_primary_source: boolean;
  checked_at: string;
  notes: string | null;
  source_url: string | null;
  created_at: string;
  updated_at: string;
}

interface FactRecord {
  fact_id: string;
  entity_id: string;
  label: string | null;
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
      source_url: "https://example.com/funding",
      created_at: now,
      updated_at: now,
    },
  ];
  factsStore = [
    { fact_id: "f_abc123", entity_id: "anthropic", label: "Funding total" },
    { fact_id: "f_def456", entity_id: "anthropic", label: "Founded year" },
    { fact_id: "f_ghi789", entity_id: "openai", label: null },
  ];
}

/** Apply verdict and entity_id filters to the verdicts store */
function applyVerdictFilters(params: unknown[]): VerdictRecord[] {
  let filtered = verdicts;
  const verdictParam = params.find(
    (p) => typeof p === "string" && verdicts.some((v) => v.verdict === p)
  );
  const entityParam = params.find(
    (p) => typeof p === "string" && factsStore.some((f) => f.entity_id === p)
  );

  if (verdictParam) {
    filtered = filtered.filter((v) => v.verdict === verdictParam);
  }
  if (entityParam) {
    filtered = filtered.filter((v) => {
      const fact = factsStore.find((f) => f.fact_id === v.fact_id);
      return fact?.entity_id === entityParam;
    });
  }
  return filtered;
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
      return [{ count: total, needs_recheck: needsRecheck, avg_confidence: avgConf }];
    }

    // Group by verdict
    if (q.includes("group by")) {
      const groups = new Map<string, number>();
      for (const v of verdicts) {
        groups.set(v.verdict, (groups.get(v.verdict) ?? 0) + 1);
      }
      return [...groups.entries()].map(([verdict, count]) => ({ verdict, count }));
    }

    // Simple count for verdict list pagination (may include LEFT JOIN for entity_id filter)
    const filtered = q.includes("where") ? applyVerdictFilters(params) : verdicts;
    return [{ count: filtered.length }];
  }

  // SELECT from kb_fact_verdicts with LEFT JOIN facts (verdicts list)
  if (q.includes("kb_fact_verdicts") && q.includes("left join") && q.includes("limit")) {
    const filtered = applyVerdictFilters(params);
    // Enrich with entity_id and label from factsStore
    return filtered.map((v) => {
      const fact = factsStore.find((f) => f.fact_id === v.fact_id);
      return {
        ...v,
        entity_id: fact?.entity_id ?? null,
        label: fact?.label ?? null,
      };
    });
  }

  // SELECT from kb_fact_verdicts with WHERE fact_id = ? (single verdict lookup)
  if (q.includes("kb_fact_verdicts") && q.includes("limit")) {
    if (params.length > 0) {
      const factIdParam = params.find(
        (p) => typeof p === "string" && (p as string).startsWith("f_")
      );
      if (factIdParam) {
        return verdicts.filter((v) => v.fact_id === factIdParam);
      }
    }
    return verdicts;
  }

  // INSERT into kb_fact_resource_verifications (POST /verifications)
  if (q.includes("insert") && q.includes("kb_fact_resource_verifications")) {
    const nextId = verifications.length > 0 ? Math.max(...verifications.map((v) => v.id)) + 1 : 1;
    const now = new Date().toISOString();
    // Extract fact_id from params (first string starting with f_)
    const factId = params.find(
      (p) => typeof p === "string" && (p as string).startsWith("f_")
    ) as string ?? "unknown";
    const record: VerificationRecord = {
      id: nextId,
      fact_id: factId,
      resource_id: null,
      verdict: "confirmed",
      confidence: null,
      extracted_value: null,
      checker_model: null,
      is_primary_source: false,
      checked_at: now,
      notes: null,
      source_url: null,
      created_at: now,
      updated_at: now,
    };
    verifications.push(record);
    return [{ id: nextId }];
  }

  // UPDATE kb_fact_verdicts SET needs_recheck (auto-flag on new verification)
  if (q.includes("update") && q.includes("kb_fact_verdicts")) {
    const factId = params.find(
      (p) => typeof p === "string" && (p as string).startsWith("f_")
    ) as string | undefined;
    if (factId) {
      const verdict = verdicts.find((v) => v.fact_id === factId);
      if (verdict) {
        verdict.needs_recheck = true;
        verdict.updated_at = new Date().toISOString();
        return [{ fact_id: verdict.fact_id }];
      }
    }
    return [];
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

  return [];
}

// ---- Mock setup ----

vi.mock("../db.js", () => mockDbModule(dispatch));

let app: Hono;

beforeEach(async () => {
  resetStores();
  const { factbaseVerificationsRoute } = await import(
    "../routes/factbase-verifications.js"
  );
  app = new Hono().route("/api/kb-verifications", factbaseVerificationsRoute);
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

  it("includes entityId and factLabel in verdict rows", async () => {
    const res = await app.request("/api/kb-verifications/verdicts?limit=10");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verdicts.length).toBe(3);
    // Verify entity enrichment from LEFT JOIN with facts table
    const first = body.verdicts[0];
    expect(first.entityId).toBe("anthropic");
    expect(first.factLabel).toBe("Funding total");
    // Verify a verdict with null label
    const third = body.verdicts[2];
    expect(third.entityId).toBe("openai");
    expect(third.factLabel).toBeNull();
  });

  it("filters by entity_id", async () => {
    const res = await app.request(
      "/api/kb-verifications/verdicts?entity_id=openai&limit=10"
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verdicts.length).toBe(1);
    expect(body.verdicts[0].entityId).toBe("openai");
    expect(body.total).toBe(1);
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

describe("POST /api/kb-verifications/verifications", () => {
  it("inserts a resource verification and returns 201", async () => {
    const res = await app.request("/api/kb-verifications/verifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        factId: "f_abc123",
        verdict: "confirmed",
        confidence: 0.9,
        extractedValue: "14 billion",
        checkerModel: "claude-3-haiku",
        isPrimarySource: true,
        notes: "Direct match from source",
        sourceUrl: "https://example.com/funding-report",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeGreaterThan(0);
    expect(body.verdictFlagged).toBe(true);
  });

  it("sets needs_recheck on existing verdict when new verification is inserted", async () => {
    // f_abc123 starts with needs_recheck: false
    const preVerdict = verdicts.find((v) => v.fact_id === "f_abc123");
    expect(preVerdict?.needs_recheck).toBe(false);

    await app.request("/api/kb-verifications/verifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        factId: "f_abc123",
        verdict: "contradicted",
        confidence: 0.8,
      }),
    });

    // After insertion, the verdict should be flagged for recheck
    const postVerdict = verdicts.find((v) => v.fact_id === "f_abc123");
    expect(postVerdict?.needs_recheck).toBe(true);
  });

  it("returns verdictFlagged: false when no existing verdict exists", async () => {
    const res = await app.request("/api/kb-verifications/verifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        factId: "f_newFact999",
        verdict: "confirmed",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.verdictFlagged).toBe(false);
  });

  it("rejects invalid verdict values", async () => {
    const res = await app.request("/api/kb-verifications/verifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        factId: "f_abc123",
        verdict: "invalid_verdict",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects missing factId", async () => {
    const res = await app.request("/api/kb-verifications/verifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        verdict: "confirmed",
      }),
    });
    expect(res.status).toBe(400);
  });
});
