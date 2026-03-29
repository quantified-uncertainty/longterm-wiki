/**
 * Canonical stableId detection — thin re-export from @longterm-wiki/id-utils.
 *
<<<<<<< HEAD
 * This module re-exports the shared ID utilities and adds app-specific helpers
 * (isContaminatedStableId, isBareMachineId) that aren't needed in the core package.
 */

export {
  isSid,
  isDisplayableName,
  isAnySid,
  isLegacyStableId,
  STABLE_ID_PATTERN,
  NUMERIC_ID_PATTERN,
} from "@longterm-wiki/id-utils";

import { NUMERIC_ID_PATTERN } from "@longterm-wiki/id-utils";

/** Check if a string looks like a stableId (strict: requires uppercase). */
export function isStableId(s: string): boolean {
  // Delegates to the legacy pattern which requires uppercase
  return /^(?=.*[A-Z])[A-Za-z0-9]{10}$/.test(s);
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
  return isStableId(s) || NUMERIC_ID_PATTERN.test(s) || isContaminatedStableId(s);
}

/**
 * Detect "contaminated" stableIds — machine-generated IDs that contain
 * hyphens or underscores due to a legacy bug in crux/lib/grant-import/id.ts
 * (fixed 2026-03-26). Examples: "D-BpcrbThn", "Tw_Eo226h3", "V-55MuswUh".
 *
 * Heuristic: if the string contains at least one uppercase letter and, after
 * stripping hyphens/underscores, is 8-12 alphanumeric chars, it's likely a
 * contaminated stableId rather than a meaningful slug like "tom-brown".
 * Real slugs are all-lowercase by convention.
 */
export function isContaminatedStableId(s: string): boolean {
  if (!s.includes("-") && !s.includes("_")) return false;
  if (!/[A-Z]/.test(s)) return false;
  const stripped = s.replace(/[-_]/g, "");
  // 8-12 chars: stableIds are 10 chars, so 10 +/- 2 tolerates one separator being stripped
  if (stripped.length < 8 || stripped.length > 12) return false;
  if (!/^[A-Za-z0-9]+$/.test(stripped)) return false;
  return true;
}
=======
 * All entity stableIds now use the `sid_` prefix. Legacy bare 10-char IDs,
 * contaminated IDs, and numeric PKs are no longer in use.
 */

export { isSid, isDisplayableName, SID_PREFIX } from "@longterm-wiki/id-utils";
>>>>>>> 767558b75 (refactor: remove legacy ID detection code after sid_ migration)
