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
export type ClaimsAllResult = InferResponseType<RpcClient['all']['$get'], 200>;
export type ClaimsStatsResult = InferResponseType<RpcClient['stats']['$get'], 200>;
export type ClaimsByEntityResult = InferResponseType<RpcClient['by-entity'][':entityId']['$get'], 200>;

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

/**
 * Fetch paginated list of all claims with optional filters.
 */
export async function getAllClaims(
  params?: { limit?: number; offset?: number; status?: string; target_table?: string; entity_id?: string },
): Promise<ApiResult<ClaimsAllResult>> {
  const query = new URLSearchParams();
  if (params?.limit != null) query.set('limit', String(params.limit));
  if (params?.offset != null) query.set('offset', String(params.offset));
  if (params?.status) query.set('status', params.status);
  if (params?.target_table) query.set('target_table', params.target_table);
  if (params?.entity_id) query.set('entity_id', params.entity_id);
  const qs = query.toString();
  return apiRequest<ClaimsAllResult>('GET', `/api/claims/all${qs ? `?${qs}` : ''}`);
}

/**
 * Fetch aggregate claim metrics.
 */
export async function getClaimsStats(): Promise<ApiResult<ClaimsStatsResult>> {
  return apiRequest<ClaimsStatsResult>('GET', '/api/claims/stats');
}

/**
 * Fetch claims for a specific entity.
 */
export async function getClaimsByEntity(
  entityId: string,
  params?: { limit?: number; offset?: number },
): Promise<ApiResult<ClaimsByEntityResult>> {
  const query = new URLSearchParams();
  if (params?.limit != null) query.set('limit', String(params.limit));
  if (params?.offset != null) query.set('offset', String(params.offset));
  const qs = query.toString();
  return apiRequest<ClaimsByEntityResult>(
    'GET',
    `/api/claims/by-entity/${encodeURIComponent(entityId)}${qs ? `?${qs}` : ''}`,
  );
}
