/**
 * Entity navigation: URL resolution, backlinks, and related graph.
 */

import { getTableBase, getIdRegistry, resolveId, getTypedEntityById, getEntityBundle, type BacklinkEntry } from "./tablebase";
import type { WithSource } from "./tablebase";

// ============================================================================
// DIRECTORY URL RESOLUTION
// ============================================================================

/** Entity types that have dedicated directory pages with slug-based URLs. */
const DIRECTORY_ENTITY_TYPES: Record<string, string> = {
  person: "/people",
  organization: "/organizations",
  benchmark: "/benchmarks",
  "ai-model": "/ai-models",
  policy: "/legislation",
  project: "/projects",
  "research-area": "/research-areas",
  approach: "/approaches",
  event: "/events",
};

/**
 * Get the directory URL for an entity if it has a dedicated directory page.
 * Returns null if the entity type doesn't have a directory.
 */
export function getDirectoryHref(id: string): string | null {
  const entity = getTypedEntityById(id);
  if (!entity) return null;
  const prefix = DIRECTORY_ENTITY_TYPES[entity.entityType];
  if (!prefix) return null;
  return `${prefix}/${entity.id}`;
}

// ============================================================================
// CORE URL RESOLUTION
// ============================================================================

export function getEntityPath(id: string): string | null {
  const slug = resolveId(id);
  const db = getTableBase();
  return db.pathRegistry?.[slug] || db.pathRegistry?.[`__index__/${slug}`] || null;
}

/**
 * Get the canonical wiki href for an entity (always /wiki/E<id>).
 * For directory-backed entity types (people, organizations),
 * this returns the directory URL instead when a slug is available.
 */
export function getEntityHref(id: string, _type?: string): string {
  // Try directory URL first for entity types with dedicated pages
  const directoryHref = getDirectoryHref(id);
  if (directoryHref) return directoryHref;

  const registry = getIdRegistry();
  // If already a wiki ID (E35), use it directly
  if (/^E\d+$/.test(id) && registry.byWikiId[id]) {
    return `/wiki/${id}`;
  }
  // If it's a stableId, resolve to slug first, then get wikiId
  if (/^[A-Za-z0-9]{10}$/.test(id) && registry.byStableId?.[id]) {
    const slug = registry.byStableId[id];
    const wikiId = registry.bySlug[slug];
    return wikiId ? `/wiki/${wikiId}` : `/wiki/${slug}`;
  }
  // Otherwise look up slug → wiki ID
  const wikiId = registry.bySlug[id];
  return wikiId ? `/wiki/${wikiId}` : `/wiki/${id}`;
}

/**
 * Get the wiki page URL for an entity (always /wiki/E<id>, never a directory URL).
 * Use this when you specifically need the wiki article, not the directory profile.
 */
export function getWikiHref(id: string): string {
  const registry = getIdRegistry();
  const slug = resolveId(id);
  if (/^E\d+$/.test(id) && registry.byWikiId[id]) {
    return `/wiki/${id}`;
  }
  const wikiId = registry.bySlug[slug];
  return wikiId ? `/wiki/${wikiId}` : `/wiki/${slug}`;
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
  // Per-entity bundle is the only source — backlinks removed from main database.json
  const bundle = getEntityBundle(slug);
  const links = bundle?.backlinks ?? [];
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
  // Per-entity bundle is the only source — relatedGraph removed from main database.json
  const bundle = getEntityBundle(slug);
  const entries = bundle?.relatedGraph ?? [];
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
