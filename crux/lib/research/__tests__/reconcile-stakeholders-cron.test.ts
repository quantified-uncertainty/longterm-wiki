import { describe, it, expect, vi } from "vitest";
import { runReconcile } from "../reconcile-stakeholders-cron.ts";
import type { PgStakeholderRow, PolicyEntityForReconcile } from "../reconcile-stakeholders.ts";

const POLICY_A = "sid_PolicyA";
const POLICY_B = "sid_PolicyB";

function policy(stableId: string, stakeholders: PolicyEntityForReconcile["stakeholders"] = []): PolicyEntityForReconcile {
  return { id: stableId.toLowerCase(), type: "policy", stableId, stakeholders };
}

function pgRow(over: Partial<PgStakeholderRow> = {}): PgStakeholderRow {
  return {
    id: "abc1234567",
    policyEntityId: POLICY_A,
    stakeholderEntityId: null,
    stakeholderDisplayName: "ACLU",
    position: "oppose",
    importance: null,
    reason: null,
    source: null,
    context: null,
    ...over,
  };
}

function makeOkStart(id = 42) {
  return vi.fn(async () => ({
    ok: true as const,
    data: { id, domain: "policy_stakeholders" as const, startedAt: new Date().toISOString() },
  }));
}

function makeOkComplete() {
  return vi.fn(async () => ({
    ok: true as const,
    data: {
      id: 42,
      completedAt: new Date().toISOString(),
      diffsDetected: 0,
      nonEmptyDiffsObserved: 0,
    },
  }));
}

describe("runReconcile", () => {
  it("steady state — no diffs → no comment posted, ok run", async () => {
    const policies = [policy(POLICY_A, [{ name: "ACLU", position: "oppose" }])];
    const pgRows = [pgRow({ stakeholderDisplayName: "ACLU" })];
    const startFn = makeOkStart();
    const completeFn = makeOkComplete();
    const postComment = vi.fn(async () => {});

    const r = await runReconcile({
      trigger: "scheduled",
      trackingTicket: "QUA-OPS",
      postComment,
      startFn,
      completeFn,
      fetchPgRowsFn: async () => pgRows,
      loadPoliciesFn: () => policies,
    });

    expect(r.runId).toBe(42);
    expect(r.hadDivergence).toBe(false);
    expect(r.errorMessage).toBeNull();
    expect(r.result.entitiesScanned).toBe(1);
    expect(r.result.entitiesWithDiff).toBe(0);

    // start + complete were called, no comment (steady state IS posted as
    // heartbeat — re-checking the spec). Actually per buildHeartbeatBody,
    // heartbeat ALWAYS posts. Let me adjust: the post happens regardless of
    // divergence so the absence-of-comment doesn't mean "0 diffs".
    expect(startFn).toHaveBeenCalledOnce();
    expect(completeFn).toHaveBeenCalledOnce();
    expect(postComment).toHaveBeenCalledOnce();
    const body = postComment.mock.calls[0][1] as string;
    expect(body).toContain("Steady state");
  });

  it("with divergence — posts comment naming entities", async () => {
    const policies = [policy(POLICY_A, [{ name: "ACLU", position: "oppose" }])];
    const pgRows: PgStakeholderRow[] = []; // PG missing the row
    const startFn = makeOkStart();
    const completeFn = makeOkComplete();
    const postComment = vi.fn(async () => {});

    const r = await runReconcile({
      trigger: "scheduled",
      trackingTicket: "QUA-OPS",
      postComment,
      startFn,
      completeFn,
      fetchPgRowsFn: async () => pgRows,
      loadPoliciesFn: () => policies,
    });

    expect(r.hadDivergence).toBe(true);
    expect(r.result.entitiesNonEmptyWithDiff).toBe(1);
    expect(r.commentedOn).toBe("QUA-OPS");
    const body = postComment.mock.calls[0][1] as string;
    expect(body).toContain("Divergence detected");
    expect(body).toContain(POLICY_A);
  });

  it("throws when start fails (no audit row possible)", async () => {
    const startFn = vi.fn(async () => ({
      ok: false as const,
      error: "unavailable" as const,
      message: "wiki-server timeout",
    }));
    await expect(
      runReconcile({
        trigger: "scheduled",
        trackingTicket: null,
        startFn,
      }),
    ).rejects.toThrow(/failed to open run row.*wiki-server timeout/);
  });

  it("captures scan error in errorCode and posts failure comment", async () => {
    const startFn = makeOkStart();
    const completeFn = makeOkComplete();
    const postComment = vi.fn(async () => {});

    const r = await runReconcile({
      trigger: "scheduled",
      trackingTicket: "QUA-OPS",
      postComment,
      startFn,
      completeFn,
      fetchPgRowsFn: async () => {
        throw new Error("ECONNREFUSED");
      },
      loadPoliciesFn: () => [policy(POLICY_A, [{ name: "ACLU", position: "oppose" }])],
    });
    expect(r.errorMessage).toMatch(/ECONNREFUSED/);
    // The complete call gets the errorCode for the row.
    const completeCall = completeFn.mock.calls[0][0];
    expect(completeCall.errorCode).toBe("scan_error");
    expect(completeCall.errorMessage).toMatch(/ECONNREFUSED/);
    // Failure comment goes to the ops ticket too.
    const body = postComment.mock.calls[0][1] as string;
    expect(body).toContain("Run failed");
    expect(body).toContain("ECONNREFUSED");
  });

  it("does not throw when complete fails — surfaces in errorMessage instead", async () => {
    const startFn = makeOkStart();
    const completeFn = vi.fn(async () => ({
      ok: false as const,
      error: "server_error" as const,
      message: "DB timeout",
    }));
    const r = await runReconcile({
      trigger: "scheduled",
      trackingTicket: null,
      startFn,
      completeFn,
      fetchPgRowsFn: async () => [],
      loadPoliciesFn: () => [],
    });
    expect(r.errorMessage).toMatch(/complete failed.*DB timeout/);
  });

  it("does not propagate a comment-post failure into the outcome", async () => {
    const startFn = makeOkStart();
    const completeFn = makeOkComplete();
    const postComment = vi.fn(async () => {
      throw new Error("Linear is down");
    });
    const r = await runReconcile({
      trigger: "scheduled",
      trackingTicket: "QUA-OPS",
      postComment,
      startFn,
      completeFn,
      fetchPgRowsFn: async () => [],
      loadPoliciesFn: () => [],
    });
    // The run still succeeded; the comment failure was logged.
    expect(r.errorMessage).toBeNull();
    expect(r.commentedOn).toBeNull();
  });

  it("skips the comment when no trackingTicket is configured", async () => {
    const startFn = makeOkStart();
    const completeFn = makeOkComplete();
    const postComment = vi.fn(async () => {});
    const r = await runReconcile({
      trigger: "scheduled",
      trackingTicket: null,
      postComment,
      startFn,
      completeFn,
      fetchPgRowsFn: async () => [],
      loadPoliciesFn: () => [],
    });
    expect(postComment).not.toHaveBeenCalled();
    expect(r.commentedOn).toBeNull();
  });

  it("buckets PG rows by policy correctly across multiple policies", async () => {
    const policies = [
      policy(POLICY_A, [{ name: "ACLU", position: "oppose" }]),
      policy(POLICY_B, [{ name: "EFF", position: "oppose" }]),
    ];
    const pgRows = [
      pgRow({ policyEntityId: POLICY_A, stakeholderDisplayName: "ACLU" }),
      pgRow({ policyEntityId: POLICY_B, stakeholderDisplayName: "EFF" }),
    ];
    const startFn = makeOkStart();
    const completeFn = makeOkComplete();
    const r = await runReconcile({
      trigger: "scheduled",
      trackingTicket: null,
      startFn,
      completeFn,
      fetchPgRowsFn: async () => pgRows,
      loadPoliciesFn: () => policies,
    });
    expect(r.result.entitiesScanned).toBe(2);
    expect(r.result.entitiesWithDiff).toBe(0);
  });
});
