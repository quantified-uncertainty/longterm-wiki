/**
 * Shared types for sourcing verdict aggregation (QUA-791).
 *
 * Lives in a separate file from the aggregation logic so consumers
 * (route, tests, callers) can import the types without pulling the
 * full computation module.
 */

/**
 * Verdict states that an evidence row can carry.
 *
 * `not_applicable` is excluded — it's a relevance-gate signal that the
 * source is not about the subject, and the aggregation drops those rows
 * entirely. By the time `aggregateEvidence` returns, the verdict is
 * always one of `AggregateVerdict`.
 */
export type EvidenceVerdict =
  | "confirmed"
  | "contradicted"
  | "outdated"
  | "partial"
  | "unverifiable"
  | "not_applicable";

/**
 * Verdict states that an aggregate row in `source_check_verdicts` can hold.
 *
 * Includes `unchecked` (the terminal state — no evidence rows at all,
 * or every row was below the relevance threshold). Excludes
 * `not_applicable` (per-source signal, never aggregated).
 */
export type AggregateVerdict =
  | "confirmed"
  | "contradicted"
  | "outdated"
  | "partial"
  | "unverifiable"
  | "unchecked";

/**
 * Subset of `source_check_evidence` columns that the aggregation reads.
 * The route handler maps DB rows to this shape; tests pass plain objects.
 */
export interface EvidenceRow {
  verdict: EvidenceVerdict;
  /** 0..1, NULL treated as 1.0 (full weight) for legacy rows. */
  relevanceScore: number | null;
  /** 0..1, NULL means "no confidence reported"; ignored in the average. */
  confidence: number | null;
}

export interface ContributingVerdict {
  verdict: AggregateVerdict;
  /** Sum of effective weights of rows with this verdict. */
  weight: number;
  /** Number of evidence rows that voted for this verdict. */
  rowCount: number;
}

export interface AggregationResult {
  verdict: AggregateVerdict;
  /** Weighted average of contributors' `confidence × weight`, or null. */
  confidence: number | null;
  /** Count of rows that participated (post-`not_applicable` filter). */
  sourcesChecked: number;
  /**
   * All non-zero buckets ranked. The first entry is the winner;
   * subsequent entries explain the dissent. Empty when the aggregate
   * is `unchecked`.
   */
  contributing: ContributingVerdict[];
  /** Count of `not_applicable` rows that were filtered out before aggregation. */
  droppedNotApplicable: number;
}
