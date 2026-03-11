/**
 * Resource Manager — PG-native I/O with snapshot fallback
 *
 * Resources are stored in PostgreSQL (wiki-server). Reads try PG first,
 * falling back to the snapshot file (data/resources-snapshot.json).
 * Writes go directly to PG via the batch API.
 *
 * The snapshot file is maintained by `pnpm crux wiki-server snapshot-resources`
 * and serves as an offline/CI fallback when the wiki-server is unavailable.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { loadPages as loadPagesJson, type PageEntry, DATA_DIR_ABS as DATA_DIR } from './lib/content-types.ts';
import { PUBLICATIONS_FILE } from './resource-types.ts';
import type { Resource, Publication } from './resource-types.ts';
import { apiRequest } from './lib/wiki-server/client.ts';
import { generateId } from '../packages/kb/src/ids.ts';
import { normalizeDate, normalizeTimestamp } from './wiki-server/sync-resources.ts';
import type { SyncResource } from './wiki-server/sync-resources.ts';

const SNAPSHOT_FILE = join(DATA_DIR, 'resources-snapshot.json');
const PG_BATCH_SIZE = 200;

/**
 * Load resources from the snapshot file (synchronous fallback).
 * Used when the wiki-server is unavailable.
 */
export function loadResources(): Resource[] {
  if (!existsSync(SNAPSHOT_FILE)) {
    console.warn('  resources: snapshot file not found, returning empty list');
    return [];
  }
  const content = readFileSync(SNAPSHOT_FILE, 'utf-8');
  return JSON.parse(content) as Resource[];
}

// ---------------------------------------------------------------------------
// PG-first resource loading
// ---------------------------------------------------------------------------

interface PGResourceRow {
  id: string;
  url: string;
  title: string | null;
  type: string | null;
  summary: string | null;
  review: string | null;
  abstract: string | null;
  keyPoints: string[] | null;
  publicationId: string | null;
  authors: string[] | null;
  publishedDate: string | null;
  tags: string[] | null;
  stableId: string | null;
}

interface PGResourcesResponse {
  resources: PGResourceRow[];
  total: number;
}

interface PGCitationsResponse {
  citations: Record<string, string[]>;
  count: number;
}

function pgRowToResource(row: PGResourceRow, citedBy?: string[]): Resource {
  return {
    id: row.id,
    url: row.url,
    title: row.title ?? '',
    type: row.type ?? '',
    authors: row.authors ?? undefined,
    published_date: row.publishedDate ?? undefined,
    abstract: row.abstract ?? undefined,
    summary: row.summary ?? undefined,
    review: row.review ?? undefined,
    key_points: row.keyPoints ?? undefined,
    publication_id: row.publicationId ?? undefined,
    tags: row.tags ?? undefined,
    cited_by: citedBy && citedBy.length > 0 ? citedBy : undefined,
    stable_id: row.stableId ?? undefined,
  };
}

/**
 * Fetch all resources from the wiki-server API (paginated).
 * Returns null if the server is unavailable.
 */
async function fetchResourcesFromPG(): Promise<Resource[] | null> {
  const allResources: PGResourceRow[] = [];
  let offset = 0;
  const limit = 200;

  while (true) {
    const result = await apiRequest<PGResourcesResponse>(
      'GET',
      `/api/resources/all?limit=${limit}&offset=${offset}`,
    );
    if (!result.ok) return null;

    const rows = result.data.resources;
    if (rows.length === 0) break;

    allResources.push(...rows);
    offset += rows.length;
    if (rows.length < limit) break;
  }

  // Fetch bulk citations
  let citationsIndex: Record<string, string[]> = {};
  const citResult = await apiRequest<PGCitationsResponse>(
    'GET',
    '/api/resources/citations/all',
  );
  if (citResult.ok) {
    citationsIndex = citResult.data.citations;
  } else {
    console.warn(`  resources: failed to fetch citations (${citResult.message})`);
  }

  return allResources.map(row =>
    pgRowToResource(row, citationsIndex[row.id])
  );
}

/**
 * Load resources preferring PG, falling back to snapshot.
 *
 * PG resources include stableId and are always fresher than the snapshot.
 * Falls back silently to the snapshot when the wiki-server is unavailable
 * (no env vars, server down, timeout).
 */
export async function loadResourcesPGFirst(): Promise<Resource[]> {
  const pgResources = await fetchResourcesFromPG();
  if (pgResources !== null) {
    return pgResources;
  }
  return loadResources();
}

/**
 * Load just the set of valid resource IDs, preferring PG.
 * Optimized for validation rules that only need to check ID existence.
 */
export async function loadResourceIdsPGFirst(): Promise<Set<string>> {
  const resources = await loadResourcesPGFirst();
  return new Set(resources.map(r => r.id));
}

// ---------------------------------------------------------------------------
// Resource writing — PG-native via batch API
// ---------------------------------------------------------------------------

/** Convert a Resource to the camelCase API payload for PG upsert.
 * Normalizes date formats and generates a stableId for new resources. */
function resourceToSyncPayload(r: Resource): SyncResource {
  return {
    id: r.id,
    url: r.url,
    title: r.title ?? null,
    type: r.type ?? null,
    summary: r.summary ?? null,
    review: r.review ?? null,
    abstract: r.abstract ?? null,
    keyPoints: r.key_points ?? null,
    publicationId: r.publication_id ?? null,
    authors: r.authors ?? null,
    publishedDate: normalizeDate(r.published_date),
    tags: r.tags ?? null,
    localFilename: r.local_filename ?? null,
    credibilityOverride: r.credibility_override ?? null,
    fetchedAt: normalizeTimestamp(r.fetched_at),
    contentHash: r.content_hash ?? null,
    // Generate a stableId for new resources; existing resources pass through
    // their value. The server-side COALESCE preserves existing stableIds.
    stableId: r.stable_id ?? generateId(),
    citedBy: r.cited_by ?? null,
  };
}

/**
 * Save resources to the wiki-server PG database via batch API.
 *
 * Requires the wiki-server to be running. Throws on failure (unlike
 * the old YAML write path, PG writes are the authoritative operation).
 */
export async function saveResources(resources: Resource[]): Promise<void> {
  if (resources.length === 0) return;

  const items: SyncResource[] = resources.map(resourceToSyncPayload);

  for (let i = 0; i < items.length; i += PG_BATCH_SIZE) {
    const batch = items.slice(i, i + PG_BATCH_SIZE);
    const result = await apiRequest<{ upserted: number }>(
      'POST',
      '/api/resources/batch',
      { items: batch },
    );
    if (!result.ok) {
      throw new Error(`Failed to save resources (batch ${Math.floor(i / PG_BATCH_SIZE) + 1}): ${result.message}`);
    }
  }
}

export function loadPages(): PageEntry[] {
  return loadPagesJson();
}

export function loadPublications(): Publication[] {
  const content = readFileSync(PUBLICATIONS_FILE, 'utf-8');
  return (parseYaml(content) || []) as Publication[];
}
