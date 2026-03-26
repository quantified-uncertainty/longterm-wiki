/**
 * Canonical stableId detection patterns.
 *
 * StableIds are exactly 10 alphanumeric characters [A-Za-z0-9] with at least
 * one uppercase letter. The uppercase requirement prevents false positives on
 * short lowercase slugs like "bioweapons" or "conjecture".
 *
 * IMPORTANT: StableIds never contain `-` or `_`. If you encounter one that does,
 * it's a legacy artifact from a bug in crux/lib/grant-import/id.ts (fixed 2026-03-26).
 * Migration 0141 normalized all existing contaminated IDs.
 */

/** Matches stableIds: exactly 10 alphanumeric chars with at least one uppercase letter. */
export const STABLE_ID_PATTERN = /^(?=.*[A-Z])[A-Za-z0-9]{10}$/;

/** Matches pure numeric IDs (legacy database PKs like "175", "335"). */
export const NUMERIC_ID_PATTERN = /^\d+$/;

/** Check if a string looks like a stableId (strict: requires uppercase). */
export function isStableId(s: string): boolean {
  return STABLE_ID_PATTERN.test(s);
}

/**
 * Check if a string is any 10-char alphanumeric ID (relaxed: no uppercase requirement).
 * Use this for ID lookup/routing contexts where all-lowercase stableIds must also match.
 * Use `isStableId()` for display contexts where you need to distinguish IDs from slugs.
 */
export function isAlphanumeric10(s: string): boolean {
  return /^[A-Za-z0-9]{10}$/.test(s);
}

/** Check if a string is a bare machine ID (stableId or numeric PK) that should never be displayed. */
export function isBareMachineId(s: string): boolean {
  return isAlphanumeric10(s) || NUMERIC_ID_PATTERN.test(s);
}
