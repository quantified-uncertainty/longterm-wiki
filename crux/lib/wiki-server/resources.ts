/**
 * Resources API — wiki-server client module
 *
 * Input types are derived from the canonical Zod schemas in api-types.ts.
 * Response types are inferred from the Hono RPC route type via InferResponseType<>.
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { UpsertResource, UpdateResourceFetchStatus } from '../../../apps/wiki-server/src/api-types.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { ResourcesRoute } from '../../../apps/wiki-server/src/routes/resources.ts';

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
): Promise<ApiResult<ResourceRow & { content: Record<string, unknown> | null }>> {
  return apiRequest('GET', `/api/resources/${encodeURIComponent(id)}/content`);
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
