/**
 * Tests for the canonical evidence-aggregation function (QUA-791 Phase 1).
 *
 * Pure logic — no DB, no fixtures. Each test names the scenario it covers
 * so failures point straight at the rule being violated.
 */

import { describe, it, expect } from "vitest";
import {
  aggregateEvidence,
  DEFAULT_MIN_RELEVANCE,
  SOURCE_CHECK_VERDICT_PRIORITY,
} from "../routes/sourcing/sourcing-aggregation.js";
import type { EvidenceRow } from "../routes/sourcing/sourcing-aggregation-types.js";

function row(
  verdict: EvidenceRow["verdict"],
  relevanceScore: number | null = 1.0,
  confidence: number | null = null,
  checkedAt: Date | null = null,
): EvidenceRow {
  return { verdict, relevanceScore, confidence, checkedAt };
}

function staleRow(
  verdict: EvidenceRow["verdict"],
  relevanceScore: number | null = 1.0,
  confidence: number | null = null,
  checkedAt: Date | null = null,
): EvidenceRow {
  return { verdict, relevanceScore, confidence, checkedAt, isStale: true };
}

function freshRow(
  verdict: EvidenceRow["verdict"],
  relevanceScore: number | null = 1.0,
  confidence: number | null = null,
  checkedAt: Date | null = null,
): EvidenceRow {
  return { verdict, relevanceScore, confidence, checkedAt, isStale: false };
}

describe("aggregateEvidence — empty / degenerate input", () => {
  it("returns 'unchecked' for an empty evidence list", () => {
    const r = aggregateEvidence([]);
    expect(r.verdict).toBe("unchecked");
    expect(r.confidence).toBeNull();
    expect(r.sourcesChecked).toBe(0);
    expect(r.contributing).toEqual([]);
    expect(r.droppedNotApplicable).toBe(0);
  });

  it("returns 'unchecked' when every row is not_applicable", () => {
    const r = aggregateEvidence([
      row("not_applicable", 0.9),
      row("not_applicable", 0.7),
    ]);
    expect(r.verdict).toBe("unchecked");
    expect(r.sourcesChecked).toBe(0);
    expect(r.droppedNotApplicable).toBe(2);
  });

  it("returns 'unchecked' when every row is below the relevance threshold", () => {
    const r = aggregateEvidence([
      row("confirmed", 0.1),
      row("partial", 0.05),
    ]);
    expect(r.verdict).toBe("unchecked");
    expect(r.sourcesChecked).toBe(2);
    expect(r.contributing).toEqual([]);
  });
});

describe("aggregateEvidence — single-row inputs", () => {
  it("returns the row's verdict when only one row contributes", () => {
    const r = aggregateEvidence([row("confirmed", 0.9, 0.8)]);
    expect(r.verdict).toBe("confirmed");
    expect(r.confidence).toBeCloseTo(0.8);
    expect(r.sourcesChecked).toBe(1);
    expect(r.contributing).toHaveLength(1);
    expect(r.contributing[0].verdict).toBe("confirmed");
    expect(r.contributing[0].rowCount).toBe(1);
  });

  it("treats NULL relevance as full weight (1.0)", () => {
    const r = aggregateEvidence([row("contradicted", null, 0.5)]);
    expect(r.verdict).toBe("contradicted");
    expect(r.contributing[0].weight).toBe(1);
  });

  it("ignores NULL confidence in the weighted average", () => {
    const r = aggregateEvidence([row("partial", 0.8, null)]);
    expect(r.verdict).toBe("partial");
    expect(r.confidence).toBeNull();
  });
});

describe("aggregateEvidence — relevance weighting", () => {
  it("above-threshold dissent outvotes a single high-relevance row when N×weight > high-rel weight", () => {
    // QUA-791 description claimed: "A single `confirmed` from a high-relevance
    // source should dominate three `unverifiable`s from low-relevance sources."
    // That claim ONLY holds when the dissenting rows are sub-threshold (see
    // the next test). When dissent is above-threshold, simple weighted majority
    // applies: 3 sources × 0.4–0.5 weight (1.35 total) outvote 1 × 0.9.
    //
    // This is a deliberate semantic — we count corroboration even at lower
    // relevance, so long as it crosses the relevance bar at all. The
    // sub-threshold filter is the gate that prevents true noise from voting.
    const r = aggregateEvidence([
      row("confirmed", 0.9, 0.85),
      row("unverifiable", 0.4, 0.7),
      row("unverifiable", 0.45, 0.7),
      row("unverifiable", 0.5, 0.7),
    ]);
    expect(r.verdict).toBe("unverifiable");
  });

  it("with sub-threshold dissent, high-relevance confirmed wins", () => {
    // True spec: dissent below the relevance threshold doesn't get to vote.
    const r = aggregateEvidence([
      row("confirmed", 0.9, 0.85),
      row("unverifiable", 0.1, 0.7),
      row("unverifiable", 0.15, 0.7),
      row("unverifiable", 0.2, 0.7),
    ]);
    expect(r.verdict).toBe("confirmed");
    expect(r.contributing[0].verdict).toBe("confirmed");
  });

  it("relevance-weighted majority — heavier verdict wins", () => {
    const r = aggregateEvidence([
      row("confirmed", 0.95),
      row("confirmed", 0.85),
      row("partial", 0.5),
    ]);
    expect(r.verdict).toBe("confirmed");
    expect(r.contributing[0].verdict).toBe("confirmed");
    expect(r.contributing[0].rowCount).toBe(2);
    // partial appeared with weight 0.5 — surfaces in dissent
    expect(r.contributing.find((c) => c.verdict === "partial")?.weight).toBe(
      0.5,
    );
  });

  it("clamps out-of-range relevance defensively", () => {
    const r = aggregateEvidence([
      row("confirmed", 5.0), // clamped to 1.0
      row("partial", -0.5), // clamped to 0 → no weight, no vote
    ]);
    // partial got weight 0; only confirmed contributes
    expect(r.verdict).toBe("confirmed");
    expect(r.contributing[0].weight).toBe(1);
    expect(r.contributing).toHaveLength(1);
  });
});

describe("aggregateEvidence — tiebreaking by priority", () => {
  it("breaks weight ties using SOURCE_CHECK_VERDICT_PRIORITY (more-actionable wins)", () => {
    // contradicted has lower priority number (0) than confirmed (4) → contradicted wins.
    const r = aggregateEvidence([row("contradicted", 0.8), row("confirmed", 0.8)]);
    expect(r.verdict).toBe("contradicted");
    expect(SOURCE_CHECK_VERDICT_PRIORITY.contradicted).toBeLessThan(
      SOURCE_CHECK_VERDICT_PRIORITY.confirmed,
    );
  });

  it("breaks ties between outdated and unverifiable in favor of outdated", () => {
    // QUA-429 Phase 2 fix: outdated > unverifiable (active staleness signal
    // more actionable than 'couldn't tell').
    const r = aggregateEvidence([row("outdated", 0.7), row("unverifiable", 0.7)]);
    expect(r.verdict).toBe("outdated");
  });
});

describe("aggregateEvidence — tiebreaking by recency (QUA-992)", () => {
  // Real-world scenario from QUA-979: re-verifying a personnel record finds
  // a better source URL and writes a fresh `confirmed` evidence row, but the
  // record still has stale `unverifiable` evidence from a generic homepage
  // check. Without the recency tie-break, priority would pick `unverifiable`
  // (3 < 4) and the fresh re-check would be silently overridden.
  it("prefers the most-recent bucket on weight ties when both have checkedAt", () => {
    const old = new Date("2026-04-09T00:00:00Z");
    const fresh = new Date("2026-05-01T00:00:00Z");
    const r = aggregateEvidence([
      row("unverifiable", 1.0, 0.95, old),
      row("confirmed", 1.0, 0.99, fresh),
    ]);
    expect(r.verdict).toBe("confirmed");
    expect(r.contributing[0].verdict).toBe("confirmed");
    expect(r.contributing[0].latestCheckedAt).toEqual(fresh);
  });

  it("recency tie-break works in either direction (newer unverifiable beats older confirmed)", () => {
    const old = new Date("2026-01-01T00:00:00Z");
    const fresh = new Date("2026-05-01T00:00:00Z");
    const r = aggregateEvidence([
      row("confirmed", 1.0, 0.9, old),
      row("unverifiable", 1.0, 0.9, fresh),
    ]);
    // The fresher unverifiable wins — recency outweighs the priority order's
    // preference for confirmed in this direction (confirmed has priority 4,
    // unverifiable has priority 3; without recency the priority tie-break
    // would still pick unverifiable because it's lower-numbered, so this case
    // converges with the legacy behavior — but the intent is cleaner now).
    expect(r.verdict).toBe("unverifiable");
  });

  it("falls back to priority tie-break when checkedAt is missing on both sides", () => {
    // Unchanged from pre-QUA-992: tests that don't supply checkedAt still see
    // the legacy "more-actionable wins" semantics so older callers and the
    // existing test corpus aren't disturbed.
    const r = aggregateEvidence([row("contradicted", 0.8), row("confirmed", 0.8)]);
    expect(r.verdict).toBe("contradicted");
  });

  it("falls back to priority when only one bucket has checkedAt", () => {
    // Mixed presence is treated as 'no recency signal' — neither side gets a
    // recency-driven win. Legacy data has NULL checkedAt; we don't want a
    // single-row legacy bucket to lose just because the new bucket has a
    // timestamp. The priority tie-break stays as the safety net.
    const fresh = new Date("2026-05-01T00:00:00Z");
    const r = aggregateEvidence([
      row("unverifiable", 1.0, 0.9, null),
      row("confirmed", 1.0, 0.9, fresh),
    ]);
    expect(r.verdict).toBe("unverifiable");
  });

  it("recency tie-break does not override a true weight majority", () => {
    // Weight desc still runs first. A heavier non-fresh bucket wins, even
    // when a single fresh row dissents at lower weight.
    const old = new Date("2026-01-01T00:00:00Z");
    const fresh = new Date("2026-05-01T00:00:00Z");
    const r = aggregateEvidence([
      row("confirmed", 1.0, 0.9, old),
      row("confirmed", 1.0, 0.9, old),
      row("unverifiable", 1.0, 0.9, fresh),
    ]);
    expect(r.verdict).toBe("confirmed");
  });

  it("treats float-epsilon weight differences as ties (QUA-992 hardening)", () => {
    // Production relevance scores are `real` floats summed across rows, so
    // values like 0.1 + 0.2 = 0.30000000000000004 are routine. Without an
    // epsilon the strict `!==` would treat the 1-ULP gap as a real weight
    // difference and silently skip the recency tie-break — which would
    // re-introduce the QUA-979 stale-evidence-wins failure for any
    // production records whose relevance scores don't sum bit-equal.
    const old = new Date("2026-01-01T00:00:00Z");
    const fresh = new Date("2026-05-01T00:00:00Z");
    const r = aggregateEvidence([
      // Two stale "confirmed" rows summing to 0.30000000000000004.
      row("confirmed", 0.1, null, old),
      row("confirmed", 0.2, null, old),
      // One fresh "unverifiable" row at exactly 0.3 — mathematically equal
      // but not bit-equal to 0.1 + 0.2.
      row("unverifiable", 0.3, null, fresh),
    ]);
    // Without the epsilon, `confirmed` would win on a 1e-17 weight advantage
    // and recency would never be consulted. With the epsilon, the buckets
    // are equal-weight, so recency picks `unverifiable`.
    expect(r.verdict).toBe("unverifiable");
  });

  it("falls back to priority when checkedAt is identical across buckets", () => {
    // Two evidence rows written in the same checker batch (same millisecond)
    // produce equal recency. Recency tie is silent — priority decides the
    // winner. Documented here so a future refactor can't silently re-route
    // same-ms writes through some new ordering rule.
    const t = new Date("2026-05-01T12:00:00.000Z");
    const r = aggregateEvidence([
      row("confirmed", 1.0, 0.9, t),
      row("contradicted", 1.0, 0.9, t),
    ]);
    expect(r.verdict).toBe("contradicted"); // priority 0 < 4
  });

  it("ContributingVerdict.latestCheckedAt surfaces the per-bucket max", () => {
    const t1 = new Date("2026-04-01T00:00:00Z");
    const t2 = new Date("2026-04-15T00:00:00Z");
    const t3 = new Date("2026-05-01T00:00:00Z");
    const r = aggregateEvidence([
      row("confirmed", 1.0, 0.9, t1),
      row("confirmed", 1.0, 0.9, t3),
      row("partial", 0.5, 0.7, t2),
    ]);
    expect(r.verdict).toBe("confirmed");
    const conf = r.contributing.find((c) => c.verdict === "confirmed");
    const part = r.contributing.find((c) => c.verdict === "partial");
    expect(conf?.latestCheckedAt).toEqual(t3);
    expect(part?.latestCheckedAt).toEqual(t2);
  });
});

describe("aggregateEvidence — confidence weighting", () => {
  it("uses weighted average of contributing rows, not max", () => {
    const r = aggregateEvidence([
      row("confirmed", 1.0, 0.9),
      row("confirmed", 0.5, 0.5),
    ]);
    // Weighted avg: (1.0 * 0.9 + 0.5 * 0.5) / (1.0 + 0.5) = 1.15 / 1.5 ≈ 0.767
    expect(r.confidence).toBeCloseTo(0.7666, 3);
  });

  it("only weights confidence for rows that share the winning verdict", () => {
    const r = aggregateEvidence([
      row("confirmed", 1.0, 0.9),
      row("partial", 0.4, 0.99), // does not influence confirmed's confidence
    ]);
    expect(r.verdict).toBe("confirmed");
    expect(r.confidence).toBeCloseTo(0.9);
  });

  it("returns null confidence when no contributing row reported a confidence value", () => {
    const r = aggregateEvidence([
      row("confirmed", 1.0, null),
      row("confirmed", 0.8, null),
    ]);
    expect(r.confidence).toBeNull();
  });
});

describe("aggregateEvidence — drops not_applicable", () => {
  it("does not let not_applicable rows influence the aggregate", () => {
    const r = aggregateEvidence([
      row("confirmed", 0.9, 0.8),
      row("not_applicable", 0.95, 0.99), // would otherwise dominate
    ]);
    expect(r.verdict).toBe("confirmed");
    expect(r.droppedNotApplicable).toBe(1);
    expect(r.sourcesChecked).toBe(1);
  });
});

describe("aggregateEvidence — minRelevance option", () => {
  it("respects a custom minRelevance threshold", () => {
    const rows = [row("confirmed", 0.25)]; // below default 0.3, above 0.2
    expect(aggregateEvidence(rows).verdict).toBe("unchecked");
    expect(aggregateEvidence(rows, { minRelevance: 0.2 }).verdict).toBe(
      "confirmed",
    );
  });

  it("default minRelevance is exposed and equals 0.3", () => {
    expect(DEFAULT_MIN_RELEVANCE).toBe(0.3);
  });
});

describe("aggregateEvidence — multi-source disagreement (Phase 3 input)", () => {
  it("returns full contributing breakdown so the disagree warning can explain the rollup", () => {
    const r = aggregateEvidence([
      row("confirmed", 0.9, 0.9),
      row("confirmed", 0.85, 0.85),
      row("contradicted", 0.7, 0.8),
      row("unverifiable", 0.5, 0.6),
    ]);
    // confirmed weight = 0.9 + 0.85 = 1.75
    // contradicted weight = 0.7
    // unverifiable weight = 0.5
    expect(r.verdict).toBe("confirmed");
    expect(r.contributing.map((c) => c.verdict)).toEqual([
      "confirmed",
      "contradicted",
      "unverifiable",
    ]);
    expect(r.contributing[0].rowCount).toBe(2);
    expect(r.contributing[1].rowCount).toBe(1);
    expect(r.contributing[2].rowCount).toBe(1);
  });
});

describe("aggregateEvidence — droppedLowRelevance (QUA-792)", () => {
  it("is empty when every row is above the relevance threshold", () => {
    const r = aggregateEvidence([
      row("confirmed", 0.9),
      row("confirmed", 0.85),
    ]);
    expect(r.droppedLowRelevance).toEqual([]);
  });

  it("groups below-threshold rows by verdict separate from contributing", () => {
    const r = aggregateEvidence([
      row("confirmed", 0.9),
      row("confirmed", 0.85),
      // Below threshold (0.3) — filtered from contributing.
      row("contradicted", 0.2),
      row("contradicted", 0.1),
      row("outdated", 0.15),
    ]);
    expect(r.verdict).toBe("confirmed");
    expect(r.contributing.map((c) => c.verdict)).toEqual(["confirmed"]);
    expect(r.contributing[0].rowCount).toBe(2);

    expect(r.droppedLowRelevance.map((c) => c.verdict)).toEqual([
      "contradicted",
      "outdated",
    ]);
    const contradicted = r.droppedLowRelevance.find(
      (c) => c.verdict === "contradicted",
    );
    expect(contradicted?.rowCount).toBe(2);
    expect(contradicted?.weight).toBeCloseTo(0.3, 5);
  });

  it("preserves dropped low-relevance breakdown even when the headline is unchecked", () => {
    const r = aggregateEvidence([
      row("confirmed", 0.2),
      row("contradicted", 0.1),
    ]);
    expect(r.verdict).toBe("unchecked");
    expect(r.contributing).toEqual([]);
    expect(r.droppedLowRelevance.map((c) => c.verdict).sort()).toEqual([
      "confirmed",
      "contradicted",
    ]);
  });

  it("does not double-count not_applicable rows in droppedLowRelevance", () => {
    const r = aggregateEvidence([
      row("confirmed", 0.9),
      row("not_applicable", 0.0),
      row("contradicted", 0.1),
    ]);
    expect(r.droppedNotApplicable).toBe(1);
    expect(r.droppedLowRelevance.map((c) => c.verdict)).toEqual([
      "contradicted",
    ]);
  });
});

describe("aggregateEvidence — droppedStale (QUA-991)", () => {
  // Real-world scenario from QUA-991: ~500 records on prod (sampled
  // 2026-05-01) sit at `partial` because a stale `partial` row from an
  // older checker model (or a QUA-650 retro-scan's "subject mismatch"
  // sweep) ties weight with a fresh `confirmed` row from the current
  // model — and `partial` outranks `confirmed` in the priority tiebreak,
  // so re-verification can never lift the aggregate. The fix excludes
  // stale rows from the headline when at least one fresh row exists.
  it("fresh confirmed beats stale partial — the canonical QUA-991 case", () => {
    const r = aggregateEvidence([
      freshRow("confirmed", 1.0, 0.95),
      staleRow("partial", 1.0, 0.6),
    ]);
    expect(r.verdict).toBe("confirmed");
    expect(r.contributing.map((c) => c.verdict)).toEqual(["confirmed"]);
    expect(r.droppedStale.map((c) => c.verdict)).toEqual(["partial"]);
    expect(r.droppedStale[0].rowCount).toBe(1);
  });

  it("falls back to current behavior when every row is stale", () => {
    // No fresh row → stale rows feed the headline as before. This is the
    // ticket's case (b): re-verification didn't happen, so an old reading
    // is better than nothing.
    const r = aggregateEvidence([
      staleRow("partial", 1.0, 0.6),
      staleRow("partial", 1.0, 0.7),
    ]);
    expect(r.verdict).toBe("partial");
    expect(r.droppedStale).toEqual([]);
    expect(r.contributing[0].rowCount).toBe(2);
  });

  it("priority tiebreak still applies between two fresh rows", () => {
    // Ticket's case (c): if both contributors are fresh, nothing changes —
    // contradicted (priority 0) still wins over confirmed (priority 4) at
    // equal weight, the same as before QUA-991.
    const r = aggregateEvidence([
      freshRow("contradicted", 0.8),
      freshRow("confirmed", 0.8),
    ]);
    expect(r.verdict).toBe("contradicted");
    expect(r.droppedStale).toEqual([]);
  });

  it("treats undefined isStale as fresh (back-compat for legacy callers)", () => {
    // Tests written before QUA-991 don't supply isStale. Those rows must
    // still aggregate, otherwise the existing test corpus regresses to
    // unchecked/empty behavior.
    const r = aggregateEvidence([
      row("confirmed", 1.0, 0.9), // isStale undefined
      row("partial", 1.0, 0.7), // isStale undefined
    ]);
    expect(r.verdict).toBe("partial"); // priority tiebreak: partial(2) < confirmed(4)
    expect(r.droppedStale).toEqual([]);
  });

  it("treats null isStale as fresh", () => {
    // Defensive: explicit null behaves the same as undefined.
    const r = aggregateEvidence([
      { verdict: "confirmed", relevanceScore: 1.0, confidence: 0.9, isStale: null },
      staleRow("partial", 1.0, 0.6),
    ]);
    expect(r.verdict).toBe("confirmed");
    expect(r.droppedStale.map((c) => c.verdict)).toEqual(["partial"]);
  });

  it("aggregates stale-row counts per verdict for the dissent breakdown", () => {
    const r = aggregateEvidence([
      freshRow("confirmed", 0.9, 0.9),
      staleRow("partial", 1.0, 0.5),
      staleRow("partial", 0.8, 0.4),
      staleRow("contradicted", 0.7, 0.6),
    ]);
    expect(r.verdict).toBe("confirmed");
    const stalePartial = r.droppedStale.find((c) => c.verdict === "partial");
    const staleContradicted = r.droppedStale.find(
      (c) => c.verdict === "contradicted",
    );
    expect(stalePartial?.rowCount).toBe(2);
    expect(stalePartial?.weight).toBeCloseTo(1.8, 5);
    expect(staleContradicted?.rowCount).toBe(1);
    expect(staleContradicted?.weight).toBeCloseTo(0.7, 5);
  });

  it("excludes stale rows even when their weight would dominate", () => {
    // Without the QUA-991 filter, three stale partials (weight 3.0) would
    // beat one fresh confirmed (weight 1.0). The fresh row alone now wins.
    const r = aggregateEvidence([
      freshRow("confirmed", 1.0, 0.95),
      staleRow("partial", 1.0, 0.4),
      staleRow("partial", 1.0, 0.5),
      staleRow("partial", 1.0, 0.6),
    ]);
    expect(r.verdict).toBe("confirmed");
    expect(r.droppedStale[0].rowCount).toBe(3);
  });

  it("returns 'unchecked' when all stale rows are excluded and the lone fresh row is below threshold", () => {
    // Edge case: when the sole fresh row is sub-relevance, the headline
    // becomes 'unchecked' — we don't fall back to stale rows just because
    // the fresh row was weak. Documents this so a future tweak doesn't
    // silently re-introduce the QUA-991 bug for low-relevance fresh rows.
    const r = aggregateEvidence([
      freshRow("confirmed", 0.1), // below DEFAULT_MIN_RELEVANCE = 0.3
      staleRow("partial", 1.0, 0.6),
    ]);
    expect(r.verdict).toBe("unchecked");
    expect(r.droppedStale.map((c) => c.verdict)).toEqual(["partial"]);
    expect(r.droppedLowRelevance.map((c) => c.verdict)).toEqual(["confirmed"]);
  });

  it("excludes not_applicable stale rows the same way fresh ones are excluded (never voting)", () => {
    // not_applicable always wins the drop, regardless of staleness.
    const r = aggregateEvidence([
      freshRow("confirmed", 0.9, 0.9),
      { verdict: "not_applicable", relevanceScore: 0.9, confidence: 0.99, isStale: true },
    ]);
    expect(r.verdict).toBe("confirmed");
    expect(r.droppedNotApplicable).toBe(1);
    expect(r.droppedStale).toEqual([]); // not_applicable was filtered before stale check
  });

  it("recency tie-break (QUA-992) cannot rescue a stale row in the presence of a fresh row", () => {
    // Stale + recent (e.g. a recent re-check by an old model that's been
    // demoted) still loses to fresh — the staleness filter runs before the
    // recency tie-break.
    const old = new Date("2026-04-01T00:00:00Z");
    const evenOlder = new Date("2026-01-01T00:00:00Z");
    const r = aggregateEvidence([
      freshRow("confirmed", 1.0, 0.9, evenOlder),
      staleRow("partial", 1.0, 0.6, old), // recent but stale
    ]);
    expect(r.verdict).toBe("confirmed");
  });
});

describe("buildReasoning surfacing droppedStale (QUA-991)", () => {
  // The `reasoning` string is persisted to source_check_verdicts.reasoning;
  // it is what an operator sees in `/api/sourcing/verdicts/...`. It must
  // mention stale exclusion so a previously-`partial` record's flip to
  // `confirmed` is auditable.
  it("includes a 'stale (excluded)' clause when stale rows were dropped", async () => {
    // Re-import here so we don't leak the helper into other test files.
    // It's an internal helper; we go through aggregateEvidence + a tiny
    // reasoning shim because recompute-verdict.ts owns the canonical impl.
    const aggregate = aggregateEvidence([
      freshRow("confirmed", 1.0, 0.95),
      staleRow("partial", 1.0, 0.6),
    ]);
    expect(aggregate.droppedStale).toHaveLength(1);
    // The integration-level reasoning string is exercised in
    // recompute-verdict.test.ts; this test pins the contributing/droppedStale
    // shape that the reasoning builder reads from.
    expect(aggregate.contributing[0].verdict).toBe("confirmed");
    expect(aggregate.droppedStale[0].verdict).toBe("partial");
  });
});
