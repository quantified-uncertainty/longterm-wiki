/**
 * Shared utilities for /risks routes.
 */
import {
  getKBEntities,
  getKBEntity,
  resolveKBSlug,
  getKBSlugMap,
} from "@/data/kb";
import type { Entity } from "@longterm-wiki/kb";

/**
 * Resolve a URL slug (e.g., "power-seeking") to a KB risk entity.
 * Returns undefined if not found or not a risk.
 */
export function resolveRiskBySlug(slug: string): Entity | undefined {
  const entityId = resolveKBSlug(slug);
  if (!entityId) return undefined;
  const entity = getKBEntity(entityId);
  if (!entity || entity.type !== "risk") return undefined;
  return entity;
}

/**
 * Get all risk slugs for generateStaticParams.
 */
export function getRiskSlugs(): string[] {
  const slugMap = getKBSlugMap();
  const entities = getKBEntities();
  const riskIds = new Set(
    entities.filter((e) => e.type === "risk").map((e) => e.id),
  );

  return Object.entries(slugMap)
    .filter(([, id]) => riskIds.has(id))
    .map(([slug]) => slug);
}
