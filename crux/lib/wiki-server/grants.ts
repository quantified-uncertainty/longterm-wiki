/**
 * Grants API — wiki-server client module
 *
 * Response types are inferred from the Hono RPC route type via InferResponseType<>.
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { GrantsRoute } from '../../../apps/wiki-server/src/routes/tablebase/grants.ts';

// ---------------------------------------------------------------------------
// Types — response (inferred from Hono RPC route)
// ---------------------------------------------------------------------------

type RpcClient = ReturnType<typeof hc<GrantsRoute>>;

export type GrantsByEntityResult = InferResponseType<RpcClient['by-entity'][':entityId']['$get'], 200>;
export type GrantsSyncResult = InferResponseType<RpcClient['sync']['$post'], 200>;
export type GrantsAllGranteeIdsResult = InferResponseType<RpcClient['all-grantee-ids']['$get'], 200>;
export type GrantsBatchUpdateGranteeResult = InferResponseType<RpcClient['batch-update-grantee']['$patch'], 200>;

/** A single grant row. */
export type GrantEntry = GrantsByEntityResult['grants'][number];

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/** Fetch grants for an entity. */
export async function getGrantsByEntity(
  entityId: string,
  options?: { limit?: number },
): Promise<ApiResult<GrantsByEntityResult>> {
  const params = new URLSearchParams();
  if (options?.limit != null) params.set('limit', String(options.limit));
  const qs = params.toString();
  return apiRequest<GrantsByEntityResult>(
    'GET',
    `/api/grants/by-entity/${encodeURIComponent(entityId)}${qs ? `?${qs}` : ''}`,
  );
}

/** Sync grants (upsert). */
export async function syncGrants(
  items: Array<Record<string, unknown>>,
  options?: {
    /** Bypass server-side sourcing enforcement. Requires reason for audit logging. */
    forceSkipSourcing?: boolean;
    forceSkipSourcingReason?: string;
  },
): Promise<ApiResult<GrantsSyncResult>> {
  const params = new URLSearchParams();
  if (options?.forceSkipSourcing) {
    params.set('forceSkipSourcing', 'true');
    if (options.forceSkipSourcingReason) {
      params.set('reason', options.forceSkipSourcingReason);
    }
  }
  const qs = params.toString();
  return apiRequest<GrantsSyncResult>('POST', `/api/grants/sync${qs ? `?${qs}` : ''}`, { items });
}

/** Fetch all grant grantee IDs (for normalize-ids). */
export async function getAllGranteeIds(): Promise<ApiResult<GrantsAllGranteeIdsResult>> {
  return apiRequest<GrantsAllGranteeIdsResult>('GET', '/api/grants/all-grantee-ids');
}

/** Batch update grantee IDs on grants. */
export async function batchUpdateGrantee(
  items: Array<{ id: string; granteeId: string }>,
): Promise<ApiResult<GrantsBatchUpdateGranteeResult>> {
  return apiRequest<GrantsBatchUpdateGranteeResult>('PATCH', '/api/grants/batch-update-grantee', { items });
}

export type GrantsDeleteBatchResult = InferResponseType<RpcClient['delete-batch']['$post'], 200>;

/** Delete a batch of grants by ID. */
export async function deleteGrantBatch(
  ids: string[],
): Promise<ApiResult<GrantsDeleteBatchResult>> {
  return apiRequest<GrantsDeleteBatchResult>('POST', '/api/grants/delete-batch', { ids });
}
