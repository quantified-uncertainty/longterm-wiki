import { isSid } from "@longterm-wiki/id-utils";
import { logger } from "../../logger.js";

/**
 * Coerce a candidate display-name value to NULL if it's a raw stableId
 * (anything starting with `sid_`; see `isSid` in `@longterm-wiki/id-utils`).
 *
 * Display-name columns on `source_check_verdicts` must hold human-readable
 * names or NULL — a raw `sid_` leaks to UI and defeats QUA-650's retro-scans
 * that match on subject labels.
 *
 * When a sid_ is dropped, logs a warning identifying the record so the
 * offending caller can be traced. The verdict is still written, just with
 * NULL in the display column — an honest signal of "unknown name".
 *
 * Used by POST /api/sourcing/verdicts (sourcing.ts) and the citation-accuracy
 * write path (wikibase/citations.ts). Any new write site for
 * `source_check_verdicts.display_name` / `entity_display_name` must route
 * through this helper.
 */
export function coerceDisplayName(
  value: string | null,
  fieldName: "displayName" | "entityDisplayName",
  recordType: string,
  recordId: string,
): string | null {
  if (value == null) return null;
  if (isSid(value)) {
    logger.warn(
      { field: fieldName, value, recordType, recordId },
      `Rejected sid_ in source_check_verdicts.${fieldName} — coerced to NULL`,
    );
    return null;
  }
  return value;
}
