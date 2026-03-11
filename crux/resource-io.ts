/**
 * Resource Manager — YAML I/O + PG-first loading + dual-write
 *
 * Reading and writing resource YAML files, publication loading.
 * `loadResourcesPGFirst()` tries the wiki-server API first, falling back to YAML.
 *
 * Dual-write: `saveResources()` writes to YAML first, then fire-and-forget
 * syncs to PG via the wiki-server batch API. This keeps PG in sync without
 * requiring manual `crux wiki-server sync-resources` runs. The YAML write
 * is the authoritative operation; the PG sync is best-effort.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { loadPages as loadPagesJson, type PageEntry } from './lib/content-types.ts';
import { RESOURCES_DIR, PUBLICATIONS_FILE, FORUM_PUBLICATION_IDS } from './resource-types.ts';
import type { Resource, Publication } from './resource-types.ts';
import { apiRequest } from './lib/wiki-server/client.ts';
import { normalizeDate, normalizeTimestamp, type SyncResource } from './wiki-server/sync-resources.ts';

/**
 * Determine which file a new resource belongs to based on type/publication.
 * Only used for NEW resources that don't have a source file yet.
 */
export function getResourceCategory(resource: Resource): string {
  if (resource.type === 'paper') return 'papers';
  if (resource.type === 'government') return 'government';
  if (resource.type === 'reference') return 'reference';
  if (resource.publication_id && FORUM_PUBLICATION_IDS.has(resource.publication_id)) return 'forums';
  // Check URL domain for better categorization
  if (resource.url) {
    try {
      const domain = new URL(resource.url).hostname.replace('www.', '');
      if (['nature.com', 'science.org', 'springer.com', 'wiley.com', 'sciencedirect.com'].some(d => domain.includes(d))) return 'academic';
      if (['openai.com', 'anthropic.com', 'deepmind.com', 'google.com/deepmind'].some(d => domain.includes(d))) return 'ai-labs';
      if (['nytimes.com', 'washingtonpost.com', 'bbc.com', 'reuters.com', 'theguardian.com'].some(d => domain.includes(d))) return 'news-media';
    } catch (_err: unknown) {}
  }
  return 'web-other';
}

/**
 * Load all resources from the split directory.
 * Tags each resource with _sourceFile so we can write back to the same file.
 */
export function loadResources(): Resource[] {
  const resources: Resource[] = [];
  if (!existsSync(RESOURCES_DIR)) {
    return resources;
  }

  const files = readdirSync(RESOURCES_DIR).filter((f) => f.endsWith('.yaml'));
  for (const file of files) {
    const filepath = join(RESOURCES_DIR, file);
    const content = readFileSync(filepath, 'utf-8');
    const data = (parseYaml(content) || []) as Resource[];
    const category = file.replace('.yaml', '');
    for (const resource of data) {
      resource._sourceFile = category;
    }
    resources.push(...data);
  }
  return resources;
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
 * Load resources preferring PG, falling back to YAML.
 *
 * PG resources include stableId and are always fresher than YAML.
 * Falls back silently to YAML when the wiki-server is unavailable
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

/**
 * Save resources back to their source files, preserving the existing directory structure.
 * New resources (without _sourceFile) are categorized by getResourceCategory().
 *
 * After writing YAML, fires a best-effort sync to PG via the wiki-server API.
 * YAML is authoritative; PG sync failures are logged but don't block.
 */
export function saveResources(resources: Resource[]): void {
  // Group by source file, preserving the original structure
  const byFile: Record<string, Omit<Resource, '_sourceFile'>[]> = {};
  const cleanResources: Resource[] = [];

  for (const resource of resources) {
    const category = resource._sourceFile || getResourceCategory(resource);
    if (!byFile[category]) byFile[category] = [];
    // Remove internal tracking field before writing
    const { _sourceFile, ...cleanResource } = resource;
    byFile[category].push(cleanResource);
    cleanResources.push(cleanResource);
  }

  // Write each file that has resources
  for (const [category, items] of Object.entries(byFile)) {
    const filepath = join(RESOURCES_DIR, `${category}.yaml`);
    const content = stringifyYaml(items, { lineWidth: 100 });
    writeFileSync(filepath, content);
  }

  // Fire-and-forget: sync to PG
  syncResourcesToPG(cleanResources).catch((e: unknown) => {
    console.warn(`  resources: PG dual-write failed (${e instanceof Error ? e.message : String(e)})`);
  });
}

// ---------------------------------------------------------------------------
// Dual-write: YAML → PG sync
// ---------------------------------------------------------------------------

const PG_BATCH_SIZE = 200;

/**
 * Convert a Resource to the camelCase API payload for PG sync.
 *
 * Similar to transformResource() in sync-resources.ts, but operates on the
 * in-memory Resource type (not YamlResource) and passes through existing
 * stable_id instead of generating a new one each time.
 */
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
    // Pass through existing stable_id; server-side COALESCE preserves it.
    // Resources without a stable_id will get one assigned by the full sync.
    stableId: r.stable_id ?? null,
    citedBy: r.cited_by ?? null,
  };
}

/**
 * Sync resources to the wiki-server PG database via batch API.
 * Best-effort: failures are logged but don't block the caller.
 *
 * Note: This runs fire-and-forget from saveResources(). If the process
 * exits before completion, PG will catch up on the next full sync
 * (`pnpm crux wiki-server sync-resources`).
 */
async function syncResourcesToPG(resources: Resource[]): Promise<void> {
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
      console.warn(`  resources: PG batch ${Math.floor(i / PG_BATCH_SIZE) + 1} failed (${result.message})`);
      return;
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
