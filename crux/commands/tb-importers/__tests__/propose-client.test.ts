import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  validateProposal,
  submitProposal,
  submitBatch,
  deriveRecordId,
  buildProposeRequest,
} from "../propose-client.ts";
import type { EnrichmentProposal } from "../types.ts";

const HEX64 =
  "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

const VALID: EnrichmentProposal = {
  tier: "T1",
  source: "sec-edgar:0001234567-25-000001",
  sourceUrl: "https://www.sec.gov/Archives/x.xml",
  responseHash: HEX64,
  recordType: "funding-rounds",
  record: { name: "Series A" },
  entityRefs: { organization: "anthropic" },
};

describe("validateProposal", () => {
  it("returns null on a fully-valid proposal", () => {
    expect(validateProposal(VALID)).toBeNull();
  });

  it("rejects non-T1 tiers", () => {
    expect(validateProposal({ ...VALID, tier: "T2" })).toMatch(
      /T1 importers must emit tier=T1/
    );
  });

  it("rejects missing source/url/hash", () => {
    expect(validateProposal({ ...VALID, source: "" })).toMatch(
      /missing required/
    );
    expect(validateProposal({ ...VALID, sourceUrl: "" })).toMatch(
      /missing required/
    );
    expect(validateProposal({ ...VALID, responseHash: "" })).toMatch(
      /missing required/
    );
  });

  it("rejects (source, recordType) not on the T1 allowlist", () => {
    const proposal: EnrichmentProposal = {
      ...VALID,
      source: "wikipedia:anthropic",
      recordType: "funding-rounds",
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

describe("deriveRecordId", () => {
  it("returns the first 10 chars of a hex response hash", () => {
    expect(deriveRecordId(HEX64)).toBe("abcdef0123");
  });

  it("rejects a non-hex hash", () => {
    expect(() => deriveRecordId("not-a-hash")).toThrow(/hex/);
  });

  it("rejects a hash shorter than 10 chars", () => {
    expect(() => deriveRecordId("abc")).toThrow(/hex/);
  });

  it("is deterministic — same hash → same id", () => {
    expect(deriveRecordId(HEX64)).toBe(deriveRecordId(HEX64));
  });
});

describe("buildProposeRequest", () => {
  it("mints id from responseHash[:10] and preserves tier/recordType/sourceUrl", () => {
    const req = buildProposeRequest(VALID);
    expect(req.tier).toBe("T1");
    expect(req.recordType).toBe("funding-rounds");
    expect(req.sourceUrl).toBe(VALID.sourceUrl);
    expect(req.sourceContentHash).toBe(VALID.responseHash);
    expect(req.row.id).toBe("abcdef0123");
  });

  it("maps entityRefs.organization → row.companyId for funding-rounds", () => {
    const req = buildProposeRequest(VALID);
    expect(req.row.companyId).toBe("anthropic");
  });

  it("maps entityRefs to personId + organizationId for personnel", () => {
    const proposal: EnrichmentProposal = {
      ...VALID,
      source: "github-contributors:anthropic:alice",
      recordType: "personnel",
      record: { role: "contributor", roleType: "career" },
      entityRefs: { organization: "anthropic", person: "alice" },
    };
    const req = buildProposeRequest(proposal);
    expect(req.row.organizationId).toBe("anthropic");
    expect(req.row.personId).toBe("alice");
  });

  it("maps entityRefs to modelId + benchmarkId for benchmark-results", () => {
    const proposal: EnrichmentProposal = {
      ...VALID,
      source: "hf-leaderboard:claude-3-5-sonnet:IFEval",
      recordType: "benchmark-results",
      record: { score: 75.2, unit: "%" },
      entityRefs: { model: "claude-3-5-sonnet", benchmark: "ifeval" },
    };
    const req = buildProposeRequest(proposal);
    expect(req.row.modelId).toBe("claude-3-5-sonnet");
    expect(req.row.benchmarkId).toBe("ifeval");
  });

  it("does not overwrite existing FK columns in the record", () => {
    const proposal: EnrichmentProposal = {
      ...VALID,
      record: { name: "Series A", companyId: "pre-filled-id" },
      entityRefs: { organization: "anthropic" },
    };
    const req = buildProposeRequest(proposal);
    expect(req.row.companyId).toBe("pre-filled-id");
  });

  it("forces row.id from the derived hash, overwriting any id in the record", () => {
    const proposal: EnrichmentProposal = {
      ...VALID,
      record: { name: "Series A", id: "caller-picked-id" },
    };
    const req = buildProposeRequest(proposal);
    expect(req.row.id).toBe("abcdef0123");
  });

  it("includes runId when provided", () => {
    const req = buildProposeRequest(VALID, { runId: "run-123" });
    expect(req.runId).toBe("run-123");
  });

  it("omits runId when not provided", () => {
    const req = buildProposeRequest(VALID);
    expect("runId" in req).toBe(false);
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

describe("submitProposal (submit=true) — network path", () => {
  // Mock global fetch to intercept the POST without requiring a real server.
  const fetchMock = vi.fn();
  const origFetch = globalThis.fetch;
  const origEnvUrl = process.env.LONGTERMWIKI_SERVER_URL;
  const origEnvProdUrl = process.env.PROD_LONGTERMWIKI_SERVER_URL;
  const origEnvKey = process.env.LONGTERMWIKI_SERVER_API_KEY;
  const origWikiEnv = process.env.WIKI_SERVER_ENV;

  beforeEach(() => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    // Force the local prefix so WIKI_SERVER_ENV auto-detection in a slot
    // doesn't flip us to the prod prefix during the test.
    process.env.WIKI_SERVER_ENV = "local";
    process.env.LONGTERMWIKI_SERVER_URL = "http://test.invalid";
    process.env.LONGTERMWIKI_SERVER_API_KEY = "test-key";
  });

  function restoreEnv(key: string, orig: string | undefined): void {
    if (orig === undefined) delete process.env[key];
    else process.env[key] = orig;
  }

  afterEach(() => {
    globalThis.fetch = origFetch;
    restoreEnv("WIKI_SERVER_ENV", origWikiEnv);
    restoreEnv("LONGTERMWIKI_SERVER_URL", origEnvUrl);
    restoreEnv("PROD_LONGTERMWIKI_SERVER_URL", origEnvProdUrl);
    restoreEnv("LONGTERMWIKI_SERVER_API_KEY", origEnvKey);
  });

  function mockResponse(status: number, body: unknown): void {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(body), { status })
    );
  }

  it("POSTs the translated payload to /api/enrichment/propose", async () => {
    mockResponse(200, {
      status: "accepted",
      tier: "T1",
      recordId: "abcdef0123",
      verdict: "confirmed",
    });
    const r = await submitProposal(VALID, { submit: true });
    expect(r.status).toBe("accepted");
    expect(r.recordId).toBe("abcdef0123");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe("http://test.invalid/api/enrichment/propose");
    const init = call[1] as RequestInit;
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.tier).toBe("T1");
    expect(body.recordType).toBe("funding-rounds");
    expect(body.sourceUrl).toBe(VALID.sourceUrl);
    expect(body.sourceContentHash).toBe(VALID.responseHash);
    expect(body.row.id).toBe("abcdef0123");
    expect(body.row.companyId).toBe("anthropic");
  });

  it("maps server 'rejected' response to ProposeResult.rejected with the reason", async () => {
    mockResponse(400, {
      status: "rejected",
      tier: "T1",
      rejectionReason: "No T1 authority matches",
    });
    const r = await submitProposal(VALID, { submit: true });
    expect(r.status).toBe("rejected");
    expect(r.reason).toMatch(/No T1 authority matches/);
  });

  it("falls back to pending on transport failure", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const r = await submitProposal(VALID, { submit: true });
    expect(r.status).toBe("pending");
    expect(r.reason).toMatch(/unavailable/);
  });

  it("includes runId in the POST body when provided", async () => {
    mockResponse(200, { status: "accepted", tier: "T1", recordId: "abcdef0123" });
    await submitProposal(VALID, { submit: true, runId: "import-2026-04-23" });
    const body = JSON.parse(
      fetchMock.mock.calls[0][1].body as string
    );
    expect(body.runId).toBe("import-2026-04-23");
  });
});

describe("submitBatch", () => {
  it("returns one result per input, preserving order", async () => {
    const proposals: EnrichmentProposal[] = [
      VALID,
      { ...VALID, tier: "T3" },
      {
        ...VALID,
        source: "github-contributors:anthropic:alice",
        recordType: "personnel",
      },
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
