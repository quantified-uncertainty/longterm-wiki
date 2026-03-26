/**
 * Shared entity reference formatter for API responses.
 *
 * Every entity reference in a server response should go through formatEntityRef()
 * so the frontend always has slug (for URLs) and name (for display) — never bare stableIds.
 */

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
 * Matches stableIds: exactly 10 alphanumeric chars with at least one uppercase letter.
 * Canonical definition for frontend: apps/web/src/lib/stable-id.ts
 * This is the wiki-server copy (separate TS project, can't share imports).
 */
export const STABLE_ID_PATTERN = /^(?=.*[A-Z])[A-Za-z0-9]{10}$/;

/** Matches pure numeric IDs (legacy database PKs like "175", "335"). */
const NUMERIC_ID_PATTERN = /^\d+$/;

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
  // Name priority: entity title > display name > humanized raw ID
  // Skip bare stableIds and numeric database PKs — neither are human-readable
  const name =
    entityTitle ??
    displayName ??
    (rawId && !STABLE_ID_PATTERN.test(rawId) && !NUMERIC_ID_PATTERN.test(rawId) ? rawId : null);

  return {
    entityId: entityId ?? null,
    slug: slug ?? null,
    name,
  };
}
