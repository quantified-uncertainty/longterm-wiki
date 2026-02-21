/**
 * Claims API — wiki-server client module
 *
 * Input types are derived from the canonical Zod schemas in api-types.ts.
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { InsertClaim } from '../../../apps/wiki-server/src/api-types.ts';

// ---------------------------------------------------------------------------
// Types — input (derived from server Zod schemas)
// ---------------------------------------------------------------------------

export type InsertClaimItem = InsertClaim;

export interface InsertClaimResult {
  id: number;
  entityId: string;
  claimType: string;
}

export interface InsertClaimBatchResult {
  inserted: number;
  results: Array<{ id: number; entityId: string; claimType: string }>;
}

export interface ClearClaimsResult {
  deleted: number;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export async function insertClaim(
  item: InsertClaimItem,
): Promise<ApiResult<InsertClaimResult>> {
  return apiRequest<InsertClaimResult>('POST', '/api/claims', item);
}

export async function insertClaimBatch(
  items: InsertClaimItem[],
): Promise<ApiResult<InsertClaimBatchResult>> {
  return apiRequest<InsertClaimBatchResult>(
    'POST',
    '/api/claims/batch',
    { items },
  );
}

export async function clearClaimsForEntity(
  entityId: string,
): Promise<ApiResult<ClearClaimsResult>> {
  return apiRequest<ClearClaimsResult>(
    'POST',
    '/api/claims/clear',
    { entityId },
  );
}

