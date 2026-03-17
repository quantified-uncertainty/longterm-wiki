/**
 * Consolidated entity name resolver. Used across org pages, grants, divisions,
 * and anywhere we need to display a human-readable name for an entity reference.
 *
 * Resolution priority:
 * 1. Embedded displayName (from API JOIN via build-data)
 * 2. FactBase entity lookup
 * 3. Strip "new:" prefix
 * 4. Humanize slug-format IDs
 * 5. "Unknown" for bare stableIds
 */
import {
  getKBEntity,
  getKBEntitySlug,
} from "@/data/factbase";
import { titleCase } from "@/components/wiki/factbase/format";

/**
 * Matches stableIds: exactly 10 alphanumeric chars with at least one uppercase letter.
 * Avoids false positives for short lowercase slugs like "bioweapons" or "conjecture".
 */
const STABLE_ID_PATTERN = /^(?=.*[A-Z])[A-Za-z0-9]{10}$/;

function buildEntityHref(
  entityType: string,
  slug: string | undefined,
  entityId: string,
): string | null {
  if (!slug) return `/factbase/entity/${entityId}`;
  if (entityType === "organization") return `/organizations/${slug}`;
  if (entityType === "person") return `/people/${slug}`;
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
  if (displayName?.trim()) {
    // Still try to resolve href via FactBase for linking
    if (entityId) {
      const entity = getKBEntity(entityId);
      if (entity) {
        const slug = getKBEntitySlug(entity.id);
        return {
          name: displayName,
          href: buildEntityHref(entity.type, slug ?? undefined, entity.id),
        };
      }
    }
    return { name: displayName, href: null };
  }

  if (!entityId) return { name: "Unknown", href: null };

  // 2. Strip "new:" prefix
  const cleanId = entityId.startsWith("new:")
    ? entityId.slice(4).trim()
    : entityId;

  if (!cleanId) return { name: "Unknown", href: null };

  // 3. Try FactBase lookup (handles both entity IDs and slugs)
  const entity = getKBEntity(cleanId);
  if (entity?.name?.trim()) {
    const slug = getKBEntitySlug(entity.id);
    return {
      name: entity.name,
      href: buildEntityHref(entity.type, slug ?? undefined, entity.id),
    };
  }

  // 4. Detect unresolvable stableId
  if (STABLE_ID_PATTERN.test(cleanId)) {
    return { name: "Unknown", href: null };
  }

  // 5. Humanize slug — titleCase handles hyphens, underscores, and single words
  const humanized = titleCase(cleanId);
  return { name: humanized || "Unknown", href: null };
}
