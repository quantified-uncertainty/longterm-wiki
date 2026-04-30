// Aggregate metrics for the multi-entity benchmark suite (QUA-873).
//
// The suite snapshot stores one entry per entity plus an aggregate roll-up so
// a single file is enough to compare two PRs without re-loading per-entity
// state. Aggregate fields:
//
//   median_coverage_score, p25_coverage_score
//   count_below_min, below_min_slugs
//
// "Below min" = coverage_score < expected_min_coverage (strict). expected_min
// is set in entity-suite.yaml per entity.

export interface SuiteEntityResult {
  slug: string;
  type: string;
  coverage_score: number;
  expected_min_coverage: number;
}

export interface SuiteAggregate {
  count: number;
  median_coverage_score: number;
  p25_coverage_score: number;
  count_below_min: number;
  below_min_slugs: string[];
}

/**
 * Linear interpolation percentile, matching numpy's default ("linear" method).
 * For p in [0, 1] and n samples, the rank is p*(n-1) and the value is the
 * weighted blend of the floor and ceil indices in the sorted sample.
 *
 * Behaviour at the edges:
 *   - empty input → 0 (callers should treat this as "no data")
 *   - n=1         → the single value
 *   - p<=0        → min
 *   - p>=1        → max
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  if (values.length === 1) return values[0];
  const sorted = [...values].sort((a, b) => a - b);
  const clamped = Math.min(1, Math.max(0, p));
  const rank = clamped * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/** Median = 50th percentile under the same linear-interpolation rule. */
export function median(values: number[]): number {
  return percentile(values, 0.5);
}

/** Compute the suite-level aggregate from per-entity results. */
export function computeAggregate(results: SuiteEntityResult[]): SuiteAggregate {
  const scores = results.map((r) => r.coverage_score);
  const below = results.filter((r) => r.coverage_score < r.expected_min_coverage);
  return {
    count: results.length,
    median_coverage_score: round2(median(scores)),
    p25_coverage_score: round2(percentile(scores, 0.25)),
    count_below_min: below.length,
    below_min_slugs: below.map((r) => r.slug),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
