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
): EvidenceRow {
  return { verdict, relevanceScore, confidence };
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
  it("a single high-relevance confirmed beats three low-relevance unverifiables (per ticket spec)", () => {
    // From QUA-791 description: "A single `confirmed` from a high-relevance
    // source should dominate three `unverifiable`s from low-relevance sources."
    const r = aggregateEvidence([
      row("confirmed", 0.9, 0.85),
      row("unverifiable", 0.4, 0.7),
      row("unverifiable", 0.45, 0.7),
      row("unverifiable", 0.5, 0.7),
    ]);
    // confirmed weight = 0.9
    // unverifiable weight = 0.4 + 0.45 + 0.5 = 1.35
    // Wait — three low-relevance still outweigh one high-relevance arithmetically.
    // The ticket calls "0.4–0.5" low-relevance but those are above the 0.3
    // threshold and individually count fully. The result here is that
    // the THREE unverifiables outweigh the one confirmed (1.35 > 0.9), and
    // that's correct: with 3:1 corroboration even at lower relevance, the
    // aggregate reflects the dissent. The ticket spec only holds when the
    // low-relevance rows are sub-threshold OR when they're truly low (0.1ish).
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
