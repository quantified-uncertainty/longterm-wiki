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
