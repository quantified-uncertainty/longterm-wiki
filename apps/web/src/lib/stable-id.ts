/**
 * Canonical stableId detection — thin re-export from @longterm-wiki/id-utils.
 *
 * All stableIds use the `sid_` prefix. Use `isSid()` to detect them.
 */

export {
  isSid,
  isDisplayableName,
  isAnySid,
  isLegacyStableId,
  STABLE_ID_PATTERN,
  NUMERIC_ID_PATTERN,
} from "@longterm-wiki/id-utils";
