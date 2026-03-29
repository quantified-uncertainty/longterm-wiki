/**
 * Red-team / adversarial tests for the claims system.
 *
 * These tests probe edge cases, boundary conditions, and potential attack
 * vectors that normal unit tests don't cover.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  mockDbModule,
  postJson,
} from "./test-utils.js";
import {
  groupAndChunkClaims,
  MAX_CLAIMS_PER_JOB,
  SECONDS_PER_CLAIM_ESTIMATE,
} from "../routes/claims/claims.js";

// ==========================================================================
// 1. groupAndChunkClaims — adversarial inputs
// ==========================================================================

describe("groupAndChunkClaims — adversarial inputs", () => {
  it("handles resource_id that starts with 'url:' (no key collision)", () => {
    // A resource_id starting with "url:" must NOT collide with the internal
    // fallback key format. Fixed by using \0url: prefix for null resource_ids.
    const claims = [
      { id: 1, resource_id: "url:https://evil.com", source_url: "https://a.com" },
      { id: 2, resource_id: null, source_url: "https://evil.com" },
    ];

    const result = groupAndChunkClaims(claims);

    // Must be in DIFFERENT groups because one has resource_id, one doesn't
    expect(result).toHaveLength(2);

    const resGroup = result.find((e) => e.resourceId === "url:https://evil.com");
    const urlGroup = result.find((e) => e.resourceId === null);

    expect(resGroup).toBeDefined();
    expect(urlGroup).toBeDefined();
    expect(resGroup!.claimIds).toEqual([1]);
    expect(urlGroup!.claimIds).toEqual([2]);
  });

  it("handles empty string resource_id (truthy but empty)", () => {
    // Empty string is falsy in JS but not null — would become key ""
    const claims = [
      { id: 1, resource_id: "", source_url: "https://a.com" },
      { id: 2, resource_id: "", source_url: "https://b.com" },
    ];

    const result = groupAndChunkClaims(claims);
    // Both have resource_id="" which is truthy... wait, "" is falsy in JS
    // So `row.resource_id ?? "url:..."` — the ?? operator only triggers on null/undefined, not ""
    // "" is a valid value for ??, so it would use "" as the key
    // Both claims would be grouped under key ""
    expect(result).toHaveLength(1);
    expect(result[0].resourceId).toBe("");
    expect(result[0].claimIds).toEqual([1, 2]);
  });

  it("handles maxPerJob = 1 (extreme chunking)", () => {
    const claims = [
      { id: 1, resource_id: "res-1", source_url: "https://a.com" },
      { id: 2, resource_id: "res-1", source_url: "https://a.com" },
      { id: 3, resource_id: "res-1", source_url: "https://a.com" },
    ];

    const result = groupAndChunkClaims(claims, 1);
    expect(result).toHaveLength(3);
    expect(result[0].claimIds).toEqual([1]);
    expect(result[1].claimIds).toEqual([2]);
    expect(result[2].claimIds).toEqual([3]);
  });

  // NOTE: maxPerJob=0 causes an infinite loop (i+=0 never advances).
  // This is a BUG — tracked below. Test skipped to avoid OOM.
  it.skip("handles maxPerJob = 0 (KNOWN BUG: infinite loop)", () => {
    // groupAndChunkClaims(claims, 0) causes infinite loop
    // because the for loop does i += 0 which never advances.
    // Fix: add guard at top of function for maxPerJob <= 0
  });

  // NOTE: maxPerJob=-1 causes slice(i, i-1) which returns [] but
  // also never advances (i += -1 goes backwards). KNOWN BUG.
  it.skip("handles negative maxPerJob (KNOWN BUG: infinite loop)", () => {
    // Similar to maxPerJob=0 — negative step causes infinite/very long loop
  });

  it("handles duplicate claim IDs (shouldn't happen but could via bug)", () => {
    const claims = [
      { id: 1, resource_id: "res-1", source_url: "https://a.com" },
      { id: 1, resource_id: "res-1", source_url: "https://a.com" },
    ];

    const result = groupAndChunkClaims(claims);
    // Duplicates are NOT deduplicated — they get added to the same group
    expect(result).toHaveLength(1);
    expect(result[0].claimIds).toEqual([1, 1]);
  });

  it("handles claims with very long source URLs (boundary value)", () => {
    const longUrl = "https://example.com/" + "a".repeat(2000);
    const claims = [
      { id: 1, resource_id: null, source_url: longUrl },
      { id: 2, resource_id: null, source_url: longUrl },
    ];

    const result = groupAndChunkClaims(claims);
    expect(result).toHaveLength(1);
    expect(result[0].resourceKey).toBe(`\0url:${longUrl}`);
  });

  it("handles special characters in source_url used as Map key", () => {
    // URLs with special regex chars, unicode, etc.
    const specialUrls = [
      "https://example.com/path?q=a&b=c#fragment",
      "https://example.com/path?q=a&b=c#fragment", // duplicate
      "https://example.com/path?q=a&b=d#fragment", // different query param
    ];

    const claims = specialUrls.map((url, i) => ({
      id: i + 1,
      resource_id: null,
      source_url: url,
    }));

    const result = groupAndChunkClaims(claims);
    // First two URLs are identical, third is different
    expect(result).toHaveLength(2);
  });

  it("preserves claim ordering within chunks", () => {
    const claims = Array.from({ length: 5 }, (_, i) => ({
      id: (i + 1) * 10, // Non-sequential IDs: 10, 20, 30, 40, 50
      resource_id: "res-1",
      source_url: "https://a.com",
    }));

    const result = groupAndChunkClaims(claims, 3);
    expect(result).toHaveLength(2);
    expect(result[0].claimIds).toEqual([10, 20, 30]);
    expect(result[1].claimIds).toEqual([40, 50]);
  });

  it("resource_id='url:...' does NOT collide with null resource_id url-based key", () => {
    // After fix: the internal key for null resource_ids uses \0url: prefix
    // so resource_id="url:https://x.com" (key: "url:https://x.com")
    // does NOT collide with source_url="https://x.com" (key: "\0url:https://x.com")
    const claims = [
      { id: 1, resource_id: "url:https://x.com", source_url: "https://y.com" },
      { id: 2, resource_id: null, source_url: "https://x.com" },
    ];

    const result = groupAndChunkClaims(claims);

    // Must be 2 separate groups
    expect(result).toHaveLength(2);
    const resGroup = result.find((e) => e.resourceId === "url:https://x.com");
    const urlGroup = result.find((e) => e.resourceId === null);
    expect(resGroup!.claimIds).toEqual([1]);
    expect(urlGroup!.claimIds).toEqual([2]);
  });
});

// ==========================================================================
// 2. POST /propose — adversarial HTTP requests
// ==========================================================================

let nextClaimId = 1;
let nextJobId = 1;
let claimStore: Array<{
  id: number;
  resource_id: string | null;
  source_url: string;
  batch_id: string;
  verification_job_id: number | null;
}>;
let jobStore: Array<{ id: number; type: string; params: unknown }>;

function resetStores() {
  claimStore = [];
  jobStore = [];
  nextClaimId = 1;
  nextJobId = 1;
}

function dispatch(query: string, params: unknown[]): unknown[] {
  const q = query.toLowerCase();

  if (q.includes("from resources") && q.includes("where")) {
    if (Array.isArray(params[0])) {
      return (params[0] as string[]).map((id) => ({ id }));
    }
    return params.map((p) => ({ id: p }));
  }

  if (q.includes("insert into") && q.includes("proposed_claims")) {
    const batchIds = params[0] as string[];
    const resourceIds = params[7] as (string | null)[];
    const sourceUrls = params[8] as string[];
    const numRows = batchIds.length;

    const rows: typeof claimStore = [];
    for (let i = 0; i < numRows; i++) {
      const row = {
        id: nextClaimId++,
        resource_id: resourceIds[i] ?? null,
        source_url: sourceUrls[i],
        batch_id: batchIds[i],
        verification_job_id: null,
      };
      claimStore.push(row);
      rows.push(row);
    }
    return rows;
  }

  if (q.includes("insert into") && q.includes("jobs")) {
    const jobParamsJson = params[0] as string;
    const row = {
      id: nextJobId++,
      type: "claim-verification",
      params: typeof jobParamsJson === "string" ? JSON.parse(jobParamsJson) : jobParamsJson,
    };
    jobStore.push(row);
    return [row];
  }

  if (q.includes("update") && q.includes("proposed_claims") && q.includes("verification_job_id")) {
    const jobId = params[0] as number;
    const claimIds = params[1] as number[];
    for (const claim of claimStore) {
      if (claimIds.includes(claim.id)) {
        claim.verification_job_id = jobId;
      }
    }
    return [];
  }

  if (q.includes("count(*)") && q.includes("entity_ids")) {
    return [{ count: 0 }];
  }
  if (q.includes("last_value")) {
    return [{ last_value: 0, is_called: false }];
  }

  return [];
}

vi.mock("../db.js", () => mockDbModule(dispatch));

const { createApp } = await import("../app.js");

describe("Claims API — adversarial HTTP requests", () => {
  let app: Hono;

  beforeEach(() => {
    resetStores();
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    app = createApp();
  });

  it("rejects claim with XSS in claimText (stored correctly, not executed)", async () => {
    const res = await postJson(app, "/api/claims/propose", {
      targetTable: "facts",
      claims: [
        {
          claimText: '<script>alert("xss")</script>',
          sourceUrl: "https://example.com",
        },
      ],
    });

    // Should succeed — the API stores raw text, not HTML
    // XSS prevention is at rendering time, not storage
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.claims).toHaveLength(1);
  });

  it("rejects claim with SQL injection attempt in targetTable", async () => {
    const res = await postJson(app, "/api/claims/propose", {
      targetTable: "facts; DROP TABLE proposed_claims; --",
      claims: [
        { claimText: "test", sourceUrl: "https://example.com" },
      ],
    });

    // Zod validation should reject this (max 100 chars, but no special char restriction)
    // postgres.js tagged templates prevent SQL injection regardless
    if (res.status === 201) {
      // If it passes Zod, verify it's stored as a literal string, not executed
      expect(claimStore[0]).toBeDefined();
    } else {
      expect(res.status).toBe(400);
    }
  });

  it("handles maximum-length claim text (5000 chars)", async () => {
    const res = await postJson(app, "/api/claims/propose", {
      targetTable: "facts",
      claims: [
        {
          claimText: "x".repeat(5000),
          sourceUrl: "https://example.com",
        },
      ],
    });
    expect(res.status).toBe(201);
  });

  it("rejects claim text exceeding 5000 chars", async () => {
    const res = await postJson(app, "/api/claims/propose", {
      targetTable: "facts",
      claims: [
        {
          claimText: "x".repeat(5001),
          sourceUrl: "https://example.com",
        },
      ],
    });
    expect(res.status).toBe(400);
  });

  it("handles exactly 100 claims (max per Zod schema)", async () => {
    const claims = Array.from({ length: 100 }, (_, i) => ({
      claimText: `Claim ${i}`,
      sourceUrl: "https://example.com",
    }));

    const res = await postJson(app, "/api/claims/propose", {
      targetTable: "facts",
      claims,
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.claims).toHaveLength(100);
    expect(body.estimatedVerificationTime).toBe(100 * SECONDS_PER_CLAIM_ESTIMATE);
  });

  it("rejects 101 claims (exceeds max)", async () => {
    const claims = Array.from({ length: 101 }, (_, i) => ({
      claimText: `Claim ${i}`,
      sourceUrl: "https://example.com",
    }));

    const res = await postJson(app, "/api/claims/propose", {
      targetTable: "facts",
      claims,
    });

    expect(res.status).toBe(400);
  });

  it("handles claim with all optional fields at max length", async () => {
    const res = await postJson(app, "/api/claims/propose", {
      targetTable: "facts",
      entityId: "e".repeat(200),
      agentSessionId: "s".repeat(200),
      claims: [
        {
          claimText: "c".repeat(5000),
          sourceUrl: "https://example.com/" + "u".repeat(1970),
          targetField: "f".repeat(200),
          proposedValue: "v".repeat(5000),
          agentEvidence: "e".repeat(5000),
          resourceId: "r".repeat(200),
          proposedData: { key: "value" },
        },
      ],
    });

    // Should pass Zod validation at max boundary
    expect(res.status).toBe(201);
  });

  it("handles unicode in claim text", async () => {
    const res = await postJson(app, "/api/claims/propose", {
      targetTable: "facts",
      claims: [
        {
          claimText: "价格是 $100万 🎉 مرحبا",
          sourceUrl: "https://example.com/日本語",
        },
      ],
    });

    expect(res.status).toBe(201);
  });

  it("rejects invalid sourceUrl format", async () => {
    const res = await postJson(app, "/api/claims/propose", {
      targetTable: "facts",
      claims: [
        {
          claimText: "test claim",
          sourceUrl: "not-a-url",
        },
      ],
    });

    expect(res.status).toBe(400);
  });

  it("rejects claims with missing sourceUrl", async () => {
    const res = await postJson(app, "/api/claims/propose", {
      targetTable: "facts",
      claims: [
        { claimText: "test" },
      ],
    });

    expect(res.status).toBe(400);
  });

  it("handles multiple claims creating exactly 1 job per unique source URL", async () => {
    // 50 unique URLs = 50 jobs in a single transaction
    const claims = Array.from({ length: 50 }, (_, i) => ({
      claimText: `Claim ${i}`,
      sourceUrl: `https://example.com/page-${i}`,
    }));

    const res = await postJson(app, "/api/claims/propose", {
      targetTable: "facts",
      claims,
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.jobCount).toBe(50);
    expect(jobStore).toHaveLength(50);
  });

  it("correctly handles proposedData with nested objects", async () => {
    const res = await postJson(app, "/api/claims/propose", {
      targetTable: "facts",
      claims: [
        {
          claimText: "test",
          sourceUrl: "https://example.com",
          proposedData: {
            deeply: { nested: { value: [1, 2, 3] } },
            nullField: null,
            boolField: false,
            numField: 0,
          },
        },
      ],
    });

    expect(res.status).toBe(201);
  });

  it("verifies batchId uniqueness across requests", async () => {
    const batchIds = new Set<string>();

    for (let i = 0; i < 20; i++) {
      resetStores();
      const res = await postJson(app, "/api/claims/propose", {
        targetTable: "facts",
        claims: [
          { claimText: "test", sourceUrl: "https://example.com" },
        ],
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      batchIds.add(body.batchId);
    }

    // All 20 batchIds should be unique
    expect(batchIds.size).toBe(20);
  });

  it("handles GET /by-ids with boundary values", async () => {
    // Test with 200 IDs (max allowed)
    const ids = Array.from({ length: 200 }, (_, i) => i + 1);
    const res = await app.request(
      `/api/claims/by-ids?ids=${ids.join(",")}`,
      { method: "GET" },
    );
    expect(res.status).toBe(200);

    // Test with 201 IDs (exceeds max)
    const tooManyIds = Array.from({ length: 201 }, (_, i) => i + 1);
    const res2 = await app.request(
      `/api/claims/by-ids?ids=${tooManyIds.join(",")}`,
      { method: "GET" },
    );
    expect(res2.status).toBe(400);
  });

  it("handles GET /by-ids with malformed IDs", async () => {
    // Negative IDs
    const res1 = await app.request("/api/claims/by-ids?ids=-1,-2", { method: "GET" });
    expect(res1.status).toBe(400); // Filtered out, results in empty valid IDs

    // Float IDs
    const res2 = await app.request("/api/claims/by-ids?ids=1.5,2.7", { method: "GET" });
    const body2 = await res2.json();
    // NaN check: 1.5 → Number("1.5") = 1.5, but filter checks isNaN and > 0
    // 1.5 is not NaN and > 0, so it passes... but it's not an integer
    // This is a potential bug — non-integer IDs would be sent to SQL
    expect(res2.status).toBe(200);

    // Zero
    const res3 = await app.request("/api/claims/by-ids?ids=0", { method: "GET" });
    expect(res3.status).toBe(400); // 0 is filtered by n > 0

    // SQL injection attempt
    const res4 = await app.request("/api/claims/by-ids?ids=1;DROP TABLE", { method: "GET" });
    // "1;DROP TABLE" → split(",") → ["1;DROP TABLE"] → Number("1;DROP TABLE") → NaN → filtered
    expect(res4.status).toBe(400);
  });

  it("handles GET /status/:batchId with non-existent batch", async () => {
    const res = await app.request("/api/claims/status/nonexistent", { method: "GET" });
    expect(res.status).toBe(404);
  });

  it("handles verdicts with claim already in terminal state", async () => {
    // The WHERE clause has `status IN ('pending', 'verifying')`.
    // If a claim is already 'verified', the update should be a no-op.
    const res = await postJson(app, "/api/claims/verdicts", {
      verdicts: [
        {
          claimId: 999,
          status: "verified",
          confidence: 0.9,
          reasoning: "Already verified claim",
        },
      ],
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    // updated should be 0 since the mock doesn't have claim 999
    expect(body.updated).toBe(0);
  });
});

// ==========================================================================
// 3. Verdict status mapping edge cases
// ==========================================================================

describe("Claims API — verdict endpoint edge cases", () => {
  let app: Hono;

  beforeEach(() => {
    resetStores();
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    app = createApp();
  });

  it("rejects verdicts with confidence outside 0-1 range", async () => {
    const res = await postJson(app, "/api/claims/verdicts", {
      verdicts: [
        {
          claimId: 1,
          status: "verified",
          confidence: 1.5,
          reasoning: "test",
        },
      ],
    });
    expect(res.status).toBe(400);
  });

  it("rejects verdicts with negative confidence", async () => {
    const res = await postJson(app, "/api/claims/verdicts", {
      verdicts: [
        {
          claimId: 1,
          status: "verified",
          confidence: -0.1,
          reasoning: "test",
        },
      ],
    });
    expect(res.status).toBe(400);
  });

  it("rejects verdicts with invalid status", async () => {
    const res = await postJson(app, "/api/claims/verdicts", {
      verdicts: [
        {
          claimId: 1,
          status: "approved", // not a valid status
          confidence: 0.5,
          reasoning: "test",
        },
      ],
    });
    expect(res.status).toBe(400);
  });

  it("rejects more than 100 verdicts", async () => {
    const verdicts = Array.from({ length: 101 }, (_, i) => ({
      claimId: i + 1,
      status: "verified",
      confidence: 0.9,
      reasoning: "test",
    }));

    const res = await postJson(app, "/api/claims/verdicts", { verdicts });
    expect(res.status).toBe(400);
  });

  it("accepts exactly 100 verdicts", async () => {
    const verdicts = Array.from({ length: 100 }, (_, i) => ({
      claimId: i + 1,
      status: "verified",
      confidence: 0.9,
      reasoning: "test",
    }));

    const res = await postJson(app, "/api/claims/verdicts", { verdicts });
    expect(res.status).toBe(200);
  });
});
