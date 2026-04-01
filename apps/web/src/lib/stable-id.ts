/**
 * Canonical stableId detection — thin re-export from @longterm-wiki/id-utils.
 *
 * All entity stableIds now use the `sid_` prefix. Legacy bare 10-char IDs,
 * contaminated IDs, and numeric PKs are no longer in use.
 */

export { isSid, isAnySid, isDisplayableName, SID_PREFIX } from "@longterm-wiki/id-utils";
