/**
 * Shared utilities for /organizations routes.
 */
import {
  getKBEntities,
  getKBEntity,
  resolveKBSlug,
  getKBSlugMap,
} from "@/data/factbase";
import { getTypedEntities, isOrganization } from "@/data";
import type { Entity } from "@longterm-wiki/factbase";

/**
 * Resolve a URL slug (e.g., "anthropic") to a KB organization entity.
 * Returns undefined if not found or not an organization.
 */
export function resolveOrgBySlug(slug: string): Entity | undefined {
  const entityId = resolveKBSlug(slug);
  if (!entityId) return undefined;
  const entity = getKBEntity(entityId);
  if (!entity || entity.type !== "organization") return undefined;
  return entity;
}

/**
 * Get all organization slugs for generateStaticParams.
 *
 * Sources ALL organization entities — not just KB-backed ones.
 * This ensures every org in the directory listing has a detail page.
 */
export function getOrgSlugs(): string[] {
  // Primary source: typed entities from database.json (covers all YAML entities)
  const allEntitySlugs = new Set(
    getTypedEntities()
      .filter(isOrganization)
      .map((e) => e.id),
  );

  // Also include KB-backed slugs (in case any exist only in KB)
  const slugMap = getKBSlugMap();
  const kbOrgIds = new Set(
    getKBEntities()
      .filter((e) => e.type === "organization")
      .map((e) => e.id),
  );
  for (const [slug, id] of Object.entries(slugMap)) {
    if (kbOrgIds.has(id)) {
      allEntitySlugs.add(slug);
    }
  }

  return [...allEntitySlugs];
}
