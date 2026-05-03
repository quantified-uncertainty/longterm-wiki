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
  /**
   * QUA-992: when supplied, breaks ties between equal-weight verdict
   * buckets in favor of the bucket whose latest evidence is most recent.
   * NULL is treated as "no recency signal" — falls through to the
   * priority tie-breaker below. Tests can omit it for back-compat.
   */
  checkedAt?: Date | null;
  /**
   * QUA-991: when true, the row was written by an older checker model
   * (or has no recorded model) and is excluded from the headline
   * aggregation if at least one fresh row is available. NULL/undefined
   * is treated as "not stale" so legacy callers and tests that don't
   * supply the field keep their old behavior.
   */
  isStale?: boolean | null;
}

export interface ContributingVerdict {
  verdict: AggregateVerdict;
  /** Sum of effective weights of rows with this verdict. */
  weight: number;
  /** Number of evidence rows that voted for this verdict. */
  rowCount: number;
  /**
   * QUA-992: most-recent `checkedAt` across the rows that voted for this
   * verdict. Used by the aggregation tie-breaker so a fresh re-check can
   * supersede stale evidence at equal weight. NULL when none of the rows
   * supplied a `checkedAt`.
   */
  latestCheckedAt?: Date | null;
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
  /**
   * Per-verdict counts of rows that were considered (not `not_applicable`)
   * but had `effectiveWeight < minRelevance` and so were filtered out
   * before bucketing. Surfaces low-relevance dissent so the
   * QUA-792 disagreement explainer can say "1 low-relevance source
   * contradicted (filtered)" instead of pretending those rows didn't exist.
   *
   * Empty when no row was below the threshold. The verdicts here can
   * overlap with `contributing` (e.g. one high-relevance + one
   * low-relevance row may both have `verdict = 'contradicted'`).
   */
  droppedLowRelevance: ContributingVerdict[];
  /**
   * QUA-991: per-verdict counts of rows that were excluded from the
   * headline because they were stale (`isStale=true`) AND at least one
   * fresh row was available. When all rows are stale, this is empty and
   * the stale rows feed the headline as before — i.e. stale evidence is
   * better than nothing. Surfaced for the QUA-792 explainer so a fresh
   * `confirmed` aggregate can still say "1 stale partial source dissented
   * (excluded)".
   */
  droppedStale: ContributingVerdict[];
  /** Count of `not_applicable` rows that were filtered out before aggregation. */
  droppedNotApplicable: number;
}
