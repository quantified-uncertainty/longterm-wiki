/**
 * Claims API — wiki-server client module
 *
 * Part of the claims-first verification architecture (#3253).
 * Response types are inferred from the Hono RPC route type via InferResponseType<>.
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { ProposeClaims } from '../../../apps/wiki-server/src/api-types.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { ClaimsRoute } from '../../../apps/wiki-server/src/routes/claims/claims.ts';

// ---------------------------------------------------------------------------
// Types — response (inferred from Hono RPC route)
// ---------------------------------------------------------------------------

type RpcClient = ReturnType<typeof hc<ClaimsRoute>>;

export type ClaimStatusResult = InferResponseType<RpcClient['status'][':batchId']['$get'], 200>;
export type ProposeClaimsResult = InferResponseType<RpcClient['propose']['$post'], 201>;

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Submit a batch of claims for async verification.
 *
 * Creates proposed_claims rows and dispatches verification jobs
 * batched by resource. Returns a batchId for polling via getClaimStatus().
 */
export async function proposeClaims(
  input: ProposeClaims,
): Promise<ApiResult<ProposeClaimsResult>> {
  return apiRequest<ProposeClaimsResult>('POST', '/api/claims/propose', input);
}

/**
 * Poll verification status for a batch of claims.
 */
export async function getClaimStatus(
  batchId: string,
): Promise<ApiResult<ClaimStatusResult>> {
  return apiRequest<ClaimStatusResult>(
    'GET',
    `/api/claims/status/${encodeURIComponent(batchId)}`,
  );
}
