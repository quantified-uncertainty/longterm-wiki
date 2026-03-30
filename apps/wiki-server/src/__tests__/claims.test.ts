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
// Unit tests for groupAndChunkClaims (pure logic, no DB needed)
// ==========================================================================

describe("groupAndChunkClaims", () => {
  describe("grouping by resource_id vs source_url", () => {
    it("groups claims with the same resource_id into one entry", () => {
      const claims = [
        { id: 1, resource_id: "res-abc", source_url: "https://a.com" },
        { id: 2, resource_id: "res-abc", source_url: "https://b.com" },
        { id: 3, resource_id: "res-abc", source_url: "https://c.com" },
      ];

      const result = groupAndChunkClaims(claims);

      expect(result).toHaveLength(1);
      expect(result[0].resourceId).toBe("res-abc");
      expect(result[0].claimIds).toEqual([1, 2, 3]);
    });

    it("groups claims with null resource_id by source_url", () => {
      const claims = [
        { id: 1, resource_id: null, source_url: "https://a.com/page1" },
        { id: 2, resource_id: null, source_url: "https://a.com/page1" },
        { id: 3, resource_id: null, source_url: "https://b.com/page2" },
      ];

      const result = groupAndChunkClaims(claims);

      expect(result).toHaveLength(2);

      const groupA = result.find((e) => e.resourceKey === "\0url:https://a.com/page1");
      const groupB = result.find((e) => e.resourceKey === "\0url:https://b.com/page2");

      expect(groupA).toBeDefined();
      expect(groupA!.resourceId).toBeNull();
      expect(groupA!.claimIds).toEqual([1, 2]);

      expect(groupB).toBeDefined();
      expect(groupB!.resourceId).toBeNull();
      expect(groupB!.claimIds).toEqual([3]);
    });

    it("creates separate groups for different source_urls when resource_id is null", () => {
      // This is the key regression test: claims with different sourceUrls
      // but no resourceId must get separate groups (and thus separate jobs)
      const claims = [
        { id: 10, resource_id: null, source_url: "https://arxiv.org/paper1" },
        { id: 11, resource_id: null, source_url: "https://arxiv.org/paper2" },
        { id: 12, resource_id: null, source_url: "https://nature.com/article" },
      ];

      const result = groupAndChunkClaims(claims);

      expect(result).toHaveLength(3);
      // Each claim gets its own group since each has a unique source_url
      expect(result.map((e) => e.claimIds)).toEqual([[10], [11], [12]]);
      // All should have null resourceId since there's no resource_id
      expect(result.every((e) => e.resourceId === null)).toBe(true);
    });

    it("keeps resource_id-based groups separate from url-based groups", () => {
      const claims = [
        { id: 1, resource_id: "res-1", source_url: "https://a.com" },
        { id: 2, resource_id: null, source_url: "https://a.com" },
      ];

      const result = groupAndChunkClaims(claims);

      expect(result).toHaveLength(2);

      const resGroup = result.find((e) => e.resourceId === "res-1");
      const urlGroup = result.find((e) => e.resourceId === null);

      expect(resGroup!.claimIds).toEqual([1]);
      expect(urlGroup!.claimIds).toEqual([2]);
    });

    it("separates different resource_ids into different groups", () => {
      const claims = [
        { id: 1, resource_id: "res-1", source_url: "https://a.com" },
        { id: 2, resource_id: "res-2", source_url: "https://a.com" },
        { id: 3, resource_id: "res-1", source_url: "https://b.com" },
      ];

      const result = groupAndChunkClaims(claims);

      expect(result).toHaveLength(2);
      const group1 = result.find((e) => e.resourceId === "res-1");
      const group2 = result.find((e) => e.resourceId === "res-2");
      expect(group1!.claimIds).toEqual([1, 3]);
      expect(group2!.claimIds).toEqual([2]);
    });
  });

  describe("chunk splitting", () => {
    it("does not split groups at or below maxPerJob", () => {
      const claims = Array.from({ length: MAX_CLAIMS_PER_JOB }, (_, i) => ({
        id: i + 1,
        resource_id: "res-1",
        source_url: "https://a.com",
      }));

      const result = groupAndChunkClaims(claims);

      expect(result).toHaveLength(1);
      expect(result[0].claimIds).toHaveLength(MAX_CLAIMS_PER_JOB);
    });

    it("splits a group exceeding maxPerJob into multiple chunks", () => {
      const totalClaims = MAX_CLAIMS_PER_JOB + 50; // 250 claims
      const claims = Array.from({ length: totalClaims }, (_, i) => ({
        id: i + 1,
        resource_id: "res-big",
        source_url: "https://example.com",
      }));

      const result = groupAndChunkClaims(claims);

      expect(result).toHaveLength(2);
      expect(result[0].claimIds).toHaveLength(MAX_CLAIMS_PER_JOB); // 200
      expect(result[1].claimIds).toHaveLength(50);
      // Both chunks should reference the same resource
      expect(result[0].resourceId).toBe("res-big");
      expect(result[1].resourceId).toBe("res-big");
      // Claim IDs should be contiguous and non-overlapping
      expect(result[0].claimIds[0]).toBe(1);
      expect(result[0].claimIds[MAX_CLAIMS_PER_JOB - 1]).toBe(MAX_CLAIMS_PER_JOB);
      expect(result[1].claimIds[0]).toBe(MAX_CLAIMS_PER_JOB + 1);
    });

    it("splits into 3 chunks for exactly 3x maxPerJob claims", () => {
      const totalClaims = MAX_CLAIMS_PER_JOB * 3;
      const claims = Array.from({ length: totalClaims }, (_, i) => ({
        id: i + 1,
        resource_id: "res-huge",
        source_url: "https://example.com",
      }));

      const result = groupAndChunkClaims(claims);

      expect(result).toHaveLength(3);
      for (const entry of result) {
        expect(entry.claimIds).toHaveLength(MAX_CLAIMS_PER_JOB);
        expect(entry.resourceId).toBe("res-huge");
      }
    });

    it("respects custom maxPerJob parameter", () => {
      const claims = Array.from({ length: 10 }, (_, i) => ({
        id: i + 1,
        resource_id: "res-1",
        source_url: "https://a.com",
      }));

      const result = groupAndChunkClaims(claims, 3);

      expect(result).toHaveLength(4); // 3+3+3+1
      expect(result[0].claimIds).toHaveLength(3);
      expect(result[1].claimIds).toHaveLength(3);
      expect(result[2].claimIds).toHaveLength(3);
      expect(result[3].claimIds).toHaveLength(1);
    });

    it("handles empty input", () => {
      const result = groupAndChunkClaims([]);
      expect(result).toHaveLength(0);
    });

    it("handles single claim", () => {
      const result = groupAndChunkClaims([
        { id: 1, resource_id: null, source_url: "https://a.com" },
      ]);
      expect(result).toHaveLength(1);
      expect(result[0].claimIds).toEqual([1]);
      expect(result[0].resourceId).toBeNull();
    });
  });
});

// ==========================================================================
// Integration tests for the /propose route (DB-mocked)
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

  // ---- SELECT resources WHERE id = ANY(...) (resource validation) ----
  if (q.includes("from resources") && q.includes("where")) {
    // Return all requested IDs as existing (pass validation)
    if (Array.isArray(params[0])) {
      return (params[0] as string[]).map((id) => ({ id }));
    }
    return params.map((p) => ({ id: p }));
  }

  // ---- INSERT INTO proposed_claims (batch via unnest) ----
  if (q.includes("insert into") && q.includes("proposed_claims")) {
    // The unnest INSERT passes arrays for each column.
    // params layout: [batchIds[], claimTexts[], entityIds[], targetTables[],
    //   targetFields[], proposedValues[], proposedDatas[], resourceIds[],
    //   sourceUrls[], agentEvidences[], statuses[], submittedBys[]]
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

  // ---- INSERT INTO jobs ----
  if (q.includes("insert into") && q.includes("jobs")) {
    // Tagged template params: [JSON.stringify(jobParams), priority]
    const jobParamsJson = params[0] as string;
    const row = {
      id: nextJobId++,
      type: "claim-verification",
      params: typeof jobParamsJson === "string" ? JSON.parse(jobParamsJson) : jobParamsJson,
    };
    jobStore.push(row);
    return [row];
  }

  // ---- UPDATE proposed_claims SET verification_job_id ----
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

  // ---- UPDATE proposed_claims (batch verdict via unnest) ----
  if (q.includes("update") && q.includes("proposed_claims") && q.includes("unnest")) {
    // params: [claimIds[], statuses[], confidences[], reasonings[], extractedValues[], checkerModels[]]
    const claimIds = params[0] as number[];
    return claimIds.map((id) => ({ id }));
  }

  // ---- entity_ids (for health check) ----
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

describe("Claims API — POST /api/claims/propose", () => {
  let app: Hono;

  beforeEach(() => {
    resetStores();
    delete process.env.LONGTERMWIKI_SERVER_API_KEY;
    app = createApp();
  });

  it("creates separate jobs for claims with different sourceUrls and no resourceId", async () => {
    const res = await postJson(app, "/api/claims/propose", {
      targetTable: "facts",
      claims: [
        { claimText: "Claim about paper A", sourceUrl: "https://arxiv.org/paper-a" },
        { claimText: "Claim about paper B", sourceUrl: "https://arxiv.org/paper-b" },
        { claimText: "Another about paper A", sourceUrl: "https://arxiv.org/paper-a" },
      ],
    });

    expect(res.status).toBe(201);
    const body = await res.json();

    // 2 distinct source URLs → 2 jobs
    expect(body.jobCount).toBe(2);
    expect(body.claims).toHaveLength(3);

    // Verify the two claims with the same sourceUrl share a job ID
    const jobIds = body.claims.map((c: { verificationJobId: number }) => c.verificationJobId);
    // Claims 0 and 2 (both paper-a) should have the same jobId
    expect(jobIds[0]).toBe(jobIds[2]);
    // Claim 1 (paper-b) should have a different jobId
    expect(jobIds[1]).not.toBe(jobIds[0]);
  });

  it("assigns all claims to jobs for a single resource", async () => {
    // Note: API limits claims to 100 per request (Zod schema).
    // Chunk-splitting for >200 claims is tested in the unit tests above.
    const claimCount = 80;
    const claims = Array.from({ length: claimCount }, (_, i) => ({
      claimText: `Claim number ${i + 1}`,
      sourceUrl: "https://example.com/big-page",
      resourceId: "res-big",
    }));

    const res = await postJson(app, "/api/claims/propose", {
      targetTable: "facts",
      claims,
    });

    expect(res.status).toBe(201);
    const body = await res.json();

    // 80 claims for 1 resource → 1 job (under MAX_CLAIMS_PER_JOB=200)
    expect(body.jobCount).toBe(1);
    expect(body.claims).toHaveLength(claimCount);

    // Verify every claim has a job ID assigned
    for (const claim of body.claims) {
      expect(claim.verificationJobId).not.toBeNull();
    }

    // Check the underlying job params have correct chunk size
    expect(jobStore).toHaveLength(1);
    const jobParams0 = jobStore[0].params as { claimIds: number[] };
    expect(jobParams0.claimIds).toHaveLength(claimCount);
  });

  it("estimatedVerificationTime is based on claim count, not job count", async () => {
    // Use 3 distinct sourceUrls to create 3 jobs with a small number of claims
    const claims = [
      { claimText: "Claim A1", sourceUrl: "https://example.com/page-a" },
      { claimText: "Claim A2", sourceUrl: "https://example.com/page-a" },
      { claimText: "Claim B1", sourceUrl: "https://example.com/page-b" },
      { claimText: "Claim C1", sourceUrl: "https://example.com/page-c" },
    ];

    const res = await postJson(app, "/api/claims/propose", {
      targetTable: "facts",
      claims,
    });

    expect(res.status).toBe(201);
    const body = await res.json();

    // 3 distinct sourceUrls → 3 jobs, but 4 claims total
    expect(body.jobCount).toBe(3);
    expect(body.claims).toHaveLength(4);

    // estimatedVerificationTime should be claimCount * SECONDS_PER_CLAIM (4 * 3 = 12)
    // NOT jobCount * SECONDS_PER_CLAIM (3 * 3 = 9)
    expect(body.estimatedVerificationTime).toBe(4 * SECONDS_PER_CLAIM_ESTIMATE);
    expect(body.estimatedVerificationTime).not.toBe(body.jobCount * SECONDS_PER_CLAIM_ESTIMATE);
  });

  it("returns 201 with correct structure for a basic propose request", async () => {
    const res = await postJson(app, "/api/claims/propose", {
      targetTable: "facts",
      claims: [
        { claimText: "OpenAI was founded in 2015", sourceUrl: "https://en.wikipedia.org/wiki/OpenAI" },
      ],
    });

    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body.batchId).toBeDefined();
    expect(typeof body.batchId).toBe("string");
    expect(body.batchId.length).toBe(10);
    expect(body.claims).toHaveLength(1);
    expect(body.claims[0].status).toBe("pending");
    expect(body.claims[0].verificationJobId).toBeDefined();
    expect(body.jobCount).toBe(1);
    expect(body.estimatedVerificationTime).toBe(SECONDS_PER_CLAIM_ESTIMATE);
  });

  it("rejects empty claims array", async () => {
    const res = await postJson(app, "/api/claims/propose", {
      targetTable: "facts",
      claims: [],
    });

    expect(res.status).toBe(400);
  });

  it("rejects missing targetTable", async () => {
    const res = await postJson(app, "/api/claims/propose", {
      claims: [{ claimText: "test", sourceUrl: "https://example.com" }],
    });

    expect(res.status).toBe(400);
  });
});
