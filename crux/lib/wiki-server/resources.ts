/**
 * Resources API — wiki-server client module
 *
 * Input types are derived from the canonical Zod schemas in api-types.ts.
 * Response types are inferred from the Hono RPC route type via InferResponseType<>.
 */

import { apiRequest, batchedRequest, type ApiResult } from './client.ts';
import type { UpsertResource, UpdateResourceFetchStatus, SuggestResources } from '../../../apps/wiki-server/src/api-types.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { ResourcesRoute } from '../../../apps/wiki-server/src/routes/wikibase/resources.ts';

// ---------------------------------------------------------------------------
// Types — input (derived from server Zod schemas)
// ---------------------------------------------------------------------------

export type UpsertResourceItem = UpsertResource;

// ---------------------------------------------------------------------------
// Types — response (inferred from Hono RPC route)
// ---------------------------------------------------------------------------

type RpcClient = ReturnType<typeof hc<ResourcesRoute>>;

export type UpsertResourceResult = InferResponseType<RpcClient['index']['$post'], 201>;
export type ResourceRow = InferResponseType<RpcClient['lookup']['$get'], 200>;
export type ResourceStatsResult = InferResponseType<RpcClient['stats']['$get'], 200>;
export type ResourceSearchResult = InferResponseType<RpcClient['search']['$get'], 200>;
export type ResourceListResult = InferResponseType<RpcClient['all']['$get'], 200>;
export type UpdateFetchStatusResult = InferResponseType<RpcClient[':id']['fetch-status']['$patch'], 200>;
export type BatchDetailsResult = InferResponseType<RpcClient['batch-details']['$post'], 201>;
export type ResourceWithContentResult = InferResponseType<RpcClient[':id']['content']['$get'], 200>;
export type UpdateAuthorEntityIdsResult = InferResponseType<RpcClient['author-entity-ids']['$patch'], 200>;

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export async function upsertResource(
  item: UpsertResourceItem,
): Promise<ApiResult<UpsertResourceResult>> {
  return apiRequest<UpsertResourceResult>('POST', '/api/resources', item);
}

export async function upsertResourceBatch(
  items: UpsertResourceItem[],
): Promise<ApiResult<{ upserted: number; results: Array<{ id: string; url: string }> }>> {
  return apiRequest('POST', '/api/resources/batch', { items });
}

export async function getResource(
  id: string,
): Promise<ApiResult<ResourceRow & { citedBy: string[] }>> {
  return apiRequest('GET', `/api/resources/${encodeURIComponent(id)}`);
}

export async function getResourceWithContent(
  id: string,
): Promise<ApiResult<ResourceWithContentResult>> {
  return apiRequest<ResourceWithContentResult>('GET', `/api/resources/${encodeURIComponent(id)}/content`);
}

export async function lookupResourceByUrl(
  url: string,
): Promise<ApiResult<ResourceRow>> {
  return apiRequest('GET', `/api/resources/lookup?url=${encodeURIComponent(url)}`);
}

export async function searchResources(
  query: string,
  limit = 20,
): Promise<ApiResult<ResourceSearchResult>> {
  return apiRequest('GET', `/api/resources/search?q=${encodeURIComponent(query)}&limit=${limit}`);
}

export async function getResourcesByPage(
  pageId: string,
): Promise<ApiResult<{ resources: ResourceRow[] }>> {
  return apiRequest('GET', `/api/resources/by-page/${encodeURIComponent(pageId)}`);
}

export async function getResourceStats(): Promise<ApiResult<ResourceStatsResult>> {
  return apiRequest('GET', '/api/resources/stats');
}

export async function listResources(
  limit = 50,
  offset = 0,
  type?: string,
): Promise<ApiResult<ResourceListResult>> {
  let url = `/api/resources/all?limit=${limit}&offset=${offset}`;
  if (type) url += `&type=${encodeURIComponent(type)}`;
  return apiRequest('GET', url);
}

export async function updateResourceFetchStatus(
  id: string,
  status: UpdateResourceFetchStatus,
): Promise<ApiResult<UpdateFetchStatusResult>> {
  return apiRequest<UpdateFetchStatusResult>(
    'PATCH',
    `/api/resources/${encodeURIComponent(id)}/fetch-status`,
    status,
  );
}

// ---------------------------------------------------------------------------
// Duplicate detection (content hash lookup)
// ---------------------------------------------------------------------------

export type ContentHashMatch = { id: string; url: string; title: string | null };

/**
 * Find resources with the same content hash, excluding a given resource ID.
 * Used during ingestion to flag potential duplicates.
 */
export async function findResourcesByContentHash(
  contentHash: string,
  excludeId?: string,
): Promise<ApiResult<{ resources: ContentHashMatch[] }>> {
  let url = `/api/resources/by-content-hash?hash=${encodeURIComponent(contentHash)}`;
  if (excludeId) url += `&excludeId=${encodeURIComponent(excludeId)}`;
  return apiRequest('GET', url);
}

// ---------------------------------------------------------------------------
// Suggest resources (claims-first sourcing pipeline)
// ---------------------------------------------------------------------------

export type SuggestResourcesResult = InferResponseType<RpcClient['suggest']['$post'], 200>;

export async function suggestResourcesApi(
  input: SuggestResources,
): Promise<ApiResult<SuggestResourcesResult>> {
  return apiRequest<SuggestResourcesResult>('POST', '/api/resources/suggest', input);
}

/**
 * Batch upsert resource sub-table details (papers, forum posts, policy docs).
 * Uses a longer timeout for large batches.
 */
export async function batchResourceDetails(
  body: Record<string, unknown>,
): Promise<ApiResult<BatchDetailsResult>> {
  return batchedRequest<BatchDetailsResult>('POST', '/api/resources/batch-details', body);
}

/**
 * Update a resource's archive_url via the batch endpoint.
 * Used by source-fetcher when Wayback Machine content is found for a dead link.
 */
export async function updateResourceArchiveUrl(
  id: string,
  archiveUrl: string,
): Promise<ApiResult<{ upserted: number; results: Array<{ id: string; url: string }> }>> {
  return apiRequest('POST', '/api/resources/batch', {
    items: [{ id, archiveUrl }],
  });
}

/** Batch update authorEntityIds for resources. */
export async function updateAuthorEntityIds(
  items: Array<{ resourceId: string; authorEntityIds: string[] }>,
): Promise<ApiResult<UpdateAuthorEntityIdsResult>> {
  return apiRequest<UpdateAuthorEntityIdsResult>('PATCH', '/api/resources/author-entity-ids', { items });
}
