import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the ingester modules and the extract/sync paths so the test runs
// without network or LLM calls.
vi.mock("./ingesters/uk-aisi-sitemap.ts", () => ({
  ingestUkAisi: vi.fn(),
}));
vi.mock("./ingesters/metr-rss.ts", () => ({
  ingestMetr: vi.fn(),
}));
vi.mock("./ingesters/apollo-research.ts", () => ({
  ingestApollo: vi.fn(),
}));
vi.mock("./ingesters/caisi-blog.ts", () => ({
  ingestCaisi: vi.fn(),
}));
vi.mock("./extract-eval-report.ts", () => ({
  extractEvalReport: vi.fn(),
  toSyncItem: vi.fn((extract: unknown, ctx: { id: string; reportUrl: string }) => ({
    id: ctx.id,
    reportUrl: ctx.reportUrl,
  })),
  EXTRACTOR_VERSION: "test@1.0",
}));
vi.mock("./span-verify.ts", () => ({
  verifyExtractedReport: vi.fn(() => ({
    verifiedReport: { modelsNamed: [], excerpts: {} },
    verdicts: {},
    droppedFields: [],
    ungroundedFields: [],
    confidenceMap: {},
  })),
  spanVerifyToInlineSourcing: vi.fn(() => null),
  SPAN_VERIFY_CHECKER: "span-verify-v1",
}));
vi.mock("../lib/wiki-server/third-party-evaluations.ts", () => ({
  syncThirdPartyEvaluations: vi.fn(),
}));
vi.mock("../lib/ai-model-resolver.ts", () => ({
  resolveAiModel: vi.fn(() => []),
}));

import { ingestUkAisi } from "./ingesters/uk-aisi-sitemap.ts";
import { ingestMetr } from "./ingesters/metr-rss.ts";
import { extractEvalReport, toSyncItem } from "./extract-eval-report.ts";
import { spanVerifyToInlineSourcing } from "./span-verify.ts";
import { syncThirdPartyEvaluations } from "../lib/wiki-server/third-party-evaluations.ts";
import { backfillEvaluator } from "./backfill.ts";

const makeCandidates = (n: number, prefix = "https://example.com/r") =>
  Array.from({ length: n }, (_, i) => ({
    url: `${prefix}${i}`,
    title: `Report ${i}`,
    publishedDate: null,
    sourceSystem: "sitemap" as const,
  }));

const okExtract = {
  report: {},
  sourceText: "abc",
  sourceFormat: "html",
  sourceHash: "deadbeef",
  waybackSnapshotUrl: null,
  usage: { input_tokens: 10, output_tokens: 5 },
  extractorVersion: "test@1.0",
  extractionModel: "haiku",
  extractedAt: "2026-04-25T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("backfillEvaluator", () => {
  it("rejects unknown evaluator names", async () => {
    await expect(
      backfillEvaluator({
        evaluator: "orange-aisi",
        evaluatorOrgId: "sid_test12345",
        dryRun: true,
      }),
    ).rejects.toThrow(/Unknown evaluator/);
  });

  it("dispatches uk-aisi → ingestUkAisi (passing --since)", async () => {
    vi.mocked(ingestUkAisi).mockResolvedValue({
      evaluator: "uk-aisi",
      candidates: [],
      errors: [],
    });
    await backfillEvaluator({
      evaluator: "uk-aisi",
      evaluatorOrgId: "sid_aX0jkoaekQ",
      since: "2025-01-01",
      dryRun: true,
    });
    expect(vi.mocked(ingestUkAisi)).toHaveBeenCalledWith({ sinceDate: "2025-01-01" });
  });

  it("dispatches metr → ingestMetr", async () => {
    vi.mocked(ingestMetr).mockResolvedValue({
      evaluator: "metr",
      candidates: [],
      errors: [],
    });
    await backfillEvaluator({
      evaluator: "metr",
      evaluatorOrgId: "sid_rQEkFJxS5w",
      dryRun: true,
    });
    expect(vi.mocked(ingestMetr)).toHaveBeenCalledOnce();
  });

  it("respects --limit by capping candidates passed to extract", async () => {
    vi.mocked(ingestUkAisi).mockResolvedValue({
      evaluator: "uk-aisi",
      candidates: makeCandidates(20),
      errors: [],
    });
    vi.mocked(extractEvalReport).mockResolvedValue(okExtract as never);

    const result = await backfillEvaluator({
      evaluator: "uk-aisi",
      evaluatorOrgId: "sid_aX0jkoaekQ",
      limit: 3,
      dryRun: true,
    });

    expect(result.candidates).toBe(3);
    expect(result.extracted).toBe(3);
    expect(vi.mocked(extractEvalReport)).toHaveBeenCalledTimes(3);
  });

  it("dryRun=true skips sync (no /sync POST)", async () => {
    vi.mocked(ingestUkAisi).mockResolvedValue({
      evaluator: "uk-aisi",
      candidates: makeCandidates(2),
      errors: [],
    });
    vi.mocked(extractEvalReport).mockResolvedValue(okExtract as never);

    const result = await backfillEvaluator({
      evaluator: "uk-aisi",
      evaluatorOrgId: "sid_aX0jkoaekQ",
      dryRun: true,
    });

    expect(result.extracted).toBe(2);
    expect(result.synced).toBe(0);
    expect(vi.mocked(syncThirdPartyEvaluations)).not.toHaveBeenCalled();
  });

  it("posts to /sync when dryRun is false, batched by batchSize", async () => {
    vi.mocked(ingestUkAisi).mockResolvedValue({
      evaluator: "uk-aisi",
      candidates: makeCandidates(7),
      errors: [],
    });
    vi.mocked(extractEvalReport).mockResolvedValue(okExtract as never);
    vi.mocked(syncThirdPartyEvaluations).mockResolvedValue({
      ok: true,
      data: { upserted: 0, verdictsWritten: 0, claimsLinked: 0 },
    } as never);

    const result = await backfillEvaluator({
      evaluator: "uk-aisi",
      evaluatorOrgId: "sid_aX0jkoaekQ",
      batchSize: 3,
    });

    expect(result.extracted).toBe(7);
    expect(result.synced).toBe(7);
    // 7 items / batch of 3 = 3 calls (3, 3, 1)
    expect(vi.mocked(syncThirdPartyEvaluations)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(syncThirdPartyEvaluations).mock.calls[0][0]).toHaveLength(3);
    expect(vi.mocked(syncThirdPartyEvaluations).mock.calls[2][0]).toHaveLength(1);
  });

  it("collects extract failures without aborting the run", async () => {
    vi.mocked(ingestUkAisi).mockResolvedValue({
      evaluator: "uk-aisi",
      candidates: makeCandidates(3),
      errors: [],
    });
    vi.mocked(extractEvalReport)
      .mockResolvedValueOnce(okExtract as never)
      .mockRejectedValueOnce(new Error("LLM 502"))
      .mockResolvedValueOnce(okExtract as never);

    const result = await backfillEvaluator({
      evaluator: "uk-aisi",
      evaluatorOrgId: "sid_aX0jkoaekQ",
      dryRun: true,
    });

    expect(result.candidates).toBe(3);
    expect(result.extracted).toBe(2);
    expect(result.extractFailures).toHaveLength(1);
    expect(result.extractFailures[0].error).toContain("LLM 502");
  });

  it("collects sync failures without aborting later batches", async () => {
    vi.mocked(ingestUkAisi).mockResolvedValue({
      evaluator: "uk-aisi",
      candidates: makeCandidates(4),
      errors: [],
    });
    vi.mocked(extractEvalReport).mockResolvedValue(okExtract as never);
    vi.mocked(syncThirdPartyEvaluations)
      .mockResolvedValueOnce({
        ok: false,
        error: "server_error",
        message: "boom",
      } as never)
      .mockResolvedValueOnce({
        ok: true,
        data: { upserted: 0, verdictsWritten: 0, claimsLinked: 0 },
      } as never);

    const result = await backfillEvaluator({
      evaluator: "uk-aisi",
      evaluatorOrgId: "sid_aX0jkoaekQ",
      batchSize: 2,
    });

    expect(result.synced).toBe(2); // only the 2nd batch succeeded
    expect(result.syncFailures).toHaveLength(1);
    expect(result.syncFailures[0].error).toContain("boom");
  });

  it("handles zero-candidates input cleanly (no extract/sync calls)", async () => {
    vi.mocked(ingestUkAisi).mockResolvedValue({
      evaluator: "uk-aisi",
      candidates: [],
      errors: [],
    });

    const result = await backfillEvaluator({
      evaluator: "uk-aisi",
      evaluatorOrgId: "sid_aX0jkoaekQ",
    });

    expect(result.candidates).toBe(0);
    expect(result.extracted).toBe(0);
    expect(result.synced).toBe(0);
    expect(vi.mocked(extractEvalReport)).not.toHaveBeenCalled();
    expect(vi.mocked(syncThirdPartyEvaluations)).not.toHaveBeenCalled();
  });

  it("handles exact batch-size boundary (no spurious empty trailing batch)", async () => {
    vi.mocked(ingestUkAisi).mockResolvedValue({
      evaluator: "uk-aisi",
      candidates: makeCandidates(6),
      errors: [],
    });
    vi.mocked(extractEvalReport).mockResolvedValue(okExtract as never);
    vi.mocked(syncThirdPartyEvaluations).mockResolvedValue({
      ok: true,
      data: { upserted: 0, verdictsWritten: 0, claimsLinked: 0 },
    } as never);

    const result = await backfillEvaluator({
      evaluator: "uk-aisi",
      evaluatorOrgId: "sid_aX0jkoaekQ",
      batchSize: 3,
    });

    expect(result.synced).toBe(6);
    // 6 / 3 = 2 batches exactly — no third call with empty array
    expect(vi.mocked(syncThirdPartyEvaluations)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(syncThirdPartyEvaluations).mock.calls[0][0]).toHaveLength(3);
    expect(vi.mocked(syncThirdPartyEvaluations).mock.calls[1][0]).toHaveLength(3);
  });

  it("handles multiple consecutive sync-batch failures", async () => {
    vi.mocked(ingestUkAisi).mockResolvedValue({
      evaluator: "uk-aisi",
      candidates: makeCandidates(6),
      errors: [],
    });
    vi.mocked(extractEvalReport).mockResolvedValue(okExtract as never);
    vi.mocked(syncThirdPartyEvaluations).mockResolvedValue({
      ok: false,
      error: "unavailable",
      message: "wiki-server down",
    } as never);

    const result = await backfillEvaluator({
      evaluator: "uk-aisi",
      evaluatorOrgId: "sid_aX0jkoaekQ",
      batchSize: 2,
    });

    expect(result.synced).toBe(0);
    expect(result.syncFailures).toHaveLength(3);
    expect(result.syncFailures.map((f) => f.batchIndex)).toEqual([0, 1, 2]);
  });

  it("serial concurrency=1 still works", async () => {
    vi.mocked(ingestUkAisi).mockResolvedValue({
      evaluator: "uk-aisi",
      candidates: makeCandidates(3),
      errors: [],
    });
    vi.mocked(extractEvalReport).mockResolvedValue(okExtract as never);

    const result = await backfillEvaluator({
      evaluator: "uk-aisi",
      evaluatorOrgId: "sid_aX0jkoaekQ",
      concurrency: 1,
      dryRun: true,
    });

    expect(result.extracted).toBe(3);
  });

  it("emits onProgress events for extract and sync", async () => {
    vi.mocked(ingestUkAisi).mockResolvedValue({
      evaluator: "uk-aisi",
      candidates: makeCandidates(2),
      errors: [],
    });
    vi.mocked(extractEvalReport)
      .mockResolvedValueOnce(okExtract as never)
      .mockRejectedValueOnce(new Error("nope"));
    vi.mocked(syncThirdPartyEvaluations).mockResolvedValue({
      ok: true,
      data: { upserted: 0, verdictsWritten: 0, claimsLinked: 0 },
    } as never);

    const events: string[] = [];
    await backfillEvaluator({
      evaluator: "uk-aisi",
      evaluatorOrgId: "sid_aX0jkoaekQ",
      onProgress: (e) => events.push(e.kind),
    });

    expect(events).toContain("extracted");
    expect(events).toContain("extract-error");
    expect(events).toContain("synced");
  });

  it("populates sourcing block on each sync item via span-verify (QUA-727)", async () => {
    vi.mocked(ingestUkAisi).mockResolvedValue({
      evaluator: "uk-aisi",
      candidates: makeCandidates(2),
      errors: [],
    });
    vi.mocked(extractEvalReport).mockResolvedValue(okExtract as never);
    vi.mocked(spanVerifyToInlineSourcing).mockReturnValue({
      verdict: "confirmed",
      confidence: 0.95,
      checkedBy: "span-verify-v1",
      checkedAt: "2026-04-25T00:00:00.000Z",
      sourceContentHash: "deadbeef",
      evidence: "Pre-deployment evaluation excerpt",
    });
    vi.mocked(syncThirdPartyEvaluations).mockResolvedValue({
      ok: true,
      data: { upserted: 0, verdictsWritten: 0, claimsLinked: 0 },
    } as never);

    await backfillEvaluator({
      evaluator: "uk-aisi",
      evaluatorOrgId: "sid_aX0jkoaekQ",
    });

    // span-verify helper was called once per candidate, with the source hash
    // threaded through from the extract.
    expect(vi.mocked(spanVerifyToInlineSourcing)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(spanVerifyToInlineSourcing).mock.calls[0][1]).toMatchObject({
      sourceContentHash: "deadbeef",
    });

    // toSyncItem received the verdict via opts.sourcing
    const toSyncOpts = vi.mocked(toSyncItem).mock.calls[0][1];
    expect(toSyncOpts.sourcing).toMatchObject({
      verdict: "confirmed",
      checkedBy: "span-verify-v1",
    });
  });

  it("omits sourcing block when span-verify returns null (no checkable fields)", async () => {
    vi.mocked(ingestUkAisi).mockResolvedValue({
      evaluator: "uk-aisi",
      candidates: makeCandidates(1),
      errors: [],
    });
    vi.mocked(extractEvalReport).mockResolvedValue(okExtract as never);
    vi.mocked(spanVerifyToInlineSourcing).mockReturnValue(null);
    vi.mocked(syncThirdPartyEvaluations).mockResolvedValue({
      ok: true,
      data: { upserted: 0, verdictsWritten: 0, claimsLinked: 0 },
    } as never);

    await backfillEvaluator({
      evaluator: "uk-aisi",
      evaluatorOrgId: "sid_aX0jkoaekQ",
    });

    const toSyncOpts = vi.mocked(toSyncItem).mock.calls[0][1];
    expect(toSyncOpts.sourcing).toBeNull();
  });
});
