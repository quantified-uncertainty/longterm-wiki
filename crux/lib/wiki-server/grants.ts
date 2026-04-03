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
): Promise<ApiResult<GrantsSyncResult>> {
  return apiRequest<GrantsSyncResult>('POST', '/api/grants/sync', { items });
}
