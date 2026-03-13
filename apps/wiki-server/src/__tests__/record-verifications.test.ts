import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { mockDbModule } from "./test-utils.js";

// ---- In-memory stores ----

interface VerdictRecord {
  record_type: string;
  record_id: string;
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
  record_type: string;
  record_id: string;
  field_name: string | null;
  expected_value: string | null;
  source_url: string | null;
  verdict: string;
  confidence: number | null;
  extracted_value: string | null;
  checker_model: string | null;
  notes: string | null;
  checked_at: string;
  created_at: string;
  updated_at: string;
}

let verdicts: VerdictRecord[];
let verifications: VerificationRecord[];

function resetStores() {
  const now = new Date().toISOString();
  verdicts = [
    {
      record_type: "grant",
      record_id: "GR_abc123",
      verdict: "confirmed",
      confidence: 0.95,
      reasoning: "Amount and dates match source",
      sources_checked: 2,
      needs_recheck: false,
      last_computed_at: now,
      created_at: now,
      updated_at: now,
    },
    {
      record_type: "grant",
      record_id: "GR_def456",
      verdict: "contradicted",
      confidence: 0.8,
      reasoning: "Amount differs from source",
      sources_checked: 1,
      needs_recheck: true,
      last_computed_at: now,
      created_at: now,
      updated_at: now,
    },
    {
      record_type: "personnel",
      record_id: "PE_ghi789",
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
      record_type: "grant",
      record_id: "GR_abc123",
      field_name: "amount",
      expected_value: "$1,000,000",
      source_url: "https://example.com/grant",
      verdict: "confirmed",
      confidence: 0.9,
      extracted_value: "$1M grant awarded",
      checker_model: "claude-3-haiku",
      notes: "Direct match",
      checked_at: now,
      created_at: now,
      updated_at: now,
    },
  ];
}

function dispatch(query: string, params: unknown[]): unknown[] {
  const q = query.toLowerCase();

  // COUNT + aggregate stats for record_verdicts
  if (q.includes("count(") && q.includes("record_verdicts")) {
    if (q.includes("avg(") || q.includes("filter")) {
      const total = verdicts.length;
      const needsRecheck = verdicts.filter((v) => v.needs_recheck).length;
      const avgConf =
        verdicts.reduce((sum, v) => sum + (v.confidence ?? 0), 0) /
        (total || 1);
      return [
        { count: total, needs_recheck: needsRecheck, avg_confidence: avgConf },
      ];
    }

    // Group by verdict
    if (q.includes("group by") && q.includes("verdict")) {
      const groups = new Map<string, number>();
      for (const v of verdicts) {
        groups.set(v.verdict, (groups.get(v.verdict) ?? 0) + 1);
      }
      return [...groups.entries()].map(([verdict, count]) => ({
        verdict,
        count,
      }));
    }

    // Group by record_type
    if (q.includes("group by") && q.includes("record_type")) {
      const groups = new Map<string, number>();
      for (const v of verdicts) {
        groups.set(v.record_type, (groups.get(v.record_type) ?? 0) + 1);
      }
      return [...groups.entries()].map(([recordType, count]) => ({
        record_type: recordType,
        count,
      }));
    }

    // Plain count with optional WHERE
    let filtered = verdicts;
    for (const p of params) {
      if (typeof p === "string") {
        filtered = filtered.filter(
          (v) => v.record_type === p || v.verdict === p
        );
      }
      if (typeof p === "boolean") {
        filtered = filtered.filter((v) => v.needs_recheck === p);
      }
    }
    return [{ count: filtered.length }];
  }

  // SELECT from record_verdicts with WHERE and LIMIT (verdicts list or single lookup)
  if (q.includes("record_verdicts") && q.includes("limit")) {
    let filtered = verdicts;
    for (const p of params) {
      if (typeof p === "string") {
        // Try each filter type; apply ALL matching ones (AND semantics)
        const matchesType = filtered.some((v) => v.record_type === p);
        const matchesVerdict = filtered.some((v) => v.verdict === p);
        const matchesId = filtered.some((v) => v.record_id === p);

        if (matchesType) {
          filtered = filtered.filter((v) => v.record_type === p);
        } else if (matchesId) {
          filtered = filtered.filter((v) => v.record_id === p);
        } else if (matchesVerdict) {
          filtered = filtered.filter((v) => v.verdict === p);
        } else {
          // No match — this is a filter that eliminates everything
          filtered = [];
        }
      }
      if (typeof p === "boolean") {
        filtered = filtered.filter((v) => v.needs_recheck === p);
      }
    }
    return filtered;
  }

  // INSERT into record_verifications
  if (q.includes("insert") && q.includes("record_verifications")) {
    const nextId =
      verifications.length > 0
        ? Math.max(...verifications.map((v) => v.id)) + 1
        : 1;
    verifications.push({
      id: nextId,
      record_type: "grant",
      record_id: "test",
      field_name: null,
      expected_value: null,
      source_url: null,
      verdict: "confirmed",
      confidence: null,
      extracted_value: null,
      checker_model: null,
      notes: null,
      checked_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    return [{ id: nextId }];
  }

  // UPDATE record_verdicts (auto-flag needs_recheck)
  if (q.includes("update") && q.includes("record_verdicts")) {
    for (const p of params) {
      if (typeof p === "string") {
        const v = verdicts.find(
          (v) => v.record_type === p || v.record_id === p
        );
        if (v) {
          v.needs_recheck = true;
          v.updated_at = new Date().toISOString();
          return [{ record_id: v.record_id }];
        }
      }
    }
    return [];
  }

  // INSERT/UPSERT into record_verdicts (POST /verdicts)
  if (
    q.includes("insert") &&
    q.includes("record_verdicts") &&
    q.includes("on conflict")
  ) {
    return [];
  }

  // SELECT from record_verifications (by-record lookup)
  if (q.includes("record_verifications")) {
    let filtered = verifications;
    for (const p of params) {
      if (typeof p === "string") {
        const byType = filtered.filter((v) => v.record_type === p);
        if (byType.length > 0) {
          filtered = byType;
          continue;
        }
        const byId = filtered.filter((v) => v.record_id === p);
        if (byId.length > 0) {
          filtered = byId;
          continue;
        }
      }
    }
    return filtered;
  }

  return [];
}

// ---- Mock setup ----

vi.mock("../db.js", () => mockDbModule(dispatch));

let app: Hono;

beforeEach(async () => {
  resetStores();
  const { recordVerificationsRoute } = await import(
    "../routes/record-verifications.js"
  );
  app = new Hono().route(
    "/api/record-verifications",
    recordVerificationsRoute
  );
});

// ---- Tests ----

describe("GET /api/record-verifications/stats", () => {
  it("returns aggregate stats", async () => {
    const res = await app.request("/api/record-verifications/stats");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total_records).toBe(3);
    expect(body.needs_recheck).toBeGreaterThanOrEqual(0);
    expect(body.avg_confidence).toBeGreaterThan(0);
    expect(body.by_verdict).toBeDefined();
    expect(body.by_type).toBeDefined();
  });
});

describe("GET /api/record-verifications/verdicts", () => {
  it("returns verdicts list with pagination", async () => {
    const res = await app.request(
      "/api/record-verifications/verdicts?limit=10"
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verdicts).toBeInstanceOf(Array);
    expect(body.total).toBeGreaterThanOrEqual(0);
  });

  it("filters by record_type", async () => {
    const res = await app.request(
      "/api/record-verifications/verdicts?record_type=grant&limit=10"
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    for (const v of body.verdicts) {
      expect(v.recordType).toBe("grant");
    }
  });

  it("validates limit parameter", async () => {
    const res = await app.request(
      "/api/record-verifications/verdicts?limit=999"
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/record-verifications/verdicts/:recordType/:recordId", () => {
  it("returns verdict with verifications", async () => {
    const res = await app.request(
      "/api/record-verifications/verdicts/grant/GR_abc123"
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verdict).toBeDefined();
    expect(body.verdict.recordType).toBe("grant");
    expect(body.verdict.recordId).toBe("GR_abc123");
    expect(body.verifications).toBeInstanceOf(Array);
  });

  it("returns 404 for nonexistent record", async () => {
    const res = await app.request(
      "/api/record-verifications/verdicts/grant/ZZZZZZZZZZ"
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /api/record-verifications/by-record/:recordType/:recordId", () => {
  it("returns verifications for a record", async () => {
    const res = await app.request(
      "/api/record-verifications/by-record/grant/GR_abc123"
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verifications).toBeInstanceOf(Array);
  });

  it("returns empty for invalid record type", async () => {
    const res = await app.request(
      "/api/record-verifications/by-record/invalid-type/GR_abc123"
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verifications).toEqual([]);
  });
});

describe("POST /api/record-verifications/verifications", () => {
  it("creates a verification", async () => {
    const res = await app.request(
      "/api/record-verifications/verifications",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recordType: "grant",
          recordId: "GR_abc123",
          verdict: "confirmed",
          confidence: 0.9,
          sourceUrl: "https://example.com/source",
          extractedValue: "Grant of $1M",
          checkerModel: "claude-3-haiku",
          notes: "Matched amount",
        }),
      }
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeDefined();
  });

  it("rejects invalid record type", async () => {
    const res = await app.request(
      "/api/record-verifications/verifications",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recordType: "invalid-type",
          recordId: "test",
          verdict: "confirmed",
        }),
      }
    );
    expect(res.status).toBe(400);
  });

  it("rejects invalid verdict", async () => {
    const res = await app.request(
      "/api/record-verifications/verifications",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recordType: "grant",
          recordId: "test",
          verdict: "invalid-verdict",
        }),
      }
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/record-verifications/verdicts", () => {
  it("upserts a verdict", async () => {
    const res = await app.request(
      "/api/record-verifications/verdicts",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recordType: "grant",
          recordId: "GR_abc123",
          verdict: "confirmed",
          confidence: 0.95,
          reasoning: "All checks passed",
          sourcesChecked: 3,
        }),
      }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});
