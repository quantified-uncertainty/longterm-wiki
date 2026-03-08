/**
 * Entity navigation: URL resolution, backlinks, and related graph.
 */

import { getDatabase, getIdRegistry, resolveId, type BacklinkEntry } from "./database";
import type { WithSource } from "./database";

export function getEntityPath(id: string): string | null {
  const slug = resolveId(id);
  const db = getDatabase();
  return db.pathRegistry?.[slug] || db.pathRegistry?.[`__index__/${slug}`] || null;
}

export function getEntityHref(id: string, _type?: string): string {
  const registry = getIdRegistry();
  // If already a numeric ID (E35), use it directly
  if (/^E\d+$/.test(id) && registry.byNumericId[id]) {
    return `/wiki/${id}`;
  }
  // Otherwise look up slug → numeric ID
  const numericId = registry.bySlug[id];
  return numericId ? `/wiki/${numericId}` : `/wiki/${id}`;
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
  const db = getDatabase();
  const links = db.backlinks?.[slug] || [];
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
  const db = getDatabase();
  const entries = db.relatedGraph?.[slug] || [];
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
