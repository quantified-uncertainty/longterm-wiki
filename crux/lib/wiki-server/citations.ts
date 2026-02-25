/**
 * Citation Quotes & Accuracy API — wiki-server client module
 *
 * Input types are derived from the canonical Zod schemas in api-types.ts.
 * Response types are imported from api-types.ts (single source of truth).
 */

import { apiRequest, type ApiResult } from './client.ts';
import type {
  UpsertCitationQuote,
  AccuracyVerdict as AccuracyVerdictType,
  MarkAccuracy,
  UpsertCitationContent,
  UpsertCitationQuoteResult,
  UpsertCitationQuoteBatchResult,
  MarkAccuracyResult,
  MarkAccuracyBatchResult,
  AccuracySnapshotResult,
  AccuracyDashboardData,
  CitationHealthResult,
  CitationContentRow,
  CitationContentListEntry,
  CitationContentListResult,
  CitationContentStatsResult,
} from '../../../apps/wiki-server/src/api-types.ts';

// ---------------------------------------------------------------------------
// Citation Quotes Types — input (derived from server Zod schemas)
// ---------------------------------------------------------------------------

export type UpsertCitationQuoteItem = UpsertCitationQuote;

// ---------------------------------------------------------------------------
// Citation Quotes Types — response (re-exported from canonical api-types.ts)
// ---------------------------------------------------------------------------

export type { UpsertCitationQuoteResult, UpsertCitationQuoteBatchResult };

// ---------------------------------------------------------------------------
// Citation Accuracy Types — input (derived from server Zod schemas)
// ---------------------------------------------------------------------------

export type AccuracyVerdict = AccuracyVerdictType;

export type MarkAccuracyItem = MarkAccuracy;

// ---------------------------------------------------------------------------
// Citation Accuracy Types — response (re-exported from canonical api-types.ts)
// ---------------------------------------------------------------------------

export type { MarkAccuracyResult, MarkAccuracyBatchResult, AccuracyDashboardData, CitationHealthResult };
export type SnapshotResult = AccuracySnapshotResult;

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
