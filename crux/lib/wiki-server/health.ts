/**
 * Health API — wiki-server client module
 *
 * Response types are inferred from the Hono RPC route type via InferResponseType<>.
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { HealthRoute } from '../../../apps/wiki-server/src/routes/operational/health.ts';

// ---------------------------------------------------------------------------
// Types — response (inferred from Hono RPC route)
// ---------------------------------------------------------------------------

type RpcClient = ReturnType<typeof hc<HealthRoute>>;

export type HealthResult = InferResponseType<RpcClient['index']['$get'], 200>;

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/** Get wiki-server health status. */
export async function getHealth(): Promise<ApiResult<HealthResult>> {
  return apiRequest<HealthResult>('GET', '/health');
}
