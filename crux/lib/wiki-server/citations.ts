/**
 * Citation Quotes & Accuracy API — wiki-server client module
 *
 * Input types are derived from the canonical Zod schemas in api-types.ts.
 * Response types are inferred from the Hono RPC route types (single source of truth).
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { CitationsRoute } from '../../../apps/wiki-server/src/routes/citations.ts';
import type {
  UpsertCitationQuote,
  AccuracyVerdict as AccuracyVerdictType,
  MarkAccuracy,
  UpsertCitationContent,
} from '../../../apps/wiki-server/src/api-types.ts';

// ---------------------------------------------------------------------------
// RPC type inference — response shapes derived from the route handler
// ---------------------------------------------------------------------------

type RpcClient = ReturnType<typeof hc<CitationsRoute>>;

type UpsertCitationQuoteResult = InferResponseType<RpcClient['quotes']['upsert']['$post'], 200>;
type UpsertCitationQuoteBatchResult = InferResponseType<RpcClient['quotes']['upsert-batch']['$post'], 200>;
type MarkAccuracyResult = InferResponseType<RpcClient['quotes']['mark-accuracy']['$post'], 200>;
type MarkAccuracyBatchResult = InferResponseType<RpcClient['quotes']['mark-accuracy-batch']['$post'], 200>;
type SnapshotResult = InferResponseType<RpcClient['accuracy-snapshot']['$post'], 201>;
type AccuracyDashboardData = InferResponseType<RpcClient['accuracy-dashboard']['$get'], 200>;
type CitationHealthResult = InferResponseType<RpcClient['health'][':pageId']['$get'], 200>;
type CitationContentRow = InferResponseType<RpcClient['content']['$get'], 200>;
type CitationContentListResult = InferResponseType<RpcClient['content']['list']['$get'], 200>;
type CitationContentListEntry = CitationContentListResult['entries'][number];
type CitationContentStatsResult = InferResponseType<RpcClient['content']['stats']['$get'], 200>;
type PropagateFromClaimsResult = InferResponseType<RpcClient['quotes']['propagate-from-claims']['$post'], 200>;

// ---------------------------------------------------------------------------
// Citation Quotes Types — input (derived from server Zod schemas)
// ---------------------------------------------------------------------------

export type UpsertCitationQuoteItem = UpsertCitationQuote;

// ---------------------------------------------------------------------------
// Citation Quotes Types — response (re-exported for consumers)
// ---------------------------------------------------------------------------

export type { UpsertCitationQuoteResult, UpsertCitationQuoteBatchResult };

// ---------------------------------------------------------------------------
// Citation Accuracy Types — input (derived from server Zod schemas)
// ---------------------------------------------------------------------------

export type AccuracyVerdict = AccuracyVerdictType;

export type MarkAccuracyItem = MarkAccuracy;

// ---------------------------------------------------------------------------
// Citation Accuracy Types — response (re-exported for consumers)
// ---------------------------------------------------------------------------

export type { MarkAccuracyResult, MarkAccuracyBatchResult, SnapshotResult, AccuracyDashboardData, CitationHealthResult };

// ---------------------------------------------------------------------------
// Citation Quotes API functions
// ---------------------------------------------------------------------------

export async function upsertCitationQuote(
  item: UpsertCitationQuoteItem,
): Promise<ApiResult<UpsertCitationQuoteResult>> {
  return apiRequest<UpsertCitationQuoteResult>('POST', '/api/citations/quotes/upsert', item, undefined, 'content');
}

export async function upsertCitationQuoteBatch(
  items: UpsertCitationQuoteItem[],
): Promise<ApiResult<UpsertCitationQuoteBatchResult>> {
  return apiRequest<UpsertCitationQuoteBatchResult>(
    'POST',
    '/api/citations/quotes/upsert-batch',
    { items },
    undefined,
    'content',
  );
}

// ---------------------------------------------------------------------------
// Citation Health API functions
// ---------------------------------------------------------------------------

export async function getPageCitationHealth(
  pageId: string,
): Promise<ApiResult<CitationHealthResult>> {
  return apiRequest<CitationHealthResult>(
    'GET',
    `/api/citations/health/${encodeURIComponent(pageId)}`,
  );
}

// ---------------------------------------------------------------------------
// Citation Accuracy API functions
// ---------------------------------------------------------------------------

export async function markCitationAccuracy(
  item: MarkAccuracyItem,
): Promise<ApiResult<MarkAccuracyResult>> {
  return apiRequest<MarkAccuracyResult>('POST', '/api/citations/quotes/mark-accuracy', item, undefined, 'content');
}

export async function markCitationAccuracyBatch(
  items: MarkAccuracyItem[],
): Promise<ApiResult<MarkAccuracyBatchResult>> {
  return apiRequest<MarkAccuracyBatchResult>(
    'POST',
    '/api/citations/quotes/mark-accuracy-batch',
    { items },
    undefined,
    'content',
  );
}

export async function createAccuracySnapshot(): Promise<ApiResult<SnapshotResult>> {
  return apiRequest<SnapshotResult>('POST', '/api/citations/accuracy-snapshot', {}, undefined, 'content');
}

export async function getAccuracyDashboard(): Promise<ApiResult<AccuracyDashboardData>> {
  return apiRequest<AccuracyDashboardData>('GET', '/api/citations/accuracy-dashboard');
}

// ---------------------------------------------------------------------------
// Citation Content API functions
// ---------------------------------------------------------------------------

export type UpsertCitationContentInput = UpsertCitationContent;

export type { CitationContentRow, CitationContentListEntry, CitationContentListResult, CitationContentStatsResult };

export async function upsertCitationContent(
  item: UpsertCitationContentInput,
): Promise<ApiResult<{ url: string }>> {
  return apiRequest<{ url: string }>('POST', '/api/citations/content/upsert', item, undefined, 'content');
}

export async function getCitationContentByUrl(
  url: string,
): Promise<ApiResult<CitationContentRow>> {
  return apiRequest<CitationContentRow>(
    'GET',
    `/api/citations/content?url=${encodeURIComponent(url)}`,
  );
}

export async function listCitationContent(
  limit = 100,
  offset = 0,
): Promise<ApiResult<CitationContentListResult>> {
  return apiRequest<CitationContentListResult>(
    'GET',
    `/api/citations/content/list?limit=${limit}&offset=${offset}`,
  );
}

export async function getCitationContentStats(): Promise<ApiResult<CitationContentStatsResult>> {
  return apiRequest<CitationContentStatsResult>('GET', '/api/citations/content/stats');
}

// ---------------------------------------------------------------------------
// Citation-Claim Linking API functions
// ---------------------------------------------------------------------------

export async function linkCitationToClaim(
  quoteId: number,
  claimId: number,
): Promise<ApiResult<{ linked: boolean; quoteId: number; claimId: number }>> {
  return apiRequest<{ linked: boolean; quoteId: number; claimId: number }>(
    'PATCH',
    `/api/citations/quotes/${quoteId}/link-claim`,
    { claimId },
    undefined,
    'content',
  );
}

export async function linkCitationsToClaimsBatch(
  items: Array<{ quoteId: number; claimId: number }>,
): Promise<ApiResult<{ linked: number }>> {
  return apiRequest<{ linked: number }>(
    'POST',
    '/api/citations/quotes/link-claims-batch',
    { items },
    undefined,
    'content',
  );
}

// ---------------------------------------------------------------------------
// Backward Propagation API functions
// ---------------------------------------------------------------------------

export type { PropagateFromClaimsResult };

export async function propagateClaimVerdictsToPage(
  pageId: string,
): Promise<ApiResult<PropagateFromClaimsResult>> {
  return apiRequest<PropagateFromClaimsResult>(
    'POST',
    '/api/citations/quotes/propagate-from-claims',
    { pageId },
    undefined,
    'content',
  );
}
