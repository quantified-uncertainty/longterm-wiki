/**
 * Pages API — wiki-server client module
 *
 * Shared types and wrapper functions for page-related API endpoints.
 * Consumed by crux/commands/context.ts and crux/commands/query.ts.
 * Response types are inferred from server routes via Hono RPC type system,
 * eliminating hand-written response interfaces and preventing type drift.
 * All imports from hono/client are type-only — zero runtime cost.
 */

import type { hc, InferResponseType } from 'hono/client';
import { apiRequest, type ApiResult } from './client.ts';
import type { PagesRoute } from '../../../apps/wiki-server/src/routes/pages.ts';
import type { LinksRoute } from '../../../apps/wiki-server/src/routes/links.ts';
import type { CitationsRoute } from '../../../apps/wiki-server/src/routes/citations.ts';

// ---------------------------------------------------------------------------
// RPC type inference (compile-time only — no runtime cost)
// ---------------------------------------------------------------------------

type PagesRpcClient = ReturnType<typeof hc<PagesRoute>>;
type LinksRpcClient = ReturnType<typeof hc<LinksRoute>>;
type CitationsRpcClient = ReturnType<typeof hc<CitationsRoute>>;

/** Response type for GET /api/pages/search (inferred from server). */
export type PageSearchResult = InferResponseType<PagesRpcClient['search']['$get'], 200>;

/** Response type for GET /api/pages/:id (inferred from server). */
export type PageDetailRow = InferResponseType<PagesRpcClient[':id']['$get'], 200>;

/** Response type for GET /api/links/related/:id (inferred from server). */
export type RelatedPagesResult = InferResponseType<LinksRpcClient['related'][':id']['$get'], 200>;

/** Response type for GET /api/links/backlinks/:id (inferred from server). */
export type BacklinksResult = InferResponseType<LinksRpcClient['backlinks'][':id']['$get'], 200>;

/** Response type for GET /api/citations/quotes (inferred from server). */
export type CitationQuotesResult = InferResponseType<CitationsRpcClient['quotes']['$get'], 200>;

/** A single entry from the related pages list. */
export type RelatedEntry = RelatedPagesResult['related'][number];

/** A single entry from the backlinks list. */
export type BacklinkEntry = BacklinksResult['backlinks'][number];

/** Backward-compatible alias for PageDetailRow. */
export type PageDetail = PageDetailRow;

/** Backward-compatible alias for RelatedPagesResult. */
export type RelatedResult = RelatedPagesResult;

/** A single citation quote row from the server. */
export type CitationQuote = CitationQuotesResult['quotes'][number];

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
