/**
 * Shared entity reference formatter for API responses.
 *
 * Every entity reference in a server response should go through formatEntityRef()
 * so the frontend always has slug (for URLs) and name (for display) — never bare stableIds.
 */

import {
  isAnySid,
  STABLE_ID_PATTERN,
  NUMERIC_ID_PATTERN,
} from "@longterm-wiki/id-utils";

// Re-export for consumers that import STABLE_ID_PATTERN from this module
export { STABLE_ID_PATTERN };

/** Structured entity reference in API responses. */
export interface EntityRef {
  /** Entity stableId (10-char alphanumeric), null if unresolved */
  entityId: string | null;
  /** Entity slug (URL-friendly), null if entity not found in DB */
  slug: string | null;
  /** Display name: prefers entity title > displayName > humanized raw ID */
  name: string | null;
}

/**
 * Format an entity reference from joined query results.
 *
 * @param entityId - The resolved stableId FK (from the *EntityId column)
 * @param slug - The entity slug (from the joined entities.id column)
 * @param entityTitle - The entity title (from the joined entities.title column)
 * @param displayName - The displayName stored on the record (fallback)
 * @param rawId - The original raw ID (e.g., granteeId, personId) — used as last-resort name
 */
export function formatEntityRef(
  entityId: string | null,
  slug: string | null,
  entityTitle: string | null,
  displayName: string | null,
  rawId: string | null,
): EntityRef {
  // Name priority: entity title > display name > raw ID (if not a bare machine ID)
  // Skip bare stableIds (both new sid_ and legacy), numeric database PKs, and legacy IDs with hyphens
  const isId = (s: string) => {
    if (isAnySid(s) || NUMERIC_ID_PATTERN.test(s)) return true;
    // Legacy IDs with hyphens/underscores (e.g., "8-JZq4lrlD", "Tw_Eo226h3")
    if (s.length >= 8 && s.length <= 12 && /[_-]/.test(s) && /\d/.test(s) && /[A-Z]/.test(s) && !s.includes(" ")) return true;
    return false;
  };
  const name =
    entityTitle ??
    (displayName && !isId(displayName) ? displayName : null) ??
    (rawId && !isId(rawId) ? rawId : null);

  return {
    entityId: entityId ?? null,
    slug: slug ?? null,
    name,
  };
}
