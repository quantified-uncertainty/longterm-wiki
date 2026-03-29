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
 * Exported so other modules can use the same canonical pattern.
 */
export const STABLE_ID_PATTERN = /^(?=.*[A-Z])[A-Za-z0-9]{10}$/;

/** Matches pure numeric IDs (legacy database PKs like "175", "335"). */
const NUMERIC_ID_PATTERN = /^\d+$/;

/**
 * Detect contaminated stableIds: machine-generated IDs with hyphens/underscores
 * from a legacy import bug. Examples: "D-BpcrbThn", "Tw_Eo226h3".
 * Real slugs are all-lowercase; contaminated IDs have uppercase letters.
 */
function isContaminatedStableId(s: string): boolean {
  if (!s.includes("-") && !s.includes("_")) return false;
  if (!/[A-Z]/.test(s)) return false;
  const stripped = s.replace(/[-_]/g, "");
  if (stripped.length < 8 || stripped.length > 12) return false;
  if (!/^[A-Za-z0-9]+$/.test(stripped)) return false;
  return true;
}

/** Check if a string is a bare machine ID that should never be displayed. */
function isBareMachineId(s: string): boolean {
  return STABLE_ID_PATTERN.test(s) || NUMERIC_ID_PATTERN.test(s) || isContaminatedStableId(s);
}

/** Humanize a slug by converting hyphens/underscores to spaces and title-casing. */
function humanizeSlug(s: string): string {
  return s
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
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
  // Name priority: entity title > display name > humanized raw ID
  // Skip bare machine IDs (stableIds, numeric PKs, contaminated IDs) — not human-readable
  let name =
    entityTitle ??
    (displayName && !isBareMachineId(displayName) ? displayName : null) ??
    null;

  // Last resort: humanize the rawId if it's a slug (not a machine ID)
  if (!name && rawId && !isBareMachineId(rawId)) {
    name = humanizeSlug(rawId);
  }

  return {
    entityId: entityId ?? null,
    slug: slug ?? null,
    name,
  };
}
