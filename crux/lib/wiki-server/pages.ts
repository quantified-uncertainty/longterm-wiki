/**
 * Pages API — wiki-server client module
 *
 * Shared types and wrapper functions for page-related API endpoints.
 * Consumed by crux/commands/context.ts and crux/commands/query.ts.
 */

import { apiRequest, type ApiResult } from './client.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PageSearchResult {
  results: Array<{
    id: string;
    numericId: string | null;
    title: string;
    description: string | null;
    entityType: string | null;
    category: string | null;
    readerImportance: number | null;
    quality: number | null;
    score: number;
  }>;
  query: string;
  total: number;
}

export interface PageDetail {
  id: string;
  numericId: string | null;
  title: string;
  description: string | null;
  llmSummary: string | null;
  category: string | null;
  subcategory: string | null;
  entityType: string | null;
  tags: string | null;
  quality: number | null;
  readerImportance: number | null;
  hallucinationRiskLevel: string | null;
  hallucinationRiskScore: number | null;
  contentPlaintext: string | null;
  wordCount: number | null;
  lastUpdated: string | null;
  contentFormat: string | null;
  syncedAt: string;
}

export interface RelatedResult {
  entityId: string;
  related: Array<{
    id: string;
    type: string;
    title: string;
    score: number;
    label?: string;
  }>;
  total: number;
}

export interface BacklinksResult {
  targetId: string;
  backlinks: Array<{
    id: string;
    type: string;
    title: string;
    relationship?: string;
    linkType: string;
    weight: number;
  }>;
  total: number;
}

export interface CitationQuote {
  id: number;
  pageId: string;
  footnote: number;
  url: string | null;
  resourceId: string | null;
  claimText: string;
  claimContext: string | null;
  sourceQuote: string | null;
  sourceLocation: string | null;
  quoteVerified: boolean;
  verificationScore: number | null;
  sourceTitle: string | null;
  sourceType: string | null;
  accuracyVerdict: string | null;
  accuracyScore: number | null;
}

export interface CitationQuotesResult {
  quotes: CitationQuote[];
  pageId: string;
  total: number;
}

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
