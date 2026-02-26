/**
 * References API — wiki-server client module
 *
 * Unified API for both claim-backed and regular page citations.
 * Input types are derived from the canonical Zod schemas in api-types.ts.
 * Response types are imported from api-types.ts (single source of truth).
 */

import { apiRequest, type ApiResult } from './client.ts';
import type {
  ClaimPageReferenceInsert,
  ClaimPageReferenceRow,
  PageCitationInsert,
  PageCitationRow,
} from '../../../apps/wiki-server/src/api-types.ts';

// ---------------------------------------------------------------------------
// Types — re-exported from canonical api-types.ts
// ---------------------------------------------------------------------------

export type {
  ClaimPageReferenceRow,
  PageCitationRow,
};

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

interface ClaimReferenceItem extends ClaimPageReferenceRow {
  type: 'claim';
  claimText: string;
  claimVerdict: string | null;
}

interface CitationItem extends PageCitationRow {
  type: 'citation';
}

type UnifiedReference = ClaimReferenceItem | CitationItem;

export interface GetPageReferencesResult {
  references: UnifiedReference[];
  totalClaim: number;
  totalCitation: number;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Get all references (claim-backed + regular citations) for a page.
 */
export async function getPageReferences(
  pageId: string,
): Promise<ApiResult<GetPageReferencesResult>> {
  return apiRequest<GetPageReferencesResult>(
    'GET',
    `/api/references/by-page/${encodeURIComponent(pageId)}`,
  );
}

/**
 * Create a claim page reference (claim-backed footnote).
 */
export async function createClaimReference(
  data: ClaimPageReferenceInsert,
): Promise<ApiResult<ClaimPageReferenceRow>> {
  return apiRequest<ClaimPageReferenceRow>(
    'POST',
    '/api/references/claim',
    data,
    undefined,
    'content',
  );
}

/**
 * Create a regular citation (non-claim footnote).
 */
export async function createCitation(
  data: PageCitationInsert,
): Promise<ApiResult<PageCitationRow>> {
  return apiRequest<PageCitationRow>(
    'POST',
    '/api/references/citation',
    data,
    undefined,
    'content',
  );
}

/**
 * Batch create regular citations.
 */
export async function createCitationsBatch(
  items: PageCitationInsert[],
): Promise<ApiResult<{ inserted: number }>> {
  return apiRequest<{ inserted: number }>(
    'POST',
    '/api/references/citations/batch',
    { items },
    undefined,
    'content',
  );
}
