/**
 * References API — wiki-server client module
 *
 * Unified API for both claim-backed and regular page citations.
 * Input types are derived from the canonical Zod schemas in api-types.ts.
 * Response types are inferred from the Hono route via InferResponseType<>.
 */

import { apiRequest, type ApiResult } from './client.ts';
import type {
  ClaimPageReferenceInsert,
  PageCitationInsert,
} from '../../../apps/wiki-server/src/api-types.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { ReferencesRoute } from '../../../apps/wiki-server/src/routes/references.ts';

// ---------------------------------------------------------------------------
// Inferred response types from Hono RPC
// ---------------------------------------------------------------------------

type RpcClient = ReturnType<typeof hc<ReferencesRoute>>;

export type GetPageReferencesResult = InferResponseType<
  RpcClient['by-page'][':pageId']['$get'],
  200
>;

export type ClaimPageReferenceRow = InferResponseType<
  RpcClient['claim']['$post'],
  201
>;

export type PageCitationRow = InferResponseType<
  RpcClient['citation']['$post'],
  201
>;

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
    data
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
    data
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
    { items }
  );
}
