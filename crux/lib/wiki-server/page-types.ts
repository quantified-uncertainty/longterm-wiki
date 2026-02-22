/**
 * Shared response types for wiki-server page/link/citation API endpoints.
 *
 * Used by both `crux/commands/query.ts` and `crux/commands/context.ts` to
 * avoid duplicating interface definitions that must stay in sync with the server.
 */

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

export interface RelatedItem {
  id: string;
  type: string;
  title: string;
  score: number;
  label?: string;
}

export interface RelatedResult {
  entityId: string;
  related: RelatedItem[];
  total: number;
}

export interface BacklinkItem {
  id: string;
  type: string;
  title: string;
  relationship?: string;
  linkType: string;
  weight: number;
}

export interface BacklinksResult {
  targetId: string;
  backlinks: BacklinkItem[];
  total: number;
}

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

export interface CitationQuote {
  id: number;
  pageId: string;
  footnote: number;
  url: string | null;
  claimText: string;
  sourceQuote: string | null;
  quoteVerified: boolean;
  verificationScore: number | null;
  sourceTitle: string | null;
  accuracyVerdict: string | null;
  accuracyScore: number | null;
}

export interface CitationQuotesResult {
  quotes: CitationQuote[];
  pageId: string;
  total: number;
}
