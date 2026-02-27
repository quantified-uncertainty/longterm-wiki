/**
 * Claims API — wiki-server client module
 *
 * Input types are derived from the canonical Zod schemas in api-types.ts.
 * Response types are inferred from the Hono RPC route type (ClaimsRoute) to
 * stay in sync automatically when the server shape changes.
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { InsertClaim } from '../../../apps/wiki-server/src/api-types.ts';
import type { ClaimPageReferenceRow } from './references.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { ClaimsRoute } from '../../../apps/wiki-server/src/routes/claims.ts';

// ---------------------------------------------------------------------------
// RPC type inference — response shapes derived from the server route
// ---------------------------------------------------------------------------

type RpcClient = ReturnType<typeof hc<ClaimsRoute>>;

export type InsertClaimResult = InferResponseType<RpcClient['index']['$post'], 201>;
export type InsertClaimBatchResult = InferResponseType<RpcClient['batch']['$post'], 201>;
export type ClearClaimsResult = InferResponseType<RpcClient['clear']['$post'], 200>;
export type GetClaimsResult = InferResponseType<RpcClient['by-entity'][':entityId']['$get'], 200>;
export type ClaimStatsResult = InferResponseType<RpcClient['stats']['$get'], 200>;
export type ClaimRow = GetClaimsResult['claims'][number];
export type ClaimSourceRow = InferResponseType<RpcClient[':id']['sources']['$get'], 200>['sources'][number];

// ---------------------------------------------------------------------------
// Types — input (derived from server Zod schemas)
// ---------------------------------------------------------------------------

export type InsertClaimItem = InsertClaim;

// ---------------------------------------------------------------------------
// Types — re-exported for consumers
// ---------------------------------------------------------------------------

export type { ClaimPageReferenceRow };

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export async function getClaimsByEntity(
  entityId: string,
  options?: { includeSources?: boolean },
): Promise<ApiResult<GetClaimsResult>> {
  const params = options?.includeSources ? '?includeSources=true' : '';
  return apiRequest<GetClaimsResult>(
    'GET',
    `/api/claims/by-entity/${encodeURIComponent(entityId)}${params}`,
  );
}

export async function getClaimSources(
  claimId: number,
): Promise<ApiResult<{ sources: ClaimSourceRow[] }>> {
  return apiRequest<{ sources: ClaimSourceRow[] }>(
    'GET',
    `/api/claims/${claimId}/sources`,
  );
}

export async function addClaimSource(
  claimId: number,
  source: {
    resourceId?: string | null;
    url?: string | null;
    sourceQuote?: string | null;
    isPrimary?: boolean;
  },
): Promise<ApiResult<ClaimSourceRow>> {
  return apiRequest<ClaimSourceRow>(
    'POST',
    `/api/claims/${claimId}/sources`,
    source,
    undefined,
    'content',
  );
}

export async function getClaimStats(): Promise<ApiResult<ClaimStatsResult>> {
  return apiRequest<ClaimStatsResult>('GET', '/api/claims/stats');
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

/**
 * Delete only the claims for a specific entity+section pair.
 * Used by resource ingestion --force to re-ingest one resource without
 * clobbering claims from page extraction or other resources.
 */
export async function clearClaimsBySection(
  entityId: string,
  section: string,
): Promise<ApiResult<ClearClaimsResult>> {
  return apiRequest<ClearClaimsResult>(
    'POST',
    '/api/claims/clear-by-section',
    { entityId, section },
    undefined,
    'content',
  );
}

// ---------------------------------------------------------------------------
// Claim Update API functions
// ---------------------------------------------------------------------------

/**
 * Batch update relatedEntities on multiple claims at once.
 * Max 500 items per call.
 */
export async function batchUpdateRelatedEntities(
  items: Array<{ id: number; relatedEntities: string[] | null }>,
): Promise<ApiResult<{ updated: number; total: number }>> {
  return apiRequest<{ updated: number; total: number }>(
    'PATCH',
    '/api/claims/batch-update-related-entities',
    { items },
    30_000, // 30s timeout for batch operations
    'content',
  );
}

/**
 * Batch update structured fields (subjectEntity, property, structuredValue, etc.)
 * on multiple claims at once. Max 500 items per call.
 */
export async function batchUpdateStructuredFields(
  items: Array<{
    id: number;
    subjectEntity?: string | null;
    property?: string | null;
    structuredValue?: string | null;
    valueUnit?: string | null;
    valueDate?: string | null;
    qualifiers?: Record<string, string> | null;
  }>,
): Promise<ApiResult<{ updated: number; total: number }>> {
  return apiRequest<{ updated: number; total: number }>(
    'PATCH',
    '/api/claims/batch-update-structured',
    { items },
    30_000,
    'content',
  );
}

/**
 * Batch update claim text on multiple claims at once.
 * Max 500 items per call. Used by `crux claims fix strip-markup`.
 */
export async function batchUpdateClaimText(
  items: Array<{ id: number; claimText: string }>,
): Promise<ApiResult<{ updated: number; total: number }>> {
  return apiRequest<{ updated: number; total: number }>(
    'PATCH',
    '/api/claims/batch-update-text',
    { items },
    30_000,
    'content',
  );
}

/**
 * Delete claims by their IDs. Max 1000 IDs per call.
 * Used by `crux claims fix dedup` to remove duplicate claims.
 */
export async function deleteClaimsByIds(
  ids: number[],
): Promise<ApiResult<{ deleted: number }>> {
  return apiRequest<{ deleted: number }>(
    'POST',
    '/api/claims/delete-by-ids',
    { ids },
    30_000,
    'content',
  );
}

// ---------------------------------------------------------------------------
// Claim Page References API functions
// ---------------------------------------------------------------------------

export async function getClaimPageReferences(
  claimId: number,
): Promise<ApiResult<{ references: ClaimPageReferenceRow[] }>> {
  return apiRequest<{ references: ClaimPageReferenceRow[] }>(
    'GET',
    `/api/claims/${claimId}/page-references`,
  );
}

export async function addClaimPageReference(
  claimId: number,
  ref: { pageId: string; footnote?: number | null; section?: string | null },
): Promise<ApiResult<ClaimPageReferenceRow>> {
  return apiRequest<ClaimPageReferenceRow>(
    'POST',
    `/api/claims/${claimId}/page-references`,
    ref,
    undefined,
    'content',
  );
}

export async function addClaimPageReferencesBatch(
  claimId: number,
  items: Array<{ pageId: string; footnote?: number | null; section?: string | null }>,
): Promise<ApiResult<{ inserted: number }>> {
  return apiRequest<{ inserted: number }>(
    'POST',
    `/api/claims/${claimId}/page-references/batch`,
    { items },
    undefined,
    'content',
  );
}

