/**
 * Resource Lookup — cached resource index for source-fetcher integration
 *
 * Provides fast lookup by resource ID and by URL, used by source-fetcher and
 * citation verification to integrate with the Resources system.
 *
 * Read path: loads resources lazily from YAML and caches in memory.
 * Write path: updateResourceFetchStatus() writes fetch_status/fetched_at
 * back to the source YAML file (targeted field update, not full round-trip).
 */

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { Resource } from '../resource-types.ts';
import { RESOURCES_DIR } from '../resource-types.ts';
import { loadResources } from '../resource-io.ts';

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
let cachedByUrl: Map<string, Resource> | null = null;

function normalizeUrlKey(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.href.replace(/\/$/, '').replace('://www.', '://');
  } catch {
    return url;
  }
}

function ensureLoaded(): void {
  if (cachedResources) return;

  cachedResources = loadResources();
  cachedById = new Map();
  cachedByUrl = new Map();

  for (const resource of cachedResources) {
    cachedById.set(resource.id, resource);

    // Index by normalized URL (with and without trailing slash, www variants)
    if (resource.url) {
      const norm = normalizeUrlKey(resource.url);
      cachedByUrl.set(norm, resource);
      cachedByUrl.set(norm + '/', resource);
    }
  }
}

/** Clear the cached resource index (useful in tests). */
export function clearResourceCache(): void {
  cachedResources = null;
  cachedById = null;
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
 * Update a resource's fetch status in the YAML file.
 *
 * Uses line-level text replacement to update only the fetch_status and
 * fetched_at fields, preserving YAML comments, formatting, and all other
 * fields (review, key_points, etc.).
 */
export function updateResourceFetchStatus(
  resourceId: string,
  status: ResourceFetchStatus,
): void {
  ensureLoaded();
  const resource = cachedById!.get(resourceId);
  if (!resource || !resource._sourceFile) return;

  const filepath = join(RESOURCES_DIR, `${resource._sourceFile}.yaml`);
  if (!existsSync(filepath)) return;

  const content = readFileSync(filepath, 'utf-8');

  // Use targeted YAML parsing to find and update only the specific entry.
  // We parse to locate the entry, then do a targeted text-level update
  // to preserve comments and formatting.
  const parsed = parseYaml(content);
  if (!Array.isArray(parsed)) return;

  const entryIndex = parsed.findIndex((e: Record<string, unknown>) => e.id === resourceId);
  if (entryIndex === -1) return;

  // Build the updated entry by merging new fields into the existing parsed entry
  const entry = parsed[entryIndex] as Record<string, unknown>;
  entry.fetch_status = status.fetchStatus;
  entry.fetched_at = status.fetchedAt;
  if (status.fetchedTitle && !entry.title) {
    entry.title = status.fetchedTitle;
  }

  // Preserve YAML comment headers by extracting them before rewriting
  const commentLines: string[] = [];
  for (const line of content.split('\n')) {
    if (line.startsWith('#') || line.trim() === '') {
      commentLines.push(line);
    } else {
      break;
    }
  }

  const yamlBody = stringifyYaml(parsed, { lineWidth: 100 });
  const output = commentLines.length > 0
    ? commentLines.join('\n') + '\n' + yamlBody
    : yamlBody;

  writeFileSync(filepath, output);
}
