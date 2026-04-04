/**
 * Prediction Markets API — wiki-server client module
 *
 * Response types are inferred from the Hono RPC route type via InferResponseType<>.
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { PredictionMarketsRoute } from '../../../apps/wiki-server/src/routes/tablebase/prediction-markets.ts';

// ---------------------------------------------------------------------------
// Types — response (inferred from Hono RPC route)
// ---------------------------------------------------------------------------

type RpcClient = ReturnType<typeof hc<PredictionMarketsRoute>>;

export type MarketSearchResult = InferResponseType<RpcClient['search']['$get'], 200>;
export type MarketSyncResult = InferResponseType<RpcClient['sync']['$post'], 200>;
export type MarketQuestionsResult = InferResponseType<RpcClient['questions']['$get'], 200>;

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/** Search prediction markets. */
export async function searchMarkets(
  query: string,
  options?: { limit?: number; platform?: string },
): Promise<ApiResult<MarketSearchResult>> {
  const params = new URLSearchParams();
  params.set('q', query);
  if (options?.limit != null) params.set('limit', String(options.limit));
  if (options?.platform) params.set('platform', options.platform);
  return apiRequest<MarketSearchResult>(
    'GET',
    `/api/prediction-markets/search?${params.toString()}`,
  );
}

/** Sync prediction market questions (upsert). */
export async function syncMarkets(
  items: Array<Record<string, unknown>>,
): Promise<ApiResult<MarketSyncResult>> {
  return apiRequest<MarketSyncResult>('POST', '/api/prediction-markets/sync', { items });
}

/** Get prediction market questions with filters. */
export async function getMarketQuestions(
  options?: { entityId?: string; platform?: string; limit?: number; offset?: number },
): Promise<ApiResult<MarketQuestionsResult>> {
  const params = new URLSearchParams();
  if (options?.entityId) params.set('entity_id', options.entityId);
  if (options?.platform) params.set('platform', options.platform);
  if (options?.limit != null) params.set('limit', String(options.limit));
  if (options?.offset != null) params.set('offset', String(options.offset));
  const qs = params.toString();
  return apiRequest<MarketQuestionsResult>(
    'GET',
    `/api/prediction-markets/questions${qs ? `?${qs}` : ''}`,
  );
}
