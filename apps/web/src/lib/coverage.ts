/**
 * Re-export coverage helpers for frontend use.
 * The canonical implementation lives in crux/lib/page-coverage.ts.
 *
 * We re-implement the small helpers here rather than importing from crux/
 * because the Next.js tsconfig doesn't enable allowImportingTsExtensions.
 */

export type CoverageStatus = 'green' | 'amber' | 'red';

/** Status for a ratio metric (e.g., quotes verified / total citations) */
export function getRatioStatus(
  numerator: number,
  denominator: number,
): CoverageStatus {
  if (denominator === 0) return 'red';
  const pct = numerator / denominator;
  if (pct >= 0.75) return 'green';
  if (numerator > 0) return 'amber';
  return 'red';
}

/** Status for a numeric metric vs. its target */
export function getMetricStatus(actual: number, target?: number): CoverageStatus {
  if (target === undefined || target === 0) {
    return actual > 0 ? 'green' : 'red';
  }
  if (actual >= target) return 'green';
  if (actual > 0) return 'amber';
  return 'red';
}

/**
 * Entity types where canonical facts are scored. Limited to real-world entities
 * (people and organizations) where biographical/organizational facts are applicable.
 * Keep in sync with ENTITY_LIKE_TYPES in crux/lib/page-coverage.ts.
 */
export const ENTITY_LIKE_TYPES = new Set(['person', 'organization']);

/** Facts target threshold: pages with >= this many facts score green. */
export const FACTS_GREEN_THRESHOLD = 5;
