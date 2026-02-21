/**
 * Claims API — wiki-server client module
 */

import { apiRequest, unwrap, type ApiResult } from './client.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InsertClaimItem {
  entityId: string;
  entityType: string;
  claimType: string;
  claimText: string;
  value?: string | null;
  unit?: string | null;
  confidence?: string | null;
  sourceQuote?: string | null;
}

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

// ---------------------------------------------------------------------------
// Backward-compatible wrappers
// ---------------------------------------------------------------------------

/** @deprecated Use the ApiResult-returning version and handle errors explicitly. */
export const insertClaim_compat = async (item: InsertClaimItem) =>
  unwrap(await insertClaim(item));

/** @deprecated Use the ApiResult-returning version and handle errors explicitly. */
export const insertClaimBatch_compat = async (items: InsertClaimItem[]) =>
  unwrap(await insertClaimBatch(items));

/** @deprecated Use the ApiResult-returning version and handle errors explicitly. */
export const clearClaimsForEntity_compat = async (entityId: string) =>
  unwrap(await clearClaimsForEntity(entityId));
