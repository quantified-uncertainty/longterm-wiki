/**
 * Funding Rounds API — wiki-server client module
 *
 * Response types are inferred from the Hono RPC route type via InferResponseType<>.
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { FundingRoundsRoute } from '../../../apps/wiki-server/src/routes/tablebase/funding-rounds.ts';

// ---------------------------------------------------------------------------
// Types — response (inferred from Hono RPC route)
// ---------------------------------------------------------------------------

type RpcClient = ReturnType<typeof hc<FundingRoundsRoute>>;

export type FundingRoundsByEntityResult = InferResponseType<RpcClient['by-entity'][':entityId']['$get'], 200>;
export type FundingRoundsSyncResult = InferResponseType<RpcClient['sync']['$post'], 200>;

/** A single funding round row. */
export type FundingRoundEntry = FundingRoundsByEntityResult['fundingRounds'][number];

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/** Fetch funding rounds for an entity. */
export async function getFundingRoundsByEntity(
  entityId: string,
  options?: { limit?: number },
): Promise<ApiResult<FundingRoundsByEntityResult>> {
  const params = new URLSearchParams();
  if (options?.limit != null) params.set('limit', String(options.limit));
  const qs = params.toString();
  return apiRequest<FundingRoundsByEntityResult>(
    'GET',
    `/api/funding-rounds/by-entity/${encodeURIComponent(entityId)}${qs ? `?${qs}` : ''}`,
  );
}
