/**
 * Bluesky API — wiki-server client module
 *
 * Response types are inferred from the Hono RPC route type via InferResponseType<>.
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { BlueskyRoute } from '../../../apps/wiki-server/src/routes/tablebase/bluesky.ts';

// ---------------------------------------------------------------------------
// Types — response (inferred from Hono RPC route)
// ---------------------------------------------------------------------------

type RpcClient = ReturnType<typeof hc<BlueskyRoute>>;

export type BlueskyAccountsResult = InferResponseType<RpcClient['index']['$get'], 200>;
export type BlueskyStatsResult = InferResponseType<RpcClient['stats']['$get'], 200>;
export type BlueskyAllResult = InferResponseType<RpcClient['all']['$get'], 200>;
export type BlueskyResolveDIDResult = InferResponseType<RpcClient['resolve-did']['$post'], 200>;

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/** List bluesky accounts with pagination. */
export async function listBlueskyAccounts(
  options?: { limit?: number; offset?: number },
): Promise<ApiResult<BlueskyAccountsResult>> {
  const params = new URLSearchParams();
  if (options?.limit != null) params.set('limit', String(options.limit));
  if (options?.offset != null) params.set('offset', String(options.offset));
  const qs = params.toString();
  return apiRequest<BlueskyAccountsResult>('GET', `/api/bluesky${qs ? '?' + qs : ''}`);
}

/** Get bluesky feed stats. */
export async function getBlueskyStats(): Promise<ApiResult<BlueskyStatsResult>> {
  return apiRequest<BlueskyStatsResult>('GET', '/api/bluesky/stats');
}

/** Get all bluesky feeds. */
export async function getAllBlueskyFeeds(
  options?: { limit?: number; offset?: number },
): Promise<ApiResult<BlueskyAllResult>> {
  const params = new URLSearchParams();
  if (options?.limit != null) params.set('limit', String(options.limit));
  if (options?.offset != null) params.set('offset', String(options.offset));
  const qs = params.toString();
  return apiRequest<BlueskyAllResult>('GET', `/api/bluesky/all${qs ? `?${qs}` : ''}`);
}

/** Resolve a Bluesky handle to a DID. */
export async function resolveBlueskyDID(
  handle: string,
): Promise<ApiResult<BlueskyResolveDIDResult>> {
  return apiRequest<BlueskyResolveDIDResult>('POST', '/api/bluesky/resolve-did', { handle });
}
