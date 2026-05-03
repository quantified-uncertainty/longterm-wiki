/**
 * Tiny stats primitives shared across the crux/ codebase. Extracted from
 * the duplicates that previously lived in `research-improve-entity-suite.ts`,
 * `research-benchmark-suite.ts`, and `research/inspect.ts` (QUA-1034 review).
 *
 * All functions are pure and operate on `number[]`. Empty input returns 0
 * (NOT null) to match the historical behavior of the suite-level callers,
 * which display these values directly in CLI output where `0` is harmless
 * but `null` would require every call site to re-implement the empty guard.
 */

/** Median via linear interpolation between adjacent samples. */
export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = (sorted.length - 1) / 2;
  return (sorted[Math.floor(mid)] + sorted[Math.ceil(mid)]) / 2;
}

/**
 * 25th-percentile via the standard linear-interpolation method
 * (the same R-7 / NumPy default behavior).
 */
export function p25(xs: number[]): number {
  if (xs.length === 0) return 0;
  if (xs.length === 1) return xs[0];
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * 0.25;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}
