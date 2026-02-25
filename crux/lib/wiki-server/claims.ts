/**
 * Claims API — wiki-server client module
 *
 * Input types are derived from the canonical Zod schemas in api-types.ts.
 * Response types are imported from the canonical api-types.ts definitions.
 */

import { apiRequest, type ApiResult } from './client.ts';
import type {
  InsertClaim,
  InsertClaimResult,
  InsertClaimBatchResult,
  ClearClaimsResult,
  ClaimRow,
  GetClaimsResult,
} from '../../../apps/wiki-server/src/api-types.ts';

// ---------------------------------------------------------------------------
// Types — input (derived from server Zod schemas)
// ---------------------------------------------------------------------------

export type InsertClaimItem = InsertClaim;

// ---------------------------------------------------------------------------
// Types — response (re-exported from canonical api-types.ts)
// ---------------------------------------------------------------------------

export type { InsertClaimResult, InsertClaimBatchResult, ClearClaimsResult, ClaimRow, GetClaimsResult };

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export async function getClaimsByEntity(
  entityId: string,
): Promise<ApiResult<GetClaimsResult>> {
  return apiRequest<GetClaimsResult>(
    'GET',
    `/api/claims/by-entity/${encodeURIComponent(entityId)}`,
  );
}

export async function insertClaim(
  item: InsertClaimItem,
): Promise<ApiResult<InsertClaimResult>> {
  return apiRequest<InsertClaimResult>('POST', '/api/claims', item, undefined, 'content');
}

export async function insertClaimBatch(
  items: InsertClaimItem[],
): Promise<ApiResult<InsertClaimBatchResult>> {
  return apiRequest<InsertClaimBatchResult>(
    'POST',
    '/api/claims/batch',
    { items },
    undefined,
    'content',
  );
}

export async function clearClaimsForEntity(
  entityId: string,
): Promise<ApiResult<ClearClaimsResult>> {
  return apiRequest<ClearClaimsResult>(
    'POST',
    '/api/claims/clear',
    { entityId },
    undefined,
    'content',
  );
}

