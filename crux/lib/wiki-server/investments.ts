/**
 * Investments API — wiki-server client module
 *
 * Response types are inferred from the Hono RPC route type via InferResponseType<>.
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { InvestmentsRoute } from '../../../apps/wiki-server/src/routes/tablebase/investments.ts';

// ---------------------------------------------------------------------------
// Types — response (inferred from Hono RPC route)
// ---------------------------------------------------------------------------

type RpcClient = ReturnType<typeof hc<InvestmentsRoute>>;

export type InvestmentsByEntityResult = InferResponseType<RpcClient['by-entity'][':entityId']['$get'], 200>;

/** A single investment row. */
export type InvestmentEntry = InvestmentsByEntityResult['investments'][number];

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/** Fetch investments for an entity. */
export async function getInvestmentsByEntity(
  entityId: string,
  options?: { limit?: number },
): Promise<ApiResult<InvestmentsByEntityResult>> {
  const params = new URLSearchParams();
  if (options?.limit != null) params.set('limit', String(options.limit));
  const qs = params.toString();
  return apiRequest<InvestmentsByEntityResult>(
    'GET',
    `/api/investments/by-entity/${encodeURIComponent(entityId)}${qs ? `?${qs}` : ''}`,
  );
}
