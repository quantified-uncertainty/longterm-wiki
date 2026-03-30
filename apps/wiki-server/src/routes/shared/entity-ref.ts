/**
 * Shared entity reference formatter for API responses.
 *
 * Every entity reference in a server response should go through formatEntityRef()
 * so the frontend always has slug (for URLs) and name (for display) — never bare stableIds.
 */

import { isSid } from "@longterm-wiki/id-utils";

/** Structured entity reference in API responses. */
export interface EntityRef {
  /** Entity stableId (sid_-prefixed), null if unresolved */
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
  // Skip sid_-prefixed stableIds
  const name =
    entityTitle ??
    (displayName && !isSid(displayName) ? displayName : null) ??
    (rawId && !isSid(rawId) ? rawId : null);

  return {
    entityId: entityId ?? null,
    slug: slug ?? null,
    name,
  };
}
