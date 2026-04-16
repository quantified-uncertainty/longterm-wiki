/**
 * Resource Lookup — cached resource index for source-fetcher integration
 *
 * Provides fast lookup by resource ID and by URL, used by source-fetcher and
 * citation checking to integrate with the Resources system.
 *
 * Read path: loads resources from snapshot (sync) or PG (async via initFromPG).
 */

import { normalizeUrl } from "@longterm-wiki/url-utils";
import type { Resource } from '../../resource-types.ts';
import { loadResources, loadResourcesPGFirst } from '../../resource-io.ts';

// Re-export Resource as ResourceEntry for consumers
export type ResourceEntry = Resource;

/** HTTP reachability status to write back to a resource after fetching.
 *  This updates the DB fetch_status column (HTTP reachability), NOT enrichment_status
 *  (LLM pipeline stage). Fine-grained statuses (soft_404, not_found, timeout,
 *  unreachable) are subtypes of the legacy "dead" bucket — stored as-is for
 *  richer retry/analytics. */
export interface ResourceFetchStatus {
  fetchStatus: 'ok' | 'dead' | 'soft_404' | 'not_found' | 'timeout' | 'unreachable' | 'paywall' | 'error';
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
  // Use the canonical normalizer with the lookup-key preset:
  // stripProtocol makes http and https hash to the same key (the previous
  // implementation forced https, which is equivalent), and sortParams
  // gives deterministic keys regardless of param order.
  return normalizeUrl(url, { stripProtocol: true, sortParams: true });
}

function ensureLoaded(): void {
  if (cachedResources) return;

  try {
    cachedResources = loadResources();
  } catch {
    // Snapshot file may not exist (e.g., in GHA job workers that use PG
    // directly). Set empty cache so callers get null lookups instead of a
    // hard crash. Callers that need resources should call initFromPG() first.
    cachedResources = [];
  }
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

    // Index by canonical URL key (the canonical helper already strips
    // trailing slash, www, and tracking params — one entry covers all variants).
    if (resource.url) {
      cachedByUrl.set(normalizeUrlKey(resource.url), resource);
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

/** Look up a resource by URL (canonical-key normalization, tolerant of www/protocol/slash variants). */
export function getResourceByUrl(url: string): Resource | null {
  ensureLoaded();
  return cachedByUrl!.get(normalizeUrlKey(url)) ?? null;
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

/**
 * Update a resource's archive_url by calling the wiki-server batch endpoint.
 *
 * Fire-and-forget: errors are logged but do not propagate to the caller.
 */
export function updateResourceArchiveUrl(
  resourceId: string,
  archiveUrl: string,
): void {
  import('../wiki-server/resources.ts')
    .then((mod) => mod.updateResourceArchiveUrl(resourceId, archiveUrl))
    .then((result) => {
      if (!result.ok) {
        console.warn(
          `[resource-lookup] Failed to update archive URL for ${resourceId}: ${result.error}`,
        );
      }
    })
    .catch((e: unknown) => {
      console.warn(
        `[resource-lookup] Failed to update archive URL for ${resourceId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
}
