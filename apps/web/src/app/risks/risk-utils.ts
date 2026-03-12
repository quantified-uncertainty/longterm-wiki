/**
 * Shared utilities for /risks routes.
 * Delegates to generic directory-utils for entity resolution.
 */
import { resolveEntityBySlug, getEntitySlugs } from "@/lib/directory-utils";
import type { Entity } from "@longterm-wiki/kb";

/** Resolve a URL slug to a KB risk entity. */
export function resolveRiskBySlug(slug: string): Entity | undefined {
  return resolveEntityBySlug(slug, "risk");
}

/** Get all risk slugs for generateStaticParams. */
export function getRiskSlugs(): string[] {
  return getEntitySlugs("risk");
}
