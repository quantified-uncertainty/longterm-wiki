/**
 * Canonical source-check verdict aggregation (QUA-791 Phase 1).
 *
 * Single source of truth for collapsing per-source `source_check_evidence`
 * rows into one `source_check_verdicts` row. Every code path that wants
 * to derive an aggregate verdict from raw evidence MUST go through
 * `aggregateEvidence()` here. Do not inline ad-hoc aggregation.
 *
 * The pre-Phase-1 behavior was last-writer-wins on `POST /verdicts`:
 * each evidence-writer call passed its own per-source verdict with
 * `sourcesChecked: 1`, and whoever wrote last set the aggregate. This
 * function replaces that with relevance-weighted aggregation that reads
 * the actual evidence rows.
 *
 * The priority ladder (`SOURCE_CHECK_VERDICT_PRIORITY`) lives in the
 * frontend `verdict-styles.ts`; we duplicate the same numeric ordering
 * here so the wiki-server doesn't depend on `apps/web`. Any change to
 * the ladder must be mirrored — the QUA-429 Phase 2 gate validator
 * `validate-verdict-priority` enforces that no other priority maps
 * exist outside these two files.
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
 *   3. If every remaining row has `effectiveWeight < minRelevance`,
 *      return `unchecked` — we have looked but nothing is relevant
 *      enough to draw a conclusion.
 *   4. Compute a weighted score per non-`unchecked` verdict bucket.
 *      Score for verdict V is `sum(effectiveWeight(row) for row.verdict = V)`.
 *   5. Pick the verdict with the highest weighted score. Ties broken by
 *      `SOURCE_CHECK_VERDICT_PRIORITY` (more-actionable wins).
 *   6. Confidence: weighted average of `confidence × effectiveWeight`
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
      droppedNotApplicable: rows.length,
    };
  }

  const droppedNotApplicable = rows.length - considered.length;

  // Step 3: any row above the relevance threshold?
  const aboveThreshold = considered.filter(
    (r) => effectiveWeight(r) >= minRelevance,
  );
  if (aboveThreshold.length === 0) {
    return {
      verdict: "unchecked",
      confidence: null,
      sourcesChecked: considered.length,
      contributing: [],
      droppedNotApplicable,
    };
  }

  // Step 4: per-verdict aggregates in one pass. Only rows above the
  // threshold get to vote — otherwise low-relevance noise can swing
  // ties between high-relevance verdicts. By construction, every row
  // in `aboveThreshold` has verdict ∈ {confirmed, contradicted, outdated,
  // partial, unverifiable} — `not_applicable` was filtered in step 1
  // and `unchecked` is not a valid evidence verdict.
  //
  // Track confidence per bucket too (sum of `confidence × weight` and
  // sum of weights for rows that reported a confidence value). Rows
  // with NULL confidence are skipped from the average — they don't
  // drag it toward zero, but they don't elevate it either.
  interface Bucket {
    weight: number;
    rowCount: number;
    confidenceWeightedSum: number;
    confidenceWeightSum: number;
  }
  const buckets = new Map<AggregateVerdict, Bucket>();
  for (const row of aboveThreshold) {
    const verdict = row.verdict as AggregateVerdict;
    const w = effectiveWeight(row);
    let bucket = buckets.get(verdict);
    if (!bucket) {
      bucket = { weight: 0, rowCount: 0, confidenceWeightedSum: 0, confidenceWeightSum: 0 };
      buckets.set(verdict, bucket);
    }
    bucket.weight += w;
    bucket.rowCount += 1;
    if (w > 0 && typeof row.confidence === "number") {
      bucket.confidenceWeightedSum += row.confidence * w;
      bucket.confidenceWeightSum += w;
    }
  }
  if (buckets.size === 0) {
    return {
      verdict: "unchecked",
      confidence: null,
      sourcesChecked: considered.length,
      contributing: [],
      droppedNotApplicable,
    };
  }

  // Step 5: pick winner. Score desc, then priority asc.
  const ranked = [...buckets.entries()].sort((a, b) => {
    if (a[1].weight !== b[1].weight) return b[1].weight - a[1].weight;
    const aPri = SOURCE_CHECK_VERDICT_PRIORITY[a[0]] ?? 99;
    const bPri = SOURCE_CHECK_VERDICT_PRIORITY[b[0]] ?? 99;
    return aPri - bPri;
  });
  const winningVerdict = ranked[0][0];
  const winningBucket = ranked[0][1];

  // Step 6: confidence = weighted average of the winning bucket's rows
  // that reported a confidence value (computed in step 4).
  const confidence =
    winningBucket.confidenceWeightSum > 0
      ? winningBucket.confidenceWeightedSum / winningBucket.confidenceWeightSum
      : null;

  const contributing: ContributingVerdict[] = ranked.map(([verdict, b]) => ({
    verdict,
    weight: b.weight,
    rowCount: b.rowCount,
  }));

  return {
    verdict: winningVerdict,
    confidence,
    sourcesChecked: considered.length,
    contributing,
    droppedNotApplicable,
  };
}
