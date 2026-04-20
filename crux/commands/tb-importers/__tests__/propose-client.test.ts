import { describe, it, expect } from "vitest";
import {
  validateProposal,
  submitProposal,
  submitBatch,
} from "../propose-client.ts";
import type { EnrichmentProposal } from "../types.ts";

const VALID: EnrichmentProposal = {
  tier: "T1",
  source: "sec-edgar:0001234567-25-000001",
  sourceUrl: "https://www.sec.gov/Archives/x.xml",
  responseHash: "abc123",
  recordType: "funding-round",
  record: { name: "Series A" },
};

describe("validateProposal", () => {
  it("returns null on a fully-valid proposal", () => {
    expect(validateProposal(VALID)).toBeNull();
  });

  it("rejects non-T1 tiers", () => {
    expect(validateProposal({ ...VALID, tier: "T2" })).toMatch(/T1 importers must emit tier=T1/);
  });

  it("rejects missing source/url/hash", () => {
    expect(validateProposal({ ...VALID, source: "" })).toMatch(/missing required/);
    expect(validateProposal({ ...VALID, sourceUrl: "" })).toMatch(/missing required/);
    expect(validateProposal({ ...VALID, responseHash: "" })).toMatch(/missing required/);
  });

  it("rejects (source, recordType) not on the T1 allowlist", () => {
    const proposal: EnrichmentProposal = {
      ...VALID,
      source: "wikipedia:anthropic",
      recordType: "funding-round",
    };
    expect(validateProposal(proposal)).toMatch(/not on T1 authority allowlist/);
  });

  it("rejects mismatched (source, recordType) on the allowlist", () => {
    const proposal: EnrichmentProposal = {
      ...VALID,
      source: "sec-edgar:abc",
      recordType: "personnel",
    };
    expect(validateProposal(proposal)).toMatch(/not on T1 authority allowlist/);
  });
});

describe("submitProposal", () => {
  it("returns rejected on validation failure", async () => {
    const r = await submitProposal({ ...VALID, tier: "T2" });
    expect(r.status).toBe("rejected");
    expect(r.reason).toMatch(/T1/);
  });

  it("returns pending in dry-run mode (default)", async () => {
    const r = await submitProposal(VALID);
    expect(r.status).toBe("pending");
    expect(r.reason).toBe("dry-run");
  });

  it("returns pending with QUA-632 reason when --submit and endpoint not yet built", async () => {
    const r = await submitProposal(VALID, { submit: true });
    expect(r.status).toBe("pending");
    expect(r.reason).toMatch(/QUA-632/);
  });

  it("skipAllowlistCheck bypasses validation", async () => {
    const proposal: EnrichmentProposal = {
      ...VALID,
      source: "wikipedia:x",
    };
    const r = await submitProposal(proposal, { skipAllowlistCheck: true });
    expect(r.status).toBe("pending");
    expect(r.reason).toBe("dry-run");
  });
});

describe("submitBatch", () => {
  it("returns one result per input, preserving order", async () => {
    const proposals: EnrichmentProposal[] = [
      VALID,
      { ...VALID, tier: "T3" },
      { ...VALID, source: "github-contributors:anthropic:alice", recordType: "personnel" },
    ];
    const results = await submitBatch(proposals);
    expect(results).toHaveLength(3);
    expect(results[0].status).toBe("pending");
    expect(results[1].status).toBe("rejected");
    expect(results[2].status).toBe("pending");
  });

  it("returns empty array for empty input", async () => {
    expect(await submitBatch([])).toEqual([]);
  });
});
