/**
 * Canonical sourcing verdict aggregation.
 *
 * Single source of truth for collapsing per-source `source_check_evidence`
 * rows into one `source_check_verdicts` row. Every code path that derives
 * an aggregate verdict from raw evidence MUST go through `aggregateEvidence()`.
 *
 * `SOURCE_CHECK_VERDICT_PRIORITY` mirrors the canonical ladder in
 * `apps/web/src/components/shared/verdict-styles.ts`; the wiki-server
 * cannot import from apps/web, so the constant is duplicated. The
 * `validate-verdict-priority` gate validator allowlists both files and
 * blocks any third declaration.
 */

import type {
  EvidenceRow,
  AggregateVerdict,
  AggregationResult,
  ContributingVerdict,
} from "./sourcing-aggregation-types.js";

export type {
  EvidenceRow,
  AggregateVerdict,
  AggregationResult,
  ContributingVerdict,
} from "./sourcing-aggregation-types.js";

/**
 * Canonical priority order: most-actionable first (lowest number = highest priority).
 *
 * Mirrors `SOURCE_CHECK_VERDICT_PRIORITY` in
 * `apps/web/src/components/shared/verdict-styles.ts`. Keep in sync.
 *
 * `unchecked` is included as the terminal state (no evidence at all)
 * but is not produced by aggregation of evidence rows — only when there
 * are zero contributing rows after filtering.
 */
export const SOURCE_CHECK_VERDICT_PRIORITY: Record<AggregateVerdict, number> = {
  contradicted: 0,
  outdated: 1,
  partial: 2,
  unverifiable: 3,
  confirmed: 4,
  unchecked: 5,
};

/**
 * Below this relevance threshold, an evidence row contributes to
 * aggregation but cannot single-handedly establish a non-`unchecked`
 * verdict — i.e. if every row falls below the threshold, the aggregate
 * is `unchecked`. Default 0.3 mirrors the relevance-gate's heuristic:
 * pages a human would call "tangentially related" have scores around
 * 0.3–0.5; bare-domain mismatches score 0.0–0.2.
 */
export const DEFAULT_MIN_RELEVANCE = 0.3;

/**
 * Resolve an evidence row's effective weight.
 *
 * NULL `relevance_score` is treated as 1.0 (full weight) so legacy rows
 * written before QUA-791 don't disappear from aggregation. Out-of-range
 * scores are clamped to [0, 1] defensively.
 */
function effectiveWeight(row: EvidenceRow): number {
  const raw = row.relevanceScore ?? 1.0;
  if (Number.isNaN(raw)) return 0;
  if (raw < 0) return 0;
  if (raw > 1) return 1;
  return raw;
}

interface AggregateOptions {
  minRelevance?: number;
}

interface Bucket {
  weight: number;
  rowCount: number;
  /** Sum of `confidence × weight` for rows that reported a confidence. */
  confidenceWeightedSum: number;
  /** Sum of weights for the same rows (used as the denominator). */
  confidenceWeightSum: number;
  /**
   * QUA-992: max `checkedAt` across rows in this bucket. NULL when no row
   * supplied a `checkedAt`. Drives the recency tie-breaker.
   */
  latestCheckedAt: Date | null;
}

/**
 * Aggregate a set of evidence rows for a single
 * `(record_type, record_id, field_name)` key into one verdict.
 *
 * Algorithm:
 *
 *   1. Drop rows with `verdict = 'not_applicable'` entirely. These come
 *      from the QUA-426 relevance gate and signal "this source is not
 *      about the subject — don't even count it." They contribute nothing.
 *   2. If no rows remain after step 1, return `unchecked`.
 *   3. QUA-991: if at least one fresh row (`isStale != true`) is present,
 *      drop stale rows from the headline aggregation entirely (surfaced
 *      separately as `droppedStale` for the dissent explainer). When all
 *      remaining rows are stale, fall through to current behavior — stale
 *      evidence is better than nothing.
 *   4. If every remaining row has `effectiveWeight < minRelevance`,
 *      return `unchecked` — we have looked but nothing is relevant
 *      enough to draw a conclusion.
 *   5. Compute a weighted score per non-`unchecked` verdict bucket.
 *      Score for verdict V is `sum(effectiveWeight(row) for row.verdict = V)`.
 *   6. Pick the verdict with the highest weighted score. Ties broken by
 *      `SOURCE_CHECK_VERDICT_PRIORITY` (more-actionable wins).
 *   7. Confidence: weighted average of `confidence × effectiveWeight`
 *      across all *contributing* rows (rows with the winning verdict),
 *      not the max. Reflects how strongly the contributors agreed, not
 *      just whether one source was certain.
 *
 * The function is pure and synchronous — DB I/O happens in the caller.
 */
export function aggregateEvidence(
  rows: readonly EvidenceRow[],
  options: AggregateOptions = {},
): AggregationResult {
  const minRelevance = options.minRelevance ?? DEFAULT_MIN_RELEVANCE;

  const considered = rows.filter((r) => r.verdict !== "not_applicable");
  if (considered.length === 0) {
    return {
      verdict: "unchecked",
      confidence: null,
      sourcesChecked: 0,
      contributing: [],
      droppedLowRelevance: [],
      droppedStale: [],
      droppedNotApplicable: rows.length,
    };
  }

  const droppedNotApplicable = rows.length - considered.length;

  // QUA-991: if there is at least one fresh row, drop stale rows from
  // headline aggregation. Stale rows still surface separately so the
  // dissent explainer can say "1 stale partial source excluded". When
  // every remaining row is stale, fall through to current behavior —
  // an old reading is better than no reading at all.
  const freshRows = considered.filter((r) => r.isStale !== true);
  let aggregable: EvidenceRow[];
  let droppedStale: ContributingVerdict[];
  if (freshRows.length > 0 && freshRows.length < considered.length) {
    aggregable = freshRows;
    const staleBuckets = new Map<AggregateVerdict, ContributingVerdict>();
    for (const r of considered) {
      if (r.isStale !== true) continue;
      const v = r.verdict as AggregateVerdict;
      const w = effectiveWeight(r);
      const existing = staleBuckets.get(v);
      if (existing) {
        existing.weight += w;
        existing.rowCount += 1;
      } else {
        staleBuckets.set(v, { verdict: v, weight: w, rowCount: 1 });
      }
    }
    droppedStale = sortContributing([...staleBuckets.values()]);
  } else {
    aggregable = considered;
    droppedStale = [];
  }

  // Step 4: split into above/below threshold. Below-threshold rows are
  // filtered out from the headline but their per-verdict counts are
  // surfaced separately so QUA-792's explainer can mention low-relevance
  // dissent. Operates on `aggregable` so dropped-stale rows don't appear
  // in `droppedLowRelevance` (they're already in `droppedStale`).
  const aboveThreshold: EvidenceRow[] = [];
  const belowThresholdBuckets = new Map<AggregateVerdict, ContributingVerdict>();
  for (const r of aggregable) {
    const w = effectiveWeight(r);
    if (w >= minRelevance) {
      aboveThreshold.push(r);
      continue;
    }
    const v = r.verdict as AggregateVerdict;
    const existing = belowThresholdBuckets.get(v);
    if (existing) {
      existing.weight += w;
      existing.rowCount += 1;
    } else {
      belowThresholdBuckets.set(v, { verdict: v, weight: w, rowCount: 1 });
    }
  }
  const droppedLowRelevance = sortContributing([...belowThresholdBuckets.values()]);

  if (aboveThreshold.length === 0) {
    return {
      verdict: "unchecked",
      confidence: null,
      sourcesChecked: considered.length,
      contributing: [],
      droppedLowRelevance,
      droppedStale,
      droppedNotApplicable,
    };
  }

  // Step 5: per-verdict aggregates in one pass. Only rows above the
  // threshold get to vote — low-relevance noise shouldn't swing ties.
  // Rows with NULL confidence are skipped from the confidence average
  // (don't drag it down, don't elevate it).
  const buckets = new Map<AggregateVerdict, Bucket>();
  for (const row of aboveThreshold) {
    const verdict = row.verdict as AggregateVerdict;
    const w = effectiveWeight(row);
    let bucket = buckets.get(verdict);
    if (!bucket) {
      bucket = {
        weight: 0,
        rowCount: 0,
        confidenceWeightedSum: 0,
        confidenceWeightSum: 0,
        latestCheckedAt: null,
      };
      buckets.set(verdict, bucket);
    }
    bucket.weight += w;
    bucket.rowCount += 1;
    if (typeof row.confidence === "number") {
      bucket.confidenceWeightedSum += row.confidence * w;
      bucket.confidenceWeightSum += w;
    }
    if (row.checkedAt) {
      if (!bucket.latestCheckedAt || row.checkedAt > bucket.latestCheckedAt) {
        bucket.latestCheckedAt = row.checkedAt;
      }
    }
  }
  if (buckets.size === 0) {
    return {
      verdict: "unchecked",
      confidence: null,
      sourcesChecked: considered.length,
      contributing: [],
      droppedLowRelevance,
      droppedStale,
      droppedNotApplicable,
    };
  }

  // Step 6: pick winner. Score desc, then recency desc (QUA-992), then priority asc.
  const contributing = sortContributing(
    [...buckets.entries()].map(([verdict, b]) => ({
      verdict,
      weight: b.weight,
      rowCount: b.rowCount,
      latestCheckedAt: b.latestCheckedAt,
    })),
  );
  const winningVerdict = contributing[0].verdict;
  const winningBucket = buckets.get(winningVerdict)!;

  // Step 7: confidence = weighted average of the winning bucket's rows
  // that reported a confidence value (computed in step 5).
  const confidence =
    winningBucket.confidenceWeightSum > 0
      ? winningBucket.confidenceWeightedSum / winningBucket.confidenceWeightSum
      : null;

  return {
    verdict: winningVerdict,
    confidence,
    sourcesChecked: considered.length,
    contributing,
    droppedLowRelevance,
    droppedStale,
    droppedNotApplicable,
  };
}

/**
 * Float-tolerance for weight equality (QUA-992). Production weights come
 * from the `relevance_score real` PG column and end up summed across rows,
 * so values like `0.1 + 0.2 = 0.30000000000000004` are routine. Without an
 * epsilon, a 1-ULP gap defeats `weight !== weight` and silently bypasses
 * the recency tie-break — exactly the QUA-979 failure mode this fix is
 * supposed to close. 1e-9 is well below any real relevance signal (`real`
 * is single-precision, ~7 decimal digits) and well above representation
 * noise from typical `0.x + 0.y` sums.
 */
const WEIGHT_EQUALITY_EPSILON = 1e-9;

/**
 * Sort contributing buckets by weight desc, ties broken by recency desc
 * (QUA-992) — a fresh re-check should supersede stale evidence at equal
 * weight. Final tie-break is `SOURCE_CHECK_VERDICT_PRIORITY` (more-actionable
 * wins) for callers that don't supply `checkedAt` (e.g. legacy tests, or
 * legitimately concurrent checks).
 */
function sortContributing(items: ContributingVerdict[]): ContributingVerdict[] {
  return [...items].sort((a, b) => {
    const weightDiff = b.weight - a.weight;
    if (Math.abs(weightDiff) > WEIGHT_EQUALITY_EPSILON) return weightDiff;
    const at = a.latestCheckedAt?.getTime() ?? null;
    const bt = b.latestCheckedAt?.getTime() ?? null;
    if (at !== null && bt !== null && at !== bt) return bt - at;
    const aPri = SOURCE_CHECK_VERDICT_PRIORITY[a.verdict] ?? 99;
    const bPri = SOURCE_CHECK_VERDICT_PRIORITY[b.verdict] ?? 99;
    return aPri - bPri;
  });
}
