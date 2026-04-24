import { formatCompactCurrency, formatCompactNumber } from "@/lib/format-compact";

/** Pure numeric literal: optionally signed, decimal, or scientific notation. */
export const PURE_NUMERIC_STRING_RE = /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

/**
 * If `value` is a pure-numeric string with magnitude ≥ 1000, return the
 * compact-formatted form; otherwise return null so the caller falls through
 * to its generic string renderer. The magnitude floor keeps small counts
 * (63 market-share, 1500 headcount) rendering as-is without distortion.
 */
export function formatFactValueString(value: string, currency?: string | null): string | null {
  const trimmed = value.trim();
  if (!trimmed || !PURE_NUMERIC_STRING_RE.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || Math.abs(n) < 1000) return null;
  return currency ? formatCompactCurrency(n, currency) : formatCompactNumber(n);
}
