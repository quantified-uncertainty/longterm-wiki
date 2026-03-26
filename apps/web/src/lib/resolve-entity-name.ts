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

/**
 * Matches stableIds: exactly 10 alphanumeric chars with at least one uppercase letter.
 * Avoids false positives for short lowercase slugs like "bioweapons" or "conjecture".
 */
const STABLE_ID_PATTERN = /^(?=.*[A-Z])[A-Za-z0-9]{10}$/;

/**
 * Matches pure numeric IDs (e.g. "335", "1234") which are never valid slugs.
 * These come from legacy FactBase entity references that used numeric IDs.
 */
const NUMERIC_ID_PATTERN = /^\d+$/;

/** Build the canonical href for an entity, falling back to /factbase/entity/{id}. */
function buildEntityHref(slug: string | undefined, entityId: string): string | null {
  if (slug) return getEntityHref(slug);
  return `/factbase/entity/${entityId}`;
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
  //    But reject bare stableIds and numeric PKs that leaked through —
  //    these are not human-readable names and should be resolved below.
  const trimmedDisplayName = displayName?.trim();
  if (
    trimmedDisplayName &&
    !STABLE_ID_PATTERN.test(trimmedDisplayName) &&
    !NUMERIC_ID_PATTERN.test(trimmedDisplayName)
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

  // 5. Detect unresolvable stableId (10 alphanumeric chars with uppercase)
  if (STABLE_ID_PATTERN.test(cleanId)) {
    return { name: "Unknown", href: null };
  }

  // 6. Detect pure numeric IDs (legacy FactBase references) — not valid slugs
  if (NUMERIC_ID_PATTERN.test(cleanId)) {
    return { name: "Unknown", href: null };
  }

  // 7. Humanize slug — titleCase handles hyphens, underscores, and single words
  const humanized = titleCase(cleanId);
  return { name: humanized || "Unknown", href: null };
}
