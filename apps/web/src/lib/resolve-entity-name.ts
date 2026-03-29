/**
 * Consolidated entity name resolver. Used across org pages, grants, divisions,
 * and anywhere we need to display a human-readable name for an entity reference.
 *
 * Resolution priority:
 * 1. Embedded displayName (from API JOIN via build-data)
 * 2. FactBase entity lookup (stableIds, slugs, wikiIds)
 * 3. TableBase entity lookup (direct slug match)
 * 4. Strip "new:" prefix
 * 5. Humanize slug-format IDs (hyphens/underscores → title case)
 * 6. "Unknown" for bare stableIds and numeric-only IDs
 */
import {
  getKBEntity,
  getKBEntitySlug,
} from "@/data/factbase";
import { getTypedEntityById } from "@/data/tablebase";
import { getEntityHref } from "@/data/entity-nav";
import { titleCase } from "@/components/wiki/factbase/format";
import { isBareMachineId } from "@/lib/stable-id";

/** Build the canonical href for an entity, falling back to /factbase/entity/{id}. */
function buildEntityHref(slug: string | undefined, entityId: string): string | null {
  if (slug) return getEntityHref(slug);
  return `/factbase/entity/${entityId}`;
}

/**
 * Check if a string looks like a raw slug rather than a display name.
 * Slugs are all-lowercase with hyphens separating words (e.g., "tom-brown",
 * "employee-equity-pool"). Display names contain spaces and/or mixed case
 * (e.g., "Tom Brown", "Employee Equity Pool").
 *
 * We only treat something as a slug if it contains hyphens AND has no spaces.
 * Single-word lowercase strings like "google" or "amazon" are ambiguous —
 * they could be either slugs or proper names — so we let them through to
 * be resolved by the full resolution pipeline below.
 */
function looksLikeSlug(s: string): boolean {
  // Must contain at least one hyphen (single words are ambiguous)
  if (!s.includes("-")) return false;
  // Must not contain spaces (display names have spaces)
  if (s.includes(" ")) return false;
  // Must be all-lowercase (display names have uppercase)
  if (s !== s.toLowerCase()) return false;
  return true;
}

/**
 * Resolve an entity ID/slug to a display name and optional href.
 *
 * @param entityId - A stableId, slug, "new:Name", or display name string
 * @param displayName - Pre-resolved display name from API JOIN (highest priority)
 */
export function resolveEntityName(
  entityId: string | null | undefined,
  displayName?: string | null,
): { name: string; href: string | null } {
  // 1. Use embedded displayName if available (from API JOIN)
  //    But reject bare stableIds, numeric PKs, contaminated IDs, and raw slugs
  //    that leaked through — these are not human-readable names and should be
  //    resolved via the full pipeline below (FactBase/TableBase lookups, then
  //    humanization as a last resort).
  //
  //    Also reject displayNames that exactly match the entityId — this indicates
  //    the API couldn't resolve the entity and just echoed the raw ID/slug back.
  //    The full pipeline below can often resolve these via FactBase/TableBase.
  const trimmedDisplayName = displayName?.trim();
  const displayNameIsJustEchoedId =
    trimmedDisplayName != null &&
    entityId != null &&
    trimmedDisplayName === entityId;

  if (
    trimmedDisplayName &&
    !isBareMachineId(trimmedDisplayName) &&
    !looksLikeSlug(trimmedDisplayName) &&
    !displayNameIsJustEchoedId
  ) {
    // Still try to resolve href via FactBase for linking
    if (entityId) {
      const entity = getKBEntity(entityId);
      if (entity) {
        const slug = getKBEntitySlug(entity.id);
        return {
          name: trimmedDisplayName,
          href: buildEntityHref(slug ?? undefined, entity.id),
        };
      }
    }
    return { name: trimmedDisplayName, href: null };
  }

  if (!entityId) return { name: "Unknown", href: null };

  // 2. Strip "new:" prefix
  const cleanId = entityId.startsWith("new:")
    ? entityId.slice(4).trim()
    : entityId;

  if (!cleanId) return { name: "Unknown", href: null };

  // 3. Try FactBase lookup (handles stableIds, slugs, and wikiIds)
  const entity = getKBEntity(cleanId);
  if (entity?.name?.trim()) {
    const slug = getKBEntitySlug(entity.id);
    return {
      name: entity.name,
      href: buildEntityHref(slug ?? undefined, entity.id),
    };
  }

  // 4. Try direct TableBase entity lookup by slug (catches entities
  //    that FactBase doesn't know about but TableBase has)
  const typedEntity = getTypedEntityById(cleanId);
  if (typedEntity?.title?.trim()) {
    return {
      name: typedEntity.title,
      href: buildEntityHref(typedEntity.id, typedEntity.stableId ?? typedEntity.id),
    };
  }

  // 5. Detect unresolvable machine IDs (stableIds, contaminated stableIds, numeric PKs)
  if (isBareMachineId(cleanId)) {
    return { name: "Unknown", href: null };
  }

  // 7. Humanize slug — titleCase handles hyphens, underscores, and single words
  const humanized = titleCase(cleanId);
  return { name: humanized || "Unknown", href: null };
}
