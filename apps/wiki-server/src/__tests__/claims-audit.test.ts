/**
 * Tests for GET /api/integrity/claims-audit
 *
 * Validates that each audit check correctly detects (and doesn't false-positive)
 * the data integrity issues from bugs in PRs #1051, #1052, #1060, #1075.
 */

import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { mockDbModule, type SqlDispatcher } from "./test-utils.js";

// ---------------------------------------------------------------------------
// Mock DB dispatch — routes SQL queries to in-memory data
// ---------------------------------------------------------------------------

/** Build a dispatch function from a set of data scenarios. */
function buildDispatch(options: {
  nullClaimModeCount?: number;
  invalidClaimModes?: Array<{ val: string; cnt: string }>;
  claimsWithoutPrimary?: Array<{ claim_id: string; source_count: string }>;
  selfRefs?: Array<{ id: string; entity_id: string }>;
  capsIssues?: Array<{ entity_id: string; cnt: string }>;
  orphanedSources?: Array<{ id: string; claim_id: string }>;
  precisionIssues?: Array<{
    id: string;
    entity_id: string;
    value_numeric: string;
  }>;
  emptyTextCount?: number;
  duplicates?: Array<{ entity_id: string; claim_text: string; cnt: string }>;
  totalClaims?: number;
  totalSources?: number;
}): SqlDispatcher {
  return (query: string, _params: unknown[]) => {
    const q = query.toLowerCase();

    // 1. claim_mode IS NULL count
    if (q.includes("claim_mode is null")) {
      return [{ cnt: String(options.nullClaimModeCount ?? 0) }];
    }

    // 2. invalid claim_mode values
    if (q.includes("claim_mode not in")) {
      return options.invalidClaimModes ?? [];
    }

    // 3. claims without primary source
    if (q.includes("claim_sources") && q.includes("is_primary")) {
      return options.claimsWithoutPrimary ?? [];
    }

    // 4. self-referential relatedEntities
    if (q.includes("related_entities") && q.includes("to_jsonb")) {
      return options.selfRefs ?? [];
    }

    // 5. capitalization issues
    if (q.includes("lower(entity_id)")) {
      return options.capsIssues ?? [];
    }

    // 6. orphaned claim_sources
    if (q.includes("claim_sources") && q.includes("left join")) {
      return options.orphanedSources ?? [];
    }

    // 7. numeric precision
    if (q.includes("value_numeric") && q.includes("round")) {
      return options.precisionIssues ?? [];
    }

    // 8. empty claim_text
    if (q.includes("trim(claim_text)")) {
      return [{ cnt: String(options.emptyTextCount ?? 0) }];
    }

    // 9. duplicates
    if (q.includes("group by entity_id, claim_text") && q.includes("having")) {
      return options.duplicates ?? [];
    }

    // 10. totals
    if (q.includes("total_claims") && q.includes("total_sources")) {
      return [
        {
          total_claims: String(options.totalClaims ?? 100),
          total_sources: String(options.totalSources ?? 50),
        },
      ];
    }

    // Fallback: health check / entity_ids sequences
    if (q.includes("count(*)") && q.includes("entity_ids")) {
      return [{ count: 0 }];
    }
    if (q.includes("last_value")) {
      return [{ last_value: 0, is_called: false }];
    }

    return [];
  };
}

// ---------------------------------------------------------------------------
// Test setup helper
// ---------------------------------------------------------------------------

async function createApp(dispatch: SqlDispatcher) {
  vi.resetModules();
  vi.doMock("../db.js", () => mockDbModule(dispatch));
  const { integrityRoute } = await import("../routes/integrity.js");
  const app = new Hono().route("/api/integrity", integrityRoute);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/integrity/claims-audit", () => {
  it("returns clean status when all checks pass", async () => {
    const app = await createApp(buildDispatch({ totalClaims: 200, totalSources: 80 }));
    const res = await app.request("/api/integrity/claims-audit");
    expect(res.status).toBe(200);

    const data = (await res.json()) as Record<string, unknown>;
    expect(data.status).toBe("clean");

    const summary = data.summary as Record<string, number>;
    expect(summary.total_claims).toBe(200);
    expect(summary.total_sources).toBe(80);
    expect(summary.failures).toBe(0);
    expect(summary.warnings).toBe(0);
    expect(summary.checks_run).toBe(9);
    expect(summary.passed).toBe(9);
  });

  it("detects NULL claim_mode as a failure", async () => {
    const app = await createApp(buildDispatch({ nullClaimModeCount: 15 }));
    const res = await app.request("/api/integrity/claims-audit");
    const data = (await res.json()) as Record<string, unknown>;

    expect(data.status).toBe("issues_found");
    const checks = data.checks as Array<Record<string, unknown>>;
    const check = checks.find((c) => c.name === "claim_mode_not_null");
    expect(check).toBeDefined();
    expect(check!.status).toBe("fail");
    expect(check!.count).toBe(15);
  });

  it("detects invalid claim_mode values as a failure", async () => {
    const app = await createApp(
      buildDispatch({
        invalidClaimModes: [{ val: "unknown", cnt: "3" }],
      })
    );
    const res = await app.request("/api/integrity/claims-audit");
    const data = (await res.json()) as Record<string, unknown>;

    const checks = data.checks as Array<Record<string, unknown>>;
    const check = checks.find((c) => c.name === "claim_mode_valid_values");
    expect(check!.status).toBe("fail");
    expect(check!.count).toBe(3);
  });

  it("detects claims without primary source as a warning", async () => {
    const app = await createApp(
      buildDispatch({
        claimsWithoutPrimary: [
          { claim_id: "42", source_count: "3" },
          { claim_id: "99", source_count: "1" },
        ],
      })
    );
    const res = await app.request("/api/integrity/claims-audit");
    const data = (await res.json()) as Record<string, unknown>;

    const checks = data.checks as Array<Record<string, unknown>>;
    const check = checks.find(
      (c) => c.name === "claim_sources_has_primary"
    );
    expect(check!.status).toBe("warn");
    expect(check!.count).toBe(2);
    expect(check!.sample).toHaveLength(2);
  });

  it("detects self-referential relatedEntities as a warning", async () => {
    const app = await createApp(
      buildDispatch({
        selfRefs: [{ id: "7", entity_id: "anthropic" }],
      })
    );
    const res = await app.request("/api/integrity/claims-audit");
    const data = (await res.json()) as Record<string, unknown>;

    const checks = data.checks as Array<Record<string, unknown>>;
    const check = checks.find(
      (c) => c.name === "no_self_referential_related_entities"
    );
    expect(check!.status).toBe("warn");
    expect(check!.count).toBe(1);
  });

  it("detects capitalization inconsistencies as a warning", async () => {
    const app = await createApp(
      buildDispatch({
        capsIssues: [
          { entity_id: "Anthropic", cnt: "12" },
          { entity_id: "OpenAI", cnt: "5" },
        ],
      })
    );
    const res = await app.request("/api/integrity/claims-audit");
    const data = (await res.json()) as Record<string, unknown>;

    const checks = data.checks as Array<Record<string, unknown>>;
    const check = checks.find((c) => c.name === "entity_id_lowercase");
    expect(check!.status).toBe("warn");
    expect(check!.count).toBe(17);
  });

  it("detects orphaned claim_sources as a failure", async () => {
    const app = await createApp(
      buildDispatch({
        orphanedSources: [{ id: "1", claim_id: "999" }],
      })
    );
    const res = await app.request("/api/integrity/claims-audit");
    const data = (await res.json()) as Record<string, unknown>;

    const checks = data.checks as Array<Record<string, unknown>>;
    const check = checks.find(
      (c) => c.name === "no_orphaned_claim_sources"
    );
    expect(check!.status).toBe("fail");
    expect(check!.count).toBe(1);
  });

  it("detects empty claim_text as a failure", async () => {
    const app = await createApp(buildDispatch({ emptyTextCount: 3 }));
    const res = await app.request("/api/integrity/claims-audit");
    const data = (await res.json()) as Record<string, unknown>;

    const checks = data.checks as Array<Record<string, unknown>>;
    const check = checks.find((c) => c.name === "no_empty_claim_text");
    expect(check!.status).toBe("fail");
    expect(check!.count).toBe(3);
  });

  it("detects exact duplicate claims as a warning", async () => {
    const app = await createApp(
      buildDispatch({
        duplicates: [
          {
            entity_id: "kalshi",
            claim_text: "Kalshi was founded in 2018.",
            cnt: "3",
          },
        ],
      })
    );
    const res = await app.request("/api/integrity/claims-audit");
    const data = (await res.json()) as Record<string, unknown>;

    const checks = data.checks as Array<Record<string, unknown>>;
    const check = checks.find(
      (c) => c.name === "no_exact_duplicate_claims"
    );
    expect(check!.status).toBe("warn");
    expect(check!.count).toBe(2); // 3 total - 1 original = 2 duplicates
  });

  it("summary counts are correct with mixed pass/warn/fail", async () => {
    const app = await createApp(
      buildDispatch({
        nullClaimModeCount: 5, // fail
        selfRefs: [{ id: "1", entity_id: "test" }], // warn
        emptyTextCount: 2, // fail
      })
    );
    const res = await app.request("/api/integrity/claims-audit");
    const data = (await res.json()) as Record<string, unknown>;

    expect(data.status).toBe("issues_found");
    const summary = data.summary as Record<string, number>;
    expect(summary.failures).toBe(2);
    expect(summary.warnings).toBe(1);
    expect(summary.passed).toBe(6);
    expect(summary.checks_run).toBe(9);
  });

  it("includes checked_at timestamp", async () => {
    const app = await createApp(buildDispatch({}));
    const res = await app.request("/api/integrity/claims-audit");
    const data = (await res.json()) as Record<string, unknown>;

    expect(data.checked_at).toBeDefined();
    expect(typeof data.checked_at).toBe("string");
    // Should be a valid ISO timestamp
    const date = new Date(data.checked_at as string);
    expect(date.getTime()).not.toBeNaN();
  });
});
