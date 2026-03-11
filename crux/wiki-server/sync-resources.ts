/**
 * Resource Sync — types, helpers, and batch sync for PG resources.
 *
 * Originally read YAML files from data/resources/ and bulk-upserted them.
 * Since R6, YAML files are deleted and PG is the sole source of truth.
 * This module is kept for:
 *   - Type exports (SyncResource, YamlResource)
 *   - Date normalization helpers (normalizeDate, normalizeTimestamp)
 *   - transformResource() for converting snake_case → camelCase payloads
 *   - syncResources() for batch upserting via the /api/resources/batch endpoint
 *
 * Reuses the shared batch sync infrastructure from sync-common.ts:
 *   - Per-batch retry with exponential backoff (handles transient 5xx errors)
 *   - Fast-fail after N consecutive batch failures
 */

import { generateId } from "../../packages/kb/src/ids.ts";
import { batchSync } from "./sync-common.ts";

// --- Types ---

export interface YamlResource {
  id: string;
  url: string;
  title?: string;
  type?: string;
  summary?: string;
  review?: string;
  abstract?: string;
  key_points?: string[];
  publication_id?: string;
  authors?: string[];
  published_date?: string | Date;
  tags?: string[];
  local_filename?: string;
  credibility_override?: number;
  fetched_at?: string | Date;
  content_hash?: string;
  cited_by?: string[];
}

export interface SyncResource {
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
  localFilename: string | null;
  credibilityOverride: number | null;
  fetchedAt: string | null;
  contentHash: string | null;
  stableId: string | null;
  citedBy: string[] | null;
}

// --- Helpers ---

export function normalizeDate(d: string | Date | undefined): string | null {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString().split("T")[0];
  const dateStr = String(d).split(" ")[0];
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  return null;
}

export function normalizeTimestamp(d: string | Date | undefined): string | null {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString();
  const str = String(d);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(str)) {
    return str.replace(" ", "T") + "Z";
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return str + "T00:00:00Z";
  }
  try {
    const parsed = new Date(str);
    if (isNaN(parsed.getTime())) return null;
    return parsed.toISOString();
  } catch {
    return null;
  }
}

export function transformResource(r: YamlResource): SyncResource {
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
    // Generate a 10-char alphanumeric stableId for each resource.
    // The COALESCE in the upsert handler preserves existing stableIds.
    stableId: generateId(),
    citedBy: r.cited_by ?? null,
  };
}

/**
 * Sync resources to the wiki-server in batches.
 * Exported for testing.
 */
export async function syncResources(
  serverUrl: string,
  items: SyncResource[],
  batchSize: number,
  options: {
    _sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<{ upserted: number; errors: number }> {
  const result = await batchSync(
    `${serverUrl}/api/resources/batch`,
    items,
    batchSize,
    {
      bodyKey: "items",
      responseCountKey: "upserted",
      itemLabel: "resources",
      _sleep: options._sleep,
    },
  );

  return { upserted: result.count, errors: result.errors };
}
