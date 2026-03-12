/**
 * Resource Lookup — cached resource index for source-fetcher integration
 *
 * Provides fast lookup by resource ID and by URL, used by source-fetcher and
 * citation verification to integrate with the Resources system.
 *
 * Read path: loads resources from snapshot (sync) or PG (async via initFromPG).
 */

import type { Resource } from '../../resource-types.ts';
import { loadResources, loadResourcesPGFirst } from '../../resource-io.ts';

// Re-export Resource as ResourceEntry for consumers
export type ResourceEntry = Resource;

/** Status information to write back to a resource after fetching */
export interface ResourceFetchStatus {
  /** HTTP-level status: 'ok', 'dead', 'paywall', 'error' */
  fetchStatus: 'ok' | 'dead' | 'paywall' | 'error';
  /** ISO timestamp of when the fetch happened */
  fetchedAt: string;
  /** Page title from the fetched content (may update resource title) */
  fetchedTitle?: string;
}

// ---------------------------------------------------------------------------
// Lazy-loaded resource index
// ---------------------------------------------------------------------------

let cachedResources: Resource[] | null = null;
let cachedById: Map<string, Resource> | null = null;
let cachedByStableId: Map<string, Resource> | null = null;
let cachedByUrl: Map<string, Resource> | null = null;

function normalizeUrlKey(url: string): string {
  try {
    const parsed = new URL(url);
    // Normalize protocol: http → https
    parsed.protocol = 'https:';
    // Remove www. prefix
    parsed.hostname = parsed.hostname.replace(/^www\./, '');
    // Remove fragment
    parsed.hash = '';
    // Remove UTM tracking parameters and sort remaining params
    const params = new URLSearchParams(parsed.search);
    const keysToDelete: string[] = [];
    for (const key of params.keys()) {
      if (key.startsWith('utm_')) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      params.delete(key);
    }
    params.sort();
    parsed.search = params.toString();
    // Remove trailing slash
    return parsed.href.replace(/\/$/, '');
  } catch {
    return url;
  }
}

function ensureLoaded(): void {
  if (cachedResources) return;

  cachedResources = loadResources();
  buildIndexes(cachedResources);
}

function buildIndexes(resources: Resource[]): void {
  cachedById = new Map();
  cachedByStableId = new Map();
  cachedByUrl = new Map();

  for (const resource of resources) {
    cachedById.set(resource.id, resource);

    if (resource.stable_id) {
      const existing = cachedByStableId.get(resource.stable_id);
      if (existing && existing.id !== resource.id) {
        throw new Error(
          `Duplicate resource stable_id "${resource.stable_id}" for "${existing.id}" and "${resource.id}"`
        );
      }
      cachedByStableId.set(resource.stable_id, resource);
    }

    // Index by normalized URL (with and without trailing slash, www variants)
    if (resource.url) {
      const norm = normalizeUrlKey(resource.url);
      cachedByUrl.set(norm, resource);
      cachedByUrl.set(norm + '/', resource);
    }
  }
}

/**
 * Initialize the resource cache using PG-first loading.
 * Call this before using getResourceById/getResourceByUrl
 * to benefit from fresher PG data.
 */
export async function initFromPG(): Promise<void> {
  if (cachedResources) return;
  cachedResources = await loadResourcesPGFirst();
  buildIndexes(cachedResources);
}

/** Clear the cached resource index (useful in tests). */
export function clearResourceCache(): void {
  cachedResources = null;
  cachedById = null;
  cachedByStableId = null;
  cachedByUrl = null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Look up a resource by its hash ID. */
export function getResourceById(id: string): Resource | null {
  ensureLoaded();
  return cachedById!.get(id) ?? null;
}

/** Look up a resource by URL (normalized, tolerant of trailing slashes and www). */
export function getResourceByUrl(url: string): Resource | null {
  ensureLoaded();
  const norm = normalizeUrlKey(url);
  return cachedByUrl!.get(norm) ?? cachedByUrl!.get(norm + '/') ?? null;
}

/**
 * Resolve a resource by hash ID or stable_id.
 * Tries hash ID first (16-char hex), then stable_id (10-char alphanumeric).
 */
export function resolveResource(id: string): Resource | null {
  ensureLoaded();
  return cachedById!.get(id) ?? cachedByStableId!.get(id) ?? null;
}

/**
 * Update a resource's fetch status by calling the wiki-server PATCH endpoint.
 *
 * Fire-and-forget: errors are logged but do not propagate to the caller.
 * The source-fetcher should not fail because the status write failed.
 */
export function updateResourceFetchStatus(
  resourceId: string,
  status: ResourceFetchStatus,
): void {
  // Fire-and-forget: call the wiki-server PATCH endpoint asynchronously.
  // Errors are logged at warn level — this is best-effort telemetry.
  import('../wiki-server/resources.ts')
    .then((mod) =>
      mod.updateResourceFetchStatus(resourceId, {
        fetchStatus: status.fetchStatus,
        lastFetchedAt: status.fetchedAt,
        fetchedTitle: status.fetchedTitle,
      }),
    )
    .then((result) => {
      if (!result.ok) {
        console.warn(
          `[resource-lookup] Failed to update fetch status for ${resourceId}: ${result.error}`,
        );
      }
    })
    .catch((e: unknown) => {
      console.warn(
        `[resource-lookup] Failed to update fetch status for ${resourceId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
}
