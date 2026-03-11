/**
 * Resource Manager — YAML I/O + PG-first loading
 *
 * Reading and writing resource YAML files, publication loading.
 * `loadResourcesPGFirst()` tries the wiki-server API first, falling back to YAML.
 *
 * Note: Resources are NOT dual-written to the wiki-server here because the
 * server's upsert endpoint does a full column replacement. The in-memory
 * Resource type lacks fields like review, keyPoints, localFilename, etc.
 * that exist in the YAML files, so a fire-and-forget upsert from here would
 * overwrite valid data with nulls. Instead, `crux wiki-server sync-resources`
 * (which reads the full YAML) handles syncing to Postgres.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { loadPages as loadPagesJson, type PageEntry } from './lib/content-types.ts';
import { RESOURCES_DIR, PUBLICATIONS_FILE, FORUM_PUBLICATION_IDS } from './resource-types.ts';
import type { Resource, Publication } from './resource-types.ts';
import { apiRequest } from './lib/wiki-server/client.ts';

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
 */
export function saveResources(resources: Resource[]): void {
  // Group by source file, preserving the original structure
  const byFile: Record<string, Omit<Resource, '_sourceFile'>[]> = {};

  for (const resource of resources) {
    const category = resource._sourceFile || getResourceCategory(resource);
    if (!byFile[category]) byFile[category] = [];
    // Remove internal tracking field before writing
    const { _sourceFile, ...cleanResource } = resource;
    byFile[category].push(cleanResource);
  }

  // Write each file that has resources
  for (const [category, items] of Object.entries(byFile)) {
    const filepath = join(RESOURCES_DIR, `${category}.yaml`);
    const content = stringifyYaml(items, { lineWidth: 100 });
    writeFileSync(filepath, content);
  }
}

export function loadPages(): PageEntry[] {
  return loadPagesJson();
}

export function loadPublications(): Publication[] {
  const content = readFileSync(PUBLICATIONS_FILE, 'utf-8');
  return (parseYaml(content) || []) as Publication[];
}
