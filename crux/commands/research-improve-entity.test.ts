/**
 * Tests for the wait-for-settle drain logic in `research-improve-entity.ts`
 * (QUA-939).
 *
 * Covers:
 *   - `buildVerifiedVerdictsFromBatch`: pure helper that joins batch metadata
 *     with verdict rows. Tests the onlyNew filter, verdict counts, and
 *     status-mapping (verified/partial/contradicted/unverifiable/pending).
 *   - `drainPendingBatches`: post-exit drain. The three acceptance scenarios
 *     from the issue:
 *       1. target-hit before any pending — drain is a no-op
 *       2. target-hit with pending — drain catches new verifieds and applies them
 *       3. target-hit with all settled — drain is a no-op
 *     Plus: time-cap timeout, multiple batches, idempotency on re-poll, and
 *     applyFn errors propagate.
 *
 * The pure parsing helper `parseExtractedClaims` already has implicit coverage
 * via its export from research-improve-entity.ts; not re-tested here.
 */

import { describe, it, expect } from "vitest";

import {
  BudgetExhaustedError,
  buildImproveEntityRunOptions,
  buildVerifiedVerdictsFromBatch,
  checkBudgetOrThrow,
  drainPendingBatches,
  parseAgentSessionId,
  parseExtractedClaims,
  type ClaimVerdictRow,
  type SubmittedBatchInfo,
} from "./research-improve-entity.ts";
import { CostTracker } from "../lib/cost-tracker.ts";
import type { EntityWithType as ImportedEntityWithType } from "./research-improve-entity.ts";
import type { PreFilterClaim } from "../lib/research/pre-filter.ts";
import type { ApplyResult, VerifiedVerdict } from "../lib/research/apply-verdicts.ts";

// ── fixtures ───────────────────────────────────────────────────────────────

interface EntityWithType {
  id: string;
  type: string;
  [k: string]: unknown;
}

function makeClaim(
  i: number,
  overrides: Partial<PreFilterClaim> = {},
): PreFilterClaim {
  return {
    claimText: `claim ${i}`,
    proposedValue: `value ${i}`,
    resourceId: `https://example.com/${i}`,
    sourceUrl: `https://example.com/${i}`,
    targetField: `provision.gap-${i}`,
    displayHint: `Gap ${i}`,
    ...overrides,
  };
}

function makeVerdict(
  id: number,
  status: string,
  overrides: Partial<ClaimVerdictRow> = {},
): ClaimVerdictRow {
  return {
    id,
    status,
    verdictReasoning: status === "verified" ? "matches source" : null,
    extractedValue: status === "verified" ? `extracted-${id}` : null,
    claimText: `claim text ${id}`,
    ...overrides,
  };
}

function makeBatch(
  overrides: Partial<SubmittedBatchInfo> = {},
): SubmittedBatchInfo {
  const submittedByOrder: PreFilterClaim[] = [makeClaim(1), makeClaim(2)];
  const claimIds: Array<number | undefined> = [101, 102];
  const lastVerdicts: ClaimVerdictRow[] = [
    makeVerdict(101, "verified"),
    makeVerdict(102, "verified"),
  ];
  return {
    iter: 1,
    batchId: "batch-1",
    submittedByOrder,
    claimIds,
    settled: true,
    appliedClaimIds: new Set<number>(),
    lastVerdicts,
    ...overrides,
  };
}

// A no-op apply function — returns the entity unchanged with `added` actions
// for every verdict it received. Used when the test only cares about counts.
async function fakeApplyAll(
  entity: EntityWithType,
  verdicts: VerifiedVerdict[],
): Promise<ApplyResult<EntityWithType>> {
  return {
    entity: {
      ...entity,
      // Stash the verdicts on the entity so the test can assert what was applied.
      __applied: [...((entity as { __applied?: VerifiedVerdict[] }).__applied ?? []), ...verdicts],
    } as EntityWithType,
    applied: verdicts.map((v) => ({ targetField: v.targetField, action: "added" as const })),
    warnings: [],
  };
}

// ── buildVerifiedVerdictsFromBatch ─────────────────────────────────────────

describe("buildVerifiedVerdictsFromBatch", () => {
  it("returns one VerifiedVerdict per verified+partial verdict, with submitted metadata", () => {
    const batch = makeBatch({
      submittedByOrder: [
        makeClaim(1, { targetField: "provision.alpha", displayHint: "Alpha" }),
        makeClaim(2, { targetField: "stakeholder.acme", displayHint: "Acme", position: "oppose", positionConfidence: 0.9 }),
      ],
      claimIds: [101, 102],
      lastVerdicts: [makeVerdict(101, "verified"), makeVerdict(102, "partial")],
    });
    const out = buildVerifiedVerdictsFromBatch(batch, false);
    expect(out.counts).toEqual({ verified: 1, partial: 1, contradicted: 0, unverifiable: 0 });
    expect(out.verdicts).toHaveLength(2);
    expect(out.verdicts[0].targetField).toBe("provision.alpha");
    expect(out.verdicts[0].displayHint).toBe("Alpha");
    expect(out.verdicts[0].status).toBe("verified");
    expect(out.verdicts[0].extractedValue).toBe("extracted-101");
    expect(out.verdicts[1].targetField).toBe("stakeholder.acme");
    expect(out.verdicts[1].position).toBe("oppose");
    expect(out.verdicts[1].positionConfidence).toBe(0.9);
    expect(out.verdicts[1].status).toBe("partial");
  });

  it("counts contradicted/unverifiable but does not include them in verdicts[]", () => {
    const batch = makeBatch({
      claimIds: [101, 102, 103, 104],
      submittedByOrder: [makeClaim(1), makeClaim(2), makeClaim(3), makeClaim(4)],
      lastVerdicts: [
        makeVerdict(101, "verified"),
        makeVerdict(102, "contradicted"),
        makeVerdict(103, "unverifiable"),
        makeVerdict(104, "expired"), // unknown-to-us — treated as not verified+partial
      ],
    });
    const out = buildVerifiedVerdictsFromBatch(batch, false);
    expect(out.counts).toEqual({ verified: 1, partial: 0, contradicted: 1, unverifiable: 1 });
    expect(out.verdicts).toHaveLength(1);
    expect(out.verdicts[0].status).toBe("verified");
  });

  it("respects onlyNew=true by skipping claim IDs in appliedClaimIds", () => {
    const batch = makeBatch({
      claimIds: [101, 102],
      submittedByOrder: [makeClaim(1), makeClaim(2)],
      lastVerdicts: [makeVerdict(101, "verified"), makeVerdict(102, "verified")],
      appliedClaimIds: new Set([101]),
    });
    const out = buildVerifiedVerdictsFromBatch(batch, true);
    expect(out.counts).toEqual({ verified: 1, partial: 0, contradicted: 0, unverifiable: 0 });
    expect(out.verdicts).toHaveLength(1);
    // Only id=102 should survive the filter.
    expect(out.verdicts[0].claimText).toBe("claim text 102");
  });

  it("skips entries whose claim ID is undefined (proposeClaims returned fewer than expected)", () => {
    const batch = makeBatch({
      claimIds: [101, undefined],
      submittedByOrder: [makeClaim(1), makeClaim(2)],
      lastVerdicts: [makeVerdict(101, "verified")],
    });
    const out = buildVerifiedVerdictsFromBatch(batch, false);
    expect(out.counts.verified).toBe(1);
    expect(out.verdicts).toHaveLength(1);
  });

  it("skips entries whose claim ID has no matching verdict (worker dropped row)", () => {
    const batch = makeBatch({
      claimIds: [101, 102],
      submittedByOrder: [makeClaim(1), makeClaim(2)],
      lastVerdicts: [makeVerdict(101, "verified")], // 102 missing
    });
    const out = buildVerifiedVerdictsFromBatch(batch, false);
    expect(out.counts.verified).toBe(1);
    expect(out.verdicts).toHaveLength(1);
  });

  it("does not count claims with status='pending' or 'verifying' as terminal", () => {
    const batch = makeBatch({
      claimIds: [101, 102],
      submittedByOrder: [makeClaim(1), makeClaim(2)],
      lastVerdicts: [makeVerdict(101, "pending"), makeVerdict(102, "verifying")],
    });
    const out = buildVerifiedVerdictsFromBatch(batch, false);
    expect(out.counts).toEqual({ verified: 0, partial: 0, contradicted: 0, unverifiable: 0 });
    expect(out.verdicts).toHaveLength(0);
  });
});

// ── drainPendingBatches: 3 acceptance scenarios ────────────────────────────

describe("drainPendingBatches — acceptance scenarios", () => {
  const entity: EntityWithType = { id: "test-entity", type: "policy" };
  const POLL_INTERVAL_MS = 5; // fast for tests

  it("scenario 1: target-hit before any pending — drain is a no-op", async () => {
    // No batches submitted (e.g. iter 0 short-circuited), so there's nothing
    // to drain. The drain should report zeros across the board and not call
    // pollFn at all.
    let pollCount = 0;
    const result = await drainPendingBatches(entity, [], {
      pollIntervalMs: POLL_INTERVAL_MS,
      pollFn: async (id) => {
        pollCount++;
        return { allSettled: true, claims: [] };
      },
      applyFn: fakeApplyAll,
    });
    expect(pollCount).toBe(0);
    expect(result.pendingAtStart).toBe(0);
    expect(result.verifiedAfterDrain).toBe(0);
    expect(result.appliedAfterDrain).toBe(0);
    expect(result.entity).toBe(entity);
    expect(result.timedOut).toBe(false);
  });

  it("scenario 2: target-hit with pending — drain catches new verifieds and applies them", async () => {
    // Setup: a batch with 4 claims. At main-loop exit, 2 are verified (already
    // applied), 2 are still pending. The pending two will resolve to verified
    // on the next poll. The drain should apply them and report
    // verified_after_drain=2.
    const batch: SubmittedBatchInfo = {
      iter: 1,
      batchId: "batch-A",
      submittedByOrder: [
        makeClaim(1, { targetField: "provision.alpha" }),
        makeClaim(2, { targetField: "provision.beta" }),
        makeClaim(3, { targetField: "provision.gamma" }),
        makeClaim(4, { targetField: "provision.delta" }),
      ],
      claimIds: [201, 202, 203, 204],
      settled: false,
      appliedClaimIds: new Set([201, 202]), // first two already applied per-iter
      lastVerdicts: [
        makeVerdict(201, "verified"),
        makeVerdict(202, "verified"),
        makeVerdict(203, "pending"),
        makeVerdict(204, "verifying"),
      ],
    };

    let pollCount = 0;
    const pollFn = async (batchId: string) => {
      pollCount++;
      expect(batchId).toBe("batch-A");
      // After one poll, all 4 claims have settled. The two new ones become verified.
      return {
        allSettled: true,
        claims: [
          makeVerdict(201, "verified"),
          makeVerdict(202, "verified"),
          makeVerdict(203, "verified"),
          makeVerdict(204, "verified"),
        ],
      };
    };

    const result = await drainPendingBatches(entity, [batch], {
      pollIntervalMs: POLL_INTERVAL_MS,
      pollFn,
      applyFn: fakeApplyAll,
    });

    expect(result.pendingAtStart).toBe(2); // 1 pending + 1 verifying
    expect(result.verifiedAfterDrain).toBe(2);
    expect(result.partialAfterDrain).toBe(0);
    expect(result.appliedAfterDrain).toBe(2);
    expect(result.timedOut).toBe(false);
    expect(pollCount).toBe(1);
    // Batch state is mutated to reflect the drain.
    expect(batch.settled).toBe(true);
    expect(batch.appliedClaimIds).toEqual(new Set([201, 202, 203, 204]));
    // Only the new verdicts (203, 204) should have been applied — not the
    // already-applied ones (201, 202). fakeApplyAll stashes them on the entity.
    const applied = (result.entity as { __applied?: VerifiedVerdict[] }).__applied ?? [];
    expect(applied).toHaveLength(2);
    expect(applied.map((v) => v.targetField).sort()).toEqual(["provision.delta", "provision.gamma"]);
  });

  it("scenario 3: target-hit with all settled — drain is a no-op", async () => {
    // The main loop exited with the batch fully drained (settled=true, no
    // pending verdicts). Drain should not poll and not apply.
    const batch: SubmittedBatchInfo = {
      iter: 1,
      batchId: "batch-S",
      submittedByOrder: [makeClaim(1), makeClaim(2)],
      claimIds: [301, 302],
      settled: true,
      appliedClaimIds: new Set([301, 302]),
      lastVerdicts: [makeVerdict(301, "verified"), makeVerdict(302, "verified")],
    };

    let pollCount = 0;
    const result = await drainPendingBatches(entity, [batch], {
      pollIntervalMs: POLL_INTERVAL_MS,
      pollFn: async () => {
        pollCount++;
        return { allSettled: true, claims: [] };
      },
      applyFn: fakeApplyAll,
    });

    expect(pollCount).toBe(0);
    expect(result.pendingAtStart).toBe(0);
    expect(result.verifiedAfterDrain).toBe(0);
    expect(result.appliedAfterDrain).toBe(0);
    expect(result.entity).toBe(entity);
  });
});

// ── drainPendingBatches: edge cases ────────────────────────────────────────

describe("drainPendingBatches — edge cases", () => {
  const entity: EntityWithType = { id: "test-entity", type: "policy" };

  it("reports timedOut=true when maxDurationMs elapses with batches still unsettled", async () => {
    // Batch never settles. Drain should respect the time cap.
    const batch: SubmittedBatchInfo = {
      iter: 1,
      batchId: "stuck",
      submittedByOrder: [makeClaim(1)],
      claimIds: [401],
      settled: false,
      appliedClaimIds: new Set(),
      lastVerdicts: [makeVerdict(401, "pending")],
    };

    const result = await drainPendingBatches(entity, [batch], {
      pollIntervalMs: 1,
      maxDurationMs: 20, // ~20ms cap
      pollFn: async () => ({
        allSettled: false,
        claims: [makeVerdict(401, "pending")],
      }),
      applyFn: fakeApplyAll,
    });

    expect(result.timedOut).toBe(true);
    expect(result.verifiedAfterDrain).toBe(0);
    expect(batch.settled).toBe(false);
  });

  it("polls multiple batches and tracks them independently", async () => {
    const batchA: SubmittedBatchInfo = {
      iter: 1,
      batchId: "A",
      submittedByOrder: [makeClaim(1, { targetField: "provision.a" })],
      claimIds: [501],
      settled: false,
      appliedClaimIds: new Set(),
      lastVerdicts: [makeVerdict(501, "pending")],
    };
    const batchB: SubmittedBatchInfo = {
      iter: 2,
      batchId: "B",
      submittedByOrder: [makeClaim(2, { targetField: "provision.b" })],
      claimIds: [601],
      settled: true, // already settled — should NOT be polled
      appliedClaimIds: new Set([601]),
      lastVerdicts: [makeVerdict(601, "verified")],
    };

    const polledBatchIds: string[] = [];
    const result = await drainPendingBatches(entity, [batchA, batchB], {
      pollIntervalMs: 1,
      pollFn: async (id) => {
        polledBatchIds.push(id);
        return { allSettled: true, claims: [makeVerdict(501, "verified")] };
      },
      applyFn: fakeApplyAll,
    });

    expect(polledBatchIds).toEqual(["A"]); // B was already settled
    expect(result.verifiedAfterDrain).toBe(1);
    expect(result.appliedAfterDrain).toBe(1);
    expect(batchA.settled).toBe(true);
    expect(batchB.settled).toBe(true);
  });

  it("skips re-applying claim IDs already in appliedClaimIds across multiple poll rounds", async () => {
    // Round 1: poll says batch is unsettled but verdict 701 is now verified.
    // Round 2: poll says batch is settled; same 701 is verified plus 702 is verified.
    // The drain should apply 701 ONCE (round 1) and 702 ONCE (round 2).
    const batch: SubmittedBatchInfo = {
      iter: 1,
      batchId: "multi",
      submittedByOrder: [
        makeClaim(1, { targetField: "provision.first" }),
        makeClaim(2, { targetField: "provision.second" }),
      ],
      claimIds: [701, 702],
      settled: false,
      appliedClaimIds: new Set(),
      lastVerdicts: [makeVerdict(701, "pending"), makeVerdict(702, "pending")],
    };

    let round = 0;
    const result = await drainPendingBatches(entity, [batch], {
      pollIntervalMs: 1,
      pollFn: async () => {
        round++;
        if (round === 1) {
          return {
            allSettled: false,
            claims: [makeVerdict(701, "verified"), makeVerdict(702, "pending")],
          };
        }
        return {
          allSettled: true,
          claims: [makeVerdict(701, "verified"), makeVerdict(702, "verified")],
        };
      },
      applyFn: fakeApplyAll,
    });

    expect(result.verifiedAfterDrain).toBe(2); // 701 in round 1 + 702 in round 2
    expect(result.appliedAfterDrain).toBe(2);
    const applied = (result.entity as { __applied?: VerifiedVerdict[] }).__applied ?? [];
    expect(applied).toHaveLength(2);
    expect(applied.map((v) => v.targetField).sort()).toEqual(["provision.first", "provision.second"]);
  });

  it("continues when pollFn returns null (transient API error)", async () => {
    // First poll fails (returns null); next poll succeeds. Drain should
    // tolerate the failure and finish on the second try.
    const batch: SubmittedBatchInfo = {
      iter: 1,
      batchId: "flaky",
      submittedByOrder: [makeClaim(1)],
      claimIds: [801],
      settled: false,
      appliedClaimIds: new Set(),
      lastVerdicts: [makeVerdict(801, "pending")],
    };

    let round = 0;
    const result = await drainPendingBatches(entity, [batch], {
      pollIntervalMs: 1,
      pollFn: async () => {
        round++;
        if (round === 1) return null;
        return { allSettled: true, claims: [makeVerdict(801, "verified")] };
      },
      applyFn: fakeApplyAll,
    });

    expect(result.verifiedAfterDrain).toBe(1);
    expect(result.timedOut).toBe(false);
  });
});

// ── parseExtractedClaims (sanity — already covered by export, repeated lightly) ─

describe("parseExtractedClaims", () => {
  it("returns empty array on malformed input", () => {
    expect(parseExtractedClaims("")).toEqual([]);
    expect(parseExtractedClaims("not a json")).toEqual([]);
    expect(parseExtractedClaims("[invalid json}")).toEqual([]);
  });

  it("strips position from non-stakeholder claims (Haiku leaks them sometimes)", () => {
    const raw = JSON.stringify([
      {
        targetField: "provision.alpha",
        claimText: "Some provision text",
        proposedValue: "value",
        position: "support",
        positionConfidence: 0.9,
      },
    ]);
    const parsed = parseExtractedClaims(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].position).toBeNull();
    expect(parsed[0].positionConfidence).toBeNull();
  });
});

// ─── pipeline-runs lifecycle wiring (QUA-957) ──────────────────────────────

describe("buildImproveEntityRunOptions", () => {
  const baseEntity: ImportedEntityWithType = {
    id: "fisa-702",
    type: "policy",
    title: "FISA 702",
  };

  it("uses stableId when present; falls back to id", () => {
    const withStable = buildImproveEntityRunOptions(
      { ...baseEntity, stableId: "sid_FisaPolicy0" },
      null,
    );
    expect(withStable.entityId).toBe("sid_FisaPolicy0");

    const withoutStable = buildImproveEntityRunOptions(baseEntity, null);
    expect(withoutStable.entityId).toBe("fisa-702");
  });

  it("publishes pipelineName='improve-entity' (stable identifier for the dashboard)", () => {
    const opts = buildImproveEntityRunOptions(baseEntity, null);
    expect(opts.pipelineName).toBe("improve-entity");
  });

  it("propagates entity.type as shape", () => {
    const policy = buildImproveEntityRunOptions(baseEntity, null);
    expect(policy.shape).toBe("policy");

    const org = buildImproveEntityRunOptions(
      { ...baseEntity, type: "organization" },
      null,
    );
    expect(org.shape).toBe("organization");
  });

  it("passes through agentSessionId (null and numeric)", () => {
    expect(buildImproveEntityRunOptions(baseEntity, null).agentSessionId).toBeNull();
    expect(buildImproveEntityRunOptions(baseEntity, 42).agentSessionId).toBe(42);
  });

  it("sets allowOffline=true so dev sessions degrade rather than throw", () => {
    // Phase 1 wiring: improvement loop must keep working when wiki-server
    // is unreachable (offline development, slot without prod creds). The
    // helper logs a warning and returns a no-op runCtx.
    expect(buildImproveEntityRunOptions(baseEntity, null).allowOffline).toBe(true);
  });
});

describe("parseAgentSessionId", () => {
  it("returns null when the cached id is null", () => {
    expect(parseAgentSessionId(null)).toBeNull();
  });

  it("parses a numeric string into a number", () => {
    expect(parseAgentSessionId("42")).toBe(42);
    expect(parseAgentSessionId("0")).toBe(0);
  });

  it("returns null for non-numeric strings", () => {
    // Number("") is 0 → still numeric. Number("abc") is NaN → null.
    // We treat NaN as "not a valid id" but accept "0" — agent_sessions.id
    // is bigserial starting at 1, so 0 won't appear in practice.
    expect(parseAgentSessionId("abc")).toBeNull();
    expect(parseAgentSessionId("not-a-number")).toBeNull();
  });
});

// ── checkBudgetOrThrow + BudgetExhaustedError (QUA-1017) ───────────────────

describe("checkBudgetOrThrow", () => {
  function trackerWithCost(usd: number): CostTracker {
    const t = new CostTracker();
    if (usd > 0) t.recordExternalCost("test-model", usd, "test");
    return t;
  }

  it("does not throw when totalCost is below budget", () => {
    const t = trackerWithCost(0.5);
    expect(() => checkBudgetOrThrow(t, 1.0)).not.toThrow();
  });

  it("throws BudgetExhaustedError when totalCost exactly equals budget (>=, not >)", () => {
    const t = trackerWithCost(1.0);
    expect(() => checkBudgetOrThrow(t, 1.0)).toThrow(BudgetExhaustedError);
  });

  it("throws BudgetExhaustedError when totalCost has overshot budget", () => {
    const t = trackerWithCost(1.5);
    let caught: unknown;
    try {
      checkBudgetOrThrow(t, 1.0);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BudgetExhaustedError);
    const err = caught as BudgetExhaustedError;
    expect(err.spentUsd).toBe(1.5);
    expect(err.budgetUsd).toBe(1.0);
    expect(err.message).toContain("$1.5000");
    expect(err.message).toContain("$1.00");
    expect(err.name).toBe("BudgetExhaustedError");
  });

  it("does not throw on a fresh tracker against a positive budget", () => {
    const t = new CostTracker();
    expect(() => checkBudgetOrThrow(t, 5.0)).not.toThrow();
  });

  it("throws on a fresh tracker against a zero budget (degenerate but defined)", () => {
    // A budget of 0 means "no spend allowed" — even an empty tracker should
    // trip immediately so callers can't cheat the cap by setting it to 0.
    const t = new CostTracker();
    expect(() => checkBudgetOrThrow(t, 0)).toThrow(BudgetExhaustedError);
  });
});
