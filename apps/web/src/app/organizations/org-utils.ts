/**
 * Shared utilities for /organizations routes.
 */
import {
  getKBEntities,
  getKBEntity,
  resolveKBSlug,
  getKBSlugMap,
} from "@/data/kb";
import type { Entity } from "@longterm-wiki/kb";

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
 */
export function getOrgSlugs(): string[] {
  const slugMap = getKBSlugMap();
  const entities = getKBEntities();
  const orgIds = new Set(
    entities.filter((e) => e.type === "organization").map((e) => e.id),
  );

  return Object.entries(slugMap)
    .filter(([, id]) => orgIds.has(id))
    .map(([slug]) => slug);
}
