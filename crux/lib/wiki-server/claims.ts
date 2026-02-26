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
  ClaimSourceRow,
  GetClaimsResult,
  ClaimStatsResult,
  ClaimPageReferenceRow,
} from '../../../apps/wiki-server/src/api-types.ts';

// ---------------------------------------------------------------------------
// Types — input (derived from server Zod schemas)
// ---------------------------------------------------------------------------

export type InsertClaimItem = InsertClaim;

// ---------------------------------------------------------------------------
// Types — response (re-exported from canonical api-types.ts)
// ---------------------------------------------------------------------------

export type {
  InsertClaimResult,
  InsertClaimBatchResult,
  ClearClaimsResult,
  ClaimRow,
  ClaimSourceRow,
  GetClaimsResult,
  ClaimStatsResult,
  ClaimPageReferenceRow,
};

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
 * Update the relatedEntities field on an existing claim.
 */
export async function updateClaimRelatedEntities(
  claimId: number,
  relatedEntities: string[] | null,
): Promise<ApiResult<ClaimRow>> {
  return apiRequest<ClaimRow>(
    'PATCH',
    `/api/claims/${claimId}`,
    { relatedEntities },
    undefined,
    'content',
  );
}

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

