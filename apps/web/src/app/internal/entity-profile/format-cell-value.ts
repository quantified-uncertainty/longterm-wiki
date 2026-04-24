/**
 * Pure helpers for formatting cell values in the entity profile viewer's
 * Database tab. Extracted from entity-profile-viewer.tsx so they can be
 * unit-tested without pulling in the full client React tree.
 *
 * The render-audit e2e regression in QUA-673 caught two distinct paths where
 * bare 10+ digit numbers leaked onto `/organizations/:slug` (Database tab):
 *
 *   1. The `facts.value` column — a text column storing the serialized fact
 *      value. Numeric facts stringify to e.g. "70000000000"; the existing
 *      CellValue branches only formatted known currency columns.
 *   2. The `things.description` column — composed server-side. For rows
 *      synced before the composer fix, the stored description still contains
 *      the raw numeric literal (e.g. "Internal Revenue: 1700000000"). We
 *      rewrite these at render time so the Database tab heals without a
 *      full facts re-sync.
 */

import { formatCompactCurrency, formatCompactNumber } from "@/lib/format-compact";

/**
 * Pure numeric string (optionally signed, decimal, or in scientific
 * notation). Used to gate numeric coercion in the `value` cell renderer.
 */
export const PURE_NUMERIC_STRING_RE = /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

/**
 * Replace any bare 10+ digit run inside a display string with its compact
 * form (e.g. `"Internal Revenue: 1700000000"` → `"Internal Revenue: 1.7B"`).
 *
 * Skips runs that are embedded in word/number-adjacent context (e.g. a hash
 * like `abc1234567890def` stays untouched) and leaves small magnitudes alone
 * so ordinal / count strings aren't mangled.
 */
export function sanitizeRawLargeNumbers(s: string): string {
  return s.replace(/(?<![a-zA-Z_\d])(\d{10,})(?![a-zA-Z\d])/g, (m) => {
    const n = Number(m);
    if (!isFinite(n) || Math.abs(n) < 1000) return m;
    return formatCompactNumber(n);
  });
}

/**
 * If `value` (from the `facts.value` column) is a pure-numeric string whose
 * magnitude is ≥ 1000, return its compact-formatted form. Otherwise return
 * null so the caller falls through to the generic string renderer.
 *
 * When `currency` is provided (from the sibling `facts.currency` column) the
 * output includes the currency symbol (`"$1.7B"`, `"£1.3B"`).
 */
export function formatFactValueString(value: string, currency?: string | null): string | null {
  const trimmed = value.trim();
  if (!trimmed || !PURE_NUMERIC_STRING_RE.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!isFinite(n) || Math.abs(n) < 1000) return null;
  return currency ? formatCompactCurrency(n, currency) : formatCompactNumber(n);
}
