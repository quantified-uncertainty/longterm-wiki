/**
 * Entity Resources API — wiki-server client module
 *
 * Response types are inferred from the Hono RPC route type via InferResponseType<>.
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { EntityResourcesRoute } from '../../../apps/wiki-server/src/routes/tablebase/entity-resources.ts';

// ---------------------------------------------------------------------------
// Types — response (inferred from Hono RPC route)
// ---------------------------------------------------------------------------

type RpcClient = ReturnType<typeof hc<EntityResourcesRoute>>;

export type EntityResourcesGetResult = InferResponseType<RpcClient['index']['$get'], 200>;
export type EntityResourcesSyncResult = InferResponseType<RpcClient['sync']['$post'], 200>;

/** A single entity_resources row. */
export type EntityResourceRow = EntityResourcesGetResult['items'][number];

/** Input shape for sync items. */
export interface EntityResourceSyncItem {
  entityId: string;
  resourceId: string;
  authoredByEntity?: boolean;
  isSubject?: boolean;
  inferenceSource?: string | null;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/** Fetch entity-resource links for an entity. */
export async function getEntityResources(
  entityId: string,
  filters?: { authoredByEntity?: boolean; isSubject?: boolean },
): Promise<ApiResult<EntityResourcesGetResult>> {
  const params = new URLSearchParams({ entityId });
  if (filters?.authoredByEntity != null)
    params.set('authoredByEntity', String(filters.authoredByEntity));
  if (filters?.isSubject != null)
    params.set('isSubject', String(filters.isSubject));
  return apiRequest<EntityResourcesGetResult>(
    'GET',
    `/api/entity-resources?${params.toString()}`,
  );
}

/** Batch upsert entity-resource links (OR-merges boolean flags). */
export async function syncEntityResources(
  items: EntityResourceSyncItem[],
): Promise<ApiResult<EntityResourcesSyncResult>> {
  return apiRequest<EntityResourcesSyncResult>(
    'POST',
    '/api/entity-resources/sync',
    { items },
  );
}
