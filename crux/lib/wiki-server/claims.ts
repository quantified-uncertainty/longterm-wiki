/**
 * Claims API — wiki-server client module
 *
 * Part of the claims-first verification architecture (#3253).
 * Response types are inferred from the Hono RPC route type via InferResponseType<>.
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { ClaimsRoute } from '../../../apps/wiki-server/src/routes/claims/claims.ts';

// ---------------------------------------------------------------------------
// Types — response (inferred from Hono RPC route)
// ---------------------------------------------------------------------------

type RpcClient = ReturnType<typeof hc<ClaimsRoute>>;

export type ClaimStatusResult = InferResponseType<RpcClient['status'][':batchId']['$get'], 200>;

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Poll verification status for a batch of claims.
 *
 * Returns per-claim verdicts and an aggregate summary.
 * `allSettled` is true when no claims are still pending or verifying.
 */
export async function getClaimStatus(
  batchId: string,
): Promise<ApiResult<ClaimStatusResult>> {
  return apiRequest<ClaimStatusResult>(
    'GET',
    `/api/claims/status/${encodeURIComponent(batchId)}`,
  );
}
