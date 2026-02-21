/**
 * Entities API — wiki-server client module
 */

import { batchedRequest, getServerUrl, apiRequest, unwrap, type ApiResult } from './client.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SyncEntityItem {
  id: string;
  numericId?: string | null;
  entityType: string;
  title: string;
  description?: string | null;
  website?: string | null;
  tags?: string[] | null;
  clusters?: string[] | null;
  status?: string | null;
  lastUpdated?: string | null;
  customFields?: Array<{ label: string; value: string; link?: string }> | null;
  relatedEntries?: Array<{ id: string; type: string; relationship?: string }> | null;
  sources?: Array<{ title: string; url?: string; author?: string; date?: string }> | null;
}

export interface SyncEntitiesResult {
  upserted: number;
}

export interface EntityEntry {
  id: string;
  numericId: string | null;
  entityType: string;
  title: string;
  description: string | null;
  website: string | null;
  tags: string[] | null;
  clusters: string[] | null;
  status: string | null;
  lastUpdated: string | null;
  customFields: Array<{ label: string; value: string; link?: string }> | null;
  relatedEntries: Array<{ id: string; type: string; relationship?: string }> | null;
  sources: Array<{ title: string; url?: string; author?: string; date?: string }> | null;
  syncedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface EntityListResult {
  entities: EntityEntry[];
  total: number;
  limit: number;
  offset: number;
}

export interface EntitySearchResult {
  results: EntityEntry[];
  query: string;
  total: number;
}

export interface EntityStatsResult {
  total: number;
  byType: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ENTITY_BATCH_SIZE = 200;

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Sync entities to the wiki-server.
 * Splits into batches for large entity sets.
 */
export async function syncEntities(
  items: SyncEntityItem[],
): Promise<ApiResult<SyncEntitiesResult>> {
  const serverUrl = getServerUrl();
  if (!serverUrl) return { ok: false, error: 'unavailable', message: 'LONGTERMWIKI_SERVER_URL not set' };

  let totalUpserted = 0;

  for (let i = 0; i < items.length; i += ENTITY_BATCH_SIZE) {
    const batch = items.slice(i, i + ENTITY_BATCH_SIZE);

    const result = await batchedRequest<SyncEntitiesResult>(
      'POST',
      '/api/entities/sync',
      { entities: batch },
    );

    if (!result.ok) {
      console.warn(`  WARNING: Entity sync batch failed: ${result.message}`);
      return result;
    }

    totalUpserted += result.data.upserted;
  }

  return { ok: true, data: { upserted: totalUpserted } };
}

export async function getEntity(
  id: string,
): Promise<ApiResult<EntityEntry>> {
  return apiRequest<EntityEntry>('GET', `/api/entities/${encodeURIComponent(id)}`);
}

export async function listEntities(
  limit = 50,
  offset = 0,
  entityType?: string,
): Promise<ApiResult<EntityListResult>> {
  let path = `/api/entities?limit=${limit}&offset=${offset}`;
  if (entityType) path += `&entityType=${encodeURIComponent(entityType)}`;
  return apiRequest<EntityListResult>('GET', path);
}

export async function searchEntities(
  q: string,
  limit = 20,
): Promise<ApiResult<EntitySearchResult>> {
  return apiRequest<EntitySearchResult>(
    'GET',
    `/api/entities/search?q=${encodeURIComponent(q)}&limit=${limit}`,
  );
}

export async function getEntityStats(): Promise<ApiResult<EntityStatsResult>> {
  return apiRequest<EntityStatsResult>('GET', '/api/entities/stats');
}

// ---------------------------------------------------------------------------
// Backward-compatible wrappers
// ---------------------------------------------------------------------------

/** @deprecated Use the ApiResult-returning version and handle errors explicitly. */
export const syncEntities_compat = async (items: SyncEntityItem[]) =>
  unwrap(await syncEntities(items));

/** @deprecated Use the ApiResult-returning version and handle errors explicitly. */
export const getEntity_compat = async (id: string) =>
  unwrap(await getEntity(id));

/** @deprecated Use the ApiResult-returning version and handle errors explicitly. */
export const listEntities_compat = async (limit = 50, offset = 0, entityType?: string) =>
  unwrap(await listEntities(limit, offset, entityType));

/** @deprecated Use the ApiResult-returning version and handle errors explicitly. */
export const searchEntities_compat = async (q: string, limit = 20) =>
  unwrap(await searchEntities(q, limit));

/** @deprecated Use the ApiResult-returning version and handle errors explicitly. */
export const getEntityStats_compat = async () =>
  unwrap(await getEntityStats());
