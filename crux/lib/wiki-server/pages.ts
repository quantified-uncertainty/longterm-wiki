/**
 * Pages API — wiki-server client module
 *
 * Shared types and wrapper functions for page-related API endpoints.
 * Consumed by crux/commands/context.ts and crux/commands/query.ts.
 * Response types are imported from api-types.ts (single source of truth).
 */

import { apiRequest, type ApiResult } from './client.ts';
import type {
  PageSearchResult,
  PageDetailRow,
  RelatedPagesResult,
  BacklinksResult,
  BacklinkEntry,
  RelatedEntry,
  CitationQuoteRow,
  CitationQuotesResult,
} from '../../../apps/wiki-server/src/api-types.ts';

// ---------------------------------------------------------------------------
// Types — response (re-exported from canonical api-types.ts)
// ---------------------------------------------------------------------------

export type { PageSearchResult, BacklinksResult, CitationQuotesResult, BacklinkEntry, RelatedEntry };

/** Backward-compatible alias for PageDetailRow. */
export type PageDetail = PageDetailRow;

/** Backward-compatible alias for RelatedPagesResult. */
export type RelatedResult = RelatedPagesResult;

/** Backward-compatible alias for CitationQuoteRow. */
export type CitationQuote = CitationQuoteRow;

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/** Full-text search across wiki pages. */
export function searchPages(query: string, limit = 10): Promise<ApiResult<PageSearchResult>> {
  return apiRequest<PageSearchResult>(
    'GET',
    `/api/pages/search?q=${encodeURIComponent(query)}&limit=${limit}`,
  );
}

/** Fetch full metadata for a single page by ID. */
export function getPage(pageId: string): Promise<ApiResult<PageDetail>> {
  return apiRequest<PageDetail>('GET', `/api/pages/${encodeURIComponent(pageId)}`);
}

/** Fetch related pages via the graph link index. */
export function getRelatedPages(pageId: string, limit = 15): Promise<ApiResult<RelatedResult>> {
  return apiRequest<RelatedResult>(
    'GET',
    `/api/links/related/${encodeURIComponent(pageId)}?limit=${limit}`,
  );
}

/** Fetch pages that link to a given page. */
export function getBacklinks(pageId: string, limit = 20): Promise<ApiResult<BacklinksResult>> {
  return apiRequest<BacklinksResult>(
    'GET',
    `/api/links/backlinks/${encodeURIComponent(pageId)}?limit=${limit}`,
  );
}

/** Fetch citation quotes for a page. */
export function getCitationQuotes(pageId: string, limit = 100): Promise<ApiResult<CitationQuotesResult>> {
  return apiRequest<CitationQuotesResult>(
    'GET',
    `/api/citations/quotes?page_id=${encodeURIComponent(pageId)}&limit=${limit}`,
  );
}
