/**
 * Phase 2 canary dual-write tests (QUA-958, parent QUA-943).
 *
 * Drives `dualWriteStakeholders` end-to-end with a mocked `apiRequest`
 * (no live wiki-server). Three fixtures map to the spec acceptance:
 *   1. deliberate `position: reform` payload → dropped at conversion (legacy
 *      enum value — not an abort signal because the converter strips it
 *      before the POST). The acceptance "deliberate-failure → abort" relies
 *      on the SERVER returning code:"zod" — we simulate that explicitly.
 *   2. valid payload → committed + ops-ticket comment NOT posted.
 *   3. fk-missing payload → partial commit + followup_actions populated +
 *      ops-ticket comment posted (partial_failure routes to ops).
 *
 * Mocking strategy: `vi.mock('../../wiki-server/client.ts')` so the typed
 * client builds normally but the network leaf returns canned responses.
 * The pipeline-runs lifecycle is provided in-memory (no fetch).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyVerdictsToPolicy, type VerifiedVerdict } from "../apply-verdicts.ts";
import type { PolicyEntity } from "../gap-analyzer.ts";
import {
  dualWriteStakeholders,
  DualWriteZodAbort,
  DualWriteHttpError,
} from "../dual-write-stakeholders.ts";
import type { PipelineRunCtx } from "../../pipeline-runs/lifecycle.ts";

// We mock `client.ts` so `syncPolicyStakeholdersBestEffort` receives our
// scripted response. The route module is real — exercising the same
// composition as production.
vi.mock("../../wiki-server/client.ts", () => {
  const fn = vi.fn();
  return {
    apiRequest: fn,
    __mockApiRequest: fn,
  };
});

// Re-import the mock fn after mock is installed.
import * as clientModule from "../../wiki-server/client.ts";
const apiRequestMock = (clientModule as unknown as { __mockApiRequest: ReturnType<typeof vi.fn> }).__mockApiRequest;

const POLICY_ID = "sid_TestPolicy01";

function basePolicy(over: Partial<PolicyEntity> = {}): PolicyEntity {
  return {
    id: "test-policy",
    type: "policy",
    stableId: POLICY_ID,
    title: "Test Policy",
    stakeholders: [],
    ...over,
  };
}

function v(over: Partial<VerifiedVerdict>): VerifiedVerdict {
  return {
    targetField: "stakeholder.aclu",
    claimText: "ACLU opposes the bill on civil liberties grounds",
    extractedValue: null,
    proposedValue: null,
    sourceUrl: "https://aclu.org/statement",
    status: "verified",
    displayHint: "ACLU",
    position: "oppose",
    positionConfidence: 0.9,
    ...over,
  };
}

function makeCtx(overrides: Partial<PipelineRunCtx> = {}): PipelineRunCtx & {
  followups: Array<Record<string, unknown>>;
  statuses: Array<{ status: string; info?: { reason?: string; errorCode?: string } }>;
} {
  const followups: Array<Record<string, unknown>> = [];
  const statuses: Array<{ status: string; info?: { reason?: string; errorCode?: string } }> = [];
  return {
    runId: "test-run",
    offline: false,
    markStatus: (status, info) => {
      statuses.push({ status, info });
    },
    markFollowup: (action) => {
      followups.push(action);
    },
    followups,
    statuses,
    ...overrides,
  };
}

beforeEach(() => {
  apiRequestMock.mockReset();
});

// ---------------------------------------------------------------------------
// Fixture 2: VALID payload → committed + ops-ticket comment NOT posted
// ---------------------------------------------------------------------------

describe("dualWriteStakeholders — valid payload", () => {
  it("commits, posts no ops comment, and does not call markStatus", async () => {
    const apply = applyVerdictsToPolicy(basePolicy(), [
      v({ targetField: "stakeholder.aclu", displayHint: "ACLU" }),
    ]);
    apiRequestMock.mockResolvedValueOnce({
      ok: true,
      data: {
        committed: ["abc1234567"],
        rejected: [],
        verdictsWritten: 0,
        claimsLinked: 0,
      },
    });
    const ctx = makeCtx();
    const postComment = vi.fn(async () => {});

    const result = await dualWriteStakeholders({
      ctx,
      policyEntityId: POLICY_ID,
      applyResult: apply,
      iter: 1,
      opsTicket: "QUA-OPS",
      postComment,
    });

    expect(result.ok).toBe(true);
    expect(result.committedIds).toEqual(["abc1234567"]);
    expect(result.rejected).toEqual([]);
    expect(postComment).not.toHaveBeenCalled();
    expect(ctx.statuses).toEqual([]); // committed = withPipelineRun default
    expect(ctx.followups).toEqual([]);

    // Verify the POST hit best-effort mode.
    expect(apiRequestMock).toHaveBeenCalledTimes(1);
    const [method, url] = apiRequestMock.mock.calls[0];
    expect(method).toBe("POST");
    expect(url).toMatch(/\?mode=best_effort/);
  });

  it("returns 'no-stakeholder-changes' without POSTing when conversion produces zero items", async () => {
    // Apply with no stakeholder verdicts → zero items in payload → no POST.
    const apply = applyVerdictsToPolicy(basePolicy(), [
      v({ targetField: "scalar.description", claimText: "A description" }),
    ]);
    const ctx = makeCtx();
    const postComment = vi.fn(async () => {});
    const result = await dualWriteStakeholders({
      ctx,
      policyEntityId: POLICY_ID,
      applyResult: apply,
      iter: 1,
      opsTicket: "QUA-OPS",
      postComment,
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("no-stakeholder-changes");
    expect(apiRequestMock).not.toHaveBeenCalled();
    expect(postComment).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Fixture 1: deliberate position=reform → ABORT
// ---------------------------------------------------------------------------
//
// The converter strips `position: reform` (legacy YAML-only enum). To
// simulate the ABORT path we use a verdict that the converter accepts but
// the SERVER would reject — we mock the server response to include a
// `code: "zod"` rejection. This is the realistic shape the server emits when
// a payload field is structurally wrong (e.g. a future field added to YAML
// before the schema).

describe("dualWriteStakeholders — deliberate ABORT (zod)", () => {
  it("throws DualWriteZodAbort, marks status=aborted, and posts ops comment", async () => {
    const apply = applyVerdictsToPolicy(basePolicy(), [
      v({ targetField: "stakeholder.aclu", displayHint: "ACLU" }),
    ]);
    apiRequestMock.mockResolvedValueOnce({
      ok: true,
      data: {
        committed: [],
        rejected: [
          {
            idx: 0,
            code: "zod",
            message: "Invalid input — `position` is required",
            field: "items[0].position",
          },
        ],
        verdictsWritten: 0,
        claimsLinked: 0,
      },
    });
    const ctx = makeCtx();
    const postComment = vi.fn(async () => {});

    let thrown: unknown;
    try {
      await dualWriteStakeholders({
        ctx,
        policyEntityId: POLICY_ID,
        applyResult: apply,
        iter: 2,
        opsTicket: "QUA-OPS",
        postComment,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DualWriteZodAbort);
    expect((thrown as DualWriteZodAbort).rejections).toHaveLength(1);
    expect((thrown as DualWriteZodAbort).rejections[0].code).toBe("zod");

    // markStatus('aborted', { reason: 'zod_violation' }) was called BEFORE
    // throwing so withPipelineRun keeps the override.
    expect(ctx.statuses).toEqual([
      {
        status: "aborted",
        info: { reason: "zod_violation", errorCode: "DualWriteZodAbort" },
      },
    ]);
    expect(ctx.followups).toHaveLength(1);
    expect(ctx.followups[0].kind).toBe("phase2_zod_abort");
    expect(ctx.followups[0].iter).toBe(2);

    // Ops ticket comment was posted (ABORT routes to ops per spec).
    expect(postComment).toHaveBeenCalledTimes(1);
    const [ticket, body] = postComment.mock.calls[0];
    expect(ticket).toBe("QUA-OPS");
    expect(body).toContain("aborted_zod");
    expect(body).toContain(POLICY_ID);
  });

  it("treats `code: 'enum_violation'` as ABORT (it's a refinement of zod)", async () => {
    const apply = applyVerdictsToPolicy(basePolicy(), [
      v({ targetField: "stakeholder.aclu", displayHint: "ACLU" }),
    ]);
    apiRequestMock.mockResolvedValueOnce({
      ok: true,
      data: {
        committed: [],
        rejected: [
          {
            idx: 0,
            code: "enum_violation",
            message: "Invalid enum value `position`",
            field: "items[0].position",
            value: "reform",
            allowed: ["support", "oppose", "neutral", "mixed"],
          },
        ],
        verdictsWritten: 0,
        claimsLinked: 0,
      },
    });
    const ctx = makeCtx();
    const postComment = vi.fn(async () => {});

    await expect(
      dualWriteStakeholders({
        ctx,
        policyEntityId: POLICY_ID,
        applyResult: apply,
        iter: 1,
        opsTicket: "QUA-OPS",
        postComment,
      }),
    ).rejects.toBeInstanceOf(DualWriteZodAbort);
    expect(ctx.statuses[0]?.info?.reason).toBe("zod_violation");
  });
});

// ---------------------------------------------------------------------------
// Fixture 3: fk-missing → PARTIAL commit
// ---------------------------------------------------------------------------

describe("dualWriteStakeholders — partial (fk_missing)", () => {
  it("returns ok:false, marks partial_failure, and records followup_actions", async () => {
    const apply = applyVerdictsToPolicy(basePolicy(), [
      v({ targetField: "stakeholder.aclu", displayHint: "ACLU" }),
      v({
        targetField: "stakeholder.eff",
        displayHint: "EFF",
        claimText: "EFF opposes the bill",
      }),
    ]);
    apiRequestMock.mockResolvedValueOnce({
      ok: true,
      data: {
        committed: ["abc1234567"], // ACLU committed
        rejected: [
          {
            idx: 1,
            code: "fk_missing",
            message: "Entity reference not found: policyEntityId=sid_unknown",
            field: "policyEntityId",
            value: "sid_unknown",
          },
        ],
        verdictsWritten: 0,
        claimsLinked: 0,
      },
    });
    const ctx = makeCtx();
    const postComment = vi.fn(async () => {});

    const result = await dualWriteStakeholders({
      ctx,
      policyEntityId: POLICY_ID,
      applyResult: apply,
      iter: 3,
      opsTicket: "QUA-OPS",
      postComment,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("partial_failure");
    expect(result.committedIds).toEqual(["abc1234567"]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].code).toBe("fk_missing");

    // markStatus('partial_failure') so withPipelineRun records this run as
    // partial_failure even when subsequent iterations succeed.
    expect(ctx.statuses).toEqual([
      { status: "partial_failure", info: { reason: "fk_missing_or_other_partial" } },
    ]);
    expect(ctx.followups).toHaveLength(1);
    expect(ctx.followups[0].kind).toBe("phase2_partial");
    expect(ctx.followups[0].iter).toBe(3);
    expect(ctx.followups[0].rejected).toHaveLength(1);

    // Ops comment was posted (partial routes to ops too).
    expect(postComment).toHaveBeenCalledTimes(1);
    const body = postComment.mock.calls[0][1] as string;
    expect(body).toContain("partial_failure");
  });
});

// ---------------------------------------------------------------------------
// HTTP transport failure → ABORT
// ---------------------------------------------------------------------------

describe("dualWriteStakeholders — HTTP failure", () => {
  it("throws DualWriteHttpError and marks status=aborted on transport failure", async () => {
    const apply = applyVerdictsToPolicy(basePolicy(), [
      v({ targetField: "stakeholder.aclu", displayHint: "ACLU" }),
    ]);
    apiRequestMock.mockResolvedValueOnce({
      ok: false,
      error: "ECONNREFUSED",
      message: "wiki-server unreachable",
    });
    const ctx = makeCtx();
    const postComment = vi.fn(async () => {});

    let thrown: unknown;
    try {
      await dualWriteStakeholders({
        ctx,
        policyEntityId: POLICY_ID,
        applyResult: apply,
        iter: 1,
        opsTicket: "QUA-OPS",
        postComment,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DualWriteHttpError);
    expect(ctx.statuses[0]?.status).toBe("aborted");
    expect(ctx.statuses[0]?.info?.reason).toBe("sync_http_error");
    expect(postComment).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Comment-failure non-fatal
// ---------------------------------------------------------------------------

describe("dualWriteStakeholders — comment failure", () => {
  it("does not propagate a comment-post failure into the dual-write outcome", async () => {
    const apply = applyVerdictsToPolicy(basePolicy(), [
      v({ targetField: "stakeholder.aclu", displayHint: "ACLU" }),
    ]);
    apiRequestMock.mockResolvedValueOnce({
      ok: true,
      data: {
        committed: ["abc1234567"],
        rejected: [
          {
            idx: 1,
            code: "fk_missing",
            message: "missing FK",
            field: "policyEntityId",
            value: "sid_unknown",
          },
        ],
        verdictsWritten: 0,
        claimsLinked: 0,
      },
    });
    const ctx = makeCtx();
    const postComment = vi.fn(async () => {
      throw new Error("Linear is down");
    });
    const result = await dualWriteStakeholders({
      ctx,
      policyEntityId: POLICY_ID,
      applyResult: apply,
      iter: 1,
      opsTicket: "QUA-OPS",
      postComment,
    });
    // The partial outcome still surfaces; the comment failure was logged.
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("partial_failure");
  });

  it("skips the comment when no opsTicket is configured", async () => {
    const apply = applyVerdictsToPolicy(basePolicy(), [
      v({ targetField: "stakeholder.aclu", displayHint: "ACLU" }),
    ]);
    apiRequestMock.mockResolvedValueOnce({
      ok: true,
      data: {
        committed: [],
        rejected: [
          {
            idx: 0,
            code: "zod",
            message: "x",
          },
        ],
        verdictsWritten: 0,
        claimsLinked: 0,
      },
    });
    const ctx = makeCtx();
    const postComment = vi.fn(async () => {});
    await expect(
      dualWriteStakeholders({
        ctx,
        policyEntityId: POLICY_ID,
        applyResult: apply,
        iter: 1,
        opsTicket: null,
        postComment,
      }),
    ).rejects.toBeInstanceOf(DualWriteZodAbort);
    expect(postComment).not.toHaveBeenCalled();
  });
});
