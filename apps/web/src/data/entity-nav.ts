/**
 * Entity navigation: URL resolution, backlinks, and related graph.
 */

import { getDatabase, getIdRegistry, resolveId, getTypedEntityById, getEntityBundle, type BacklinkEntry } from "./database";
import type { WithSource } from "./database";
import { getKBEntitySlug } from "./kb";

// ============================================================================
// DIRECTORY URL RESOLUTION
// ============================================================================

/** Entity types that have dedicated directory pages with slug-based URLs. */
const DIRECTORY_ENTITY_TYPES: Record<string, string> = {
  person: "/people",
  organization: "/organizations",
  risk: "/risks",
  benchmark: "/benchmarks",
  "ai-model": "/ai-models",
  policy: "/legislation",
  project: "/projects",
  "research-area": "/research-areas",
};

/**
 * Get the directory URL for an entity if it has a dedicated directory page.
 * Returns null if the entity type doesn't have a directory or has no slug.
 */
/** Entity types that use entity ID as slug instead of KB slug resolution. */
const NON_KB_DIRECTORY_TYPES = new Set(["benchmark", "ai-model", "policy", "project", "research-area"]);

export function getDirectoryHref(id: string): string | null {
  const entity = getTypedEntityById(id);
  if (!entity) return null;
  const prefix = DIRECTORY_ENTITY_TYPES[entity.entityType];
  if (!prefix) return null;

  // Non-KB entity types use entity ID directly as the slug
  if (NON_KB_DIRECTORY_TYPES.has(entity.entityType)) {
    return `${prefix}/${entity.id}`;
  }

  const slug = getKBEntitySlug(id) || getKBEntitySlug(resolveId(id));
  if (!slug) return null;
  return `${prefix}/${slug}`;
}

// ============================================================================
// CORE URL RESOLUTION
// ============================================================================

export function getEntityPath(id: string): string | null {
  const slug = resolveId(id);
  const db = getDatabase();
  return db.pathRegistry?.[slug] || db.pathRegistry?.[`__index__/${slug}`] || null;
}

/**
 * Get the canonical wiki href for an entity (always /wiki/E<id>).
 * For directory-backed entity types (people, organizations, risks),
 * this returns the directory URL instead when a slug is available.
 */
export function getEntityHref(id: string, _type?: string): string {
  // Try directory URL first for entity types with dedicated pages
  const directoryHref = getDirectoryHref(id);
  if (directoryHref) return directoryHref;

  const registry = getIdRegistry();
  // If already a numeric ID (E35), use it directly
  if (/^E\d+$/.test(id) && registry.byNumericId[id]) {
    return `/wiki/${id}`;
  }
  // Otherwise look up slug → numeric ID
  const numericId = registry.bySlug[id];
  return numericId ? `/wiki/${numericId}` : `/wiki/${id}`;
}

/**
 * Get the wiki page URL for an entity (always /wiki/E<id>, never a directory URL).
 * Use this when you specifically need the wiki article, not the directory profile.
 */
export function getWikiHref(id: string): string {
  const registry = getIdRegistry();
  const slug = resolveId(id);
  if (/^E\d+$/.test(id) && registry.byNumericId[id]) {
    return `/wiki/${id}`;
  }
  const numericId = registry.bySlug[slug];
  return numericId ? `/wiki/${numericId}` : `/wiki/${slug}`;
}

// ============================================================================
// BACKLINKS
// ============================================================================

export function getBacklinksFor(
  entityId: string
): Array<{
  id: string;
  type: string;
  title: string;
  href: string;
  relationship?: string;
}> {
  const slug = resolveId(entityId);
  // Try per-entity bundle first (avoids loading full database.json)
  const bundle = getEntityBundle(slug);
  const links = bundle?.backlinks ?? getDatabase().backlinks?.[slug] ?? [];
  return links.map((link: BacklinkEntry) => ({
    ...link,
    href: getEntityHref(link.id, link.type),
  }));
}

/** Backlink shape used by both the API and local fallback paths. */
type NormalizedBacklink = { id: string; type: string; title: string; href: string; relationship?: string };

/**
 * Get backlinks from local database.json.
 * Content pages always use build-time data — no runtime API calls.
 */
export function getBacklinksWithFallback(
  entityId: string
): WithSource<NormalizedBacklink[]> {
  return { data: getBacklinksFor(entityId), source: "local" };
}

// ============================================================================
// RELATED GRAPH (bidirectional, multi-signal)
// ============================================================================

export function getRelatedGraphFor(
  entityId: string
): Array<{
  id: string;
  type: string;
  title: string;
  href: string;
  score: number;
  label?: string;
}> {
  const slug = resolveId(entityId);
  // Try per-entity bundle first (avoids loading full database.json)
  const bundle = getEntityBundle(slug);
  const entries = bundle?.relatedGraph ?? getDatabase().relatedGraph?.[slug] ?? [];
  return entries.map((entry) => ({
    ...entry,
    href: getEntityHref(entry.id, entry.type),
  }));
}

/**
 * Get related pages from local database.json.
 * Content pages always use build-time data — no runtime API calls.
 */
export function getRelatedGraphWithFallback(
  entityId: string
): WithSource<Array<{
  id: string;
  type: string;
  title: string;
  href: string;
  score: number;
  label?: string;
}>> {
  return { data: getRelatedGraphFor(entityId), source: "local" };
}
