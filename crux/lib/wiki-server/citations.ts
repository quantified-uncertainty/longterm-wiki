/**
 * Citation Quotes & Accuracy API — wiki-server client module
 */

import { apiRequest, unwrap, type ApiResult } from './client.ts';

// ---------------------------------------------------------------------------
// Citation Quotes Types
// ---------------------------------------------------------------------------

export interface UpsertCitationQuoteItem {
  pageId: string;
  footnote: number;
  url?: string | null;
  resourceId?: string | null;
  claimText: string;
  claimContext?: string | null;
  sourceQuote?: string | null;
  sourceLocation?: string | null;
  quoteVerified?: boolean;
  verificationMethod?: string | null;
  verificationScore?: number | null;
  sourceTitle?: string | null;
  sourceType?: string | null;
  extractionModel?: string | null;
}

export interface UpsertCitationQuoteResult {
  id: number;
  pageId: string;
  footnote: number;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertCitationQuoteBatchResult {
  results: Array<{ id: number; pageId: string; footnote: number }>;
}

// ---------------------------------------------------------------------------
// Citation Accuracy Types
// ---------------------------------------------------------------------------

export type AccuracyVerdict = 'accurate' | 'inaccurate' | 'unsupported' | 'minor_issues' | 'not_verifiable';

export interface MarkAccuracyItem {
  pageId: string;
  footnote: number;
  verdict: AccuracyVerdict;
  score: number;
  issues?: string | null;
  supportingQuotes?: string | null;
  verificationDifficulty?: 'easy' | 'moderate' | 'hard' | null;
}

export interface MarkAccuracyResult {
  updated: true;
  pageId: string;
  footnote: number;
  verdict: string;
}

export interface MarkAccuracyBatchResult {
  updated: number;
  results: Array<{ pageId: string; footnote: number; verdict: string }>;
}

export interface SnapshotResult {
  snapshotCount: number;
  pages: string[];
}

export interface AccuracyDashboardData {
  exportedAt: string;
  summary: {
    totalCitations: number;
    checkedCitations: number;
    accurateCitations: number;
    inaccurateCitations: number;
    unsupportedCitations: number;
    minorIssueCitations: number;
    uncheckedCitations: number;
    averageScore: number | null;
  };
  verdictDistribution: Record<string, number>;
  difficultyDistribution: Record<string, number>;
  pages: Array<{
    pageId: string;
    totalCitations: number;
    checked: number;
    accurate: number;
    inaccurate: number;
    unsupported: number;
    minorIssues: number;
    accuracyRate: number | null;
    avgScore: number | null;
  }>;
  flaggedCitations: Array<{
    pageId: string;
    footnote: number;
    claimText: string;
    sourceTitle: string | null;
    url: string | null;
    verdict: string;
    score: number | null;
    issues: string | null;
    difficulty: string | null;
    checkedAt: string | null;
  }>;
  domainAnalysis: Array<{
    domain: string;
    totalCitations: number;
    checked: number;
    accurate: number;
    inaccurate: number;
    unsupported: number;
    inaccuracyRate: number | null;
  }>;
}

// ---------------------------------------------------------------------------
// Citation Quotes API functions
// ---------------------------------------------------------------------------

export async function upsertCitationQuote(
  item: UpsertCitationQuoteItem,
): Promise<ApiResult<UpsertCitationQuoteResult>> {
  return apiRequest<UpsertCitationQuoteResult>('POST', '/api/citations/quotes/upsert', item);
}

export async function upsertCitationQuoteBatch(
  items: UpsertCitationQuoteItem[],
): Promise<ApiResult<UpsertCitationQuoteBatchResult>> {
  return apiRequest<UpsertCitationQuoteBatchResult>(
    'POST',
    '/api/citations/quotes/upsert-batch',
    { items },
  );
}

// ---------------------------------------------------------------------------
// Citation Accuracy API functions
// ---------------------------------------------------------------------------

export async function markCitationAccuracy(
  item: MarkAccuracyItem,
): Promise<ApiResult<MarkAccuracyResult>> {
  return apiRequest<MarkAccuracyResult>('POST', '/api/citations/quotes/mark-accuracy', item);
}

export async function markCitationAccuracyBatch(
  items: MarkAccuracyItem[],
): Promise<ApiResult<MarkAccuracyBatchResult>> {
  return apiRequest<MarkAccuracyBatchResult>(
    'POST',
    '/api/citations/quotes/mark-accuracy-batch',
    { items },
  );
}

export async function createAccuracySnapshot(): Promise<ApiResult<SnapshotResult>> {
  return apiRequest<SnapshotResult>('POST', '/api/citations/accuracy-snapshot', {});
}

export async function getAccuracyDashboard(): Promise<ApiResult<AccuracyDashboardData>> {
  return apiRequest<AccuracyDashboardData>('GET', '/api/citations/accuracy-dashboard');
}

// ---------------------------------------------------------------------------
// Backward-compatible wrappers (return T | null)
// ---------------------------------------------------------------------------

/** @deprecated Use the ApiResult-returning version and handle errors explicitly. */
export const upsertCitationQuote_compat = async (item: UpsertCitationQuoteItem) =>
  unwrap(await upsertCitationQuote(item));

/** @deprecated Use the ApiResult-returning version and handle errors explicitly. */
export const upsertCitationQuoteBatch_compat = async (items: UpsertCitationQuoteItem[]) =>
  unwrap(await upsertCitationQuoteBatch(items));

/** @deprecated Use the ApiResult-returning version and handle errors explicitly. */
export const markCitationAccuracy_compat = async (item: MarkAccuracyItem) =>
  unwrap(await markCitationAccuracy(item));

/** @deprecated Use the ApiResult-returning version and handle errors explicitly. */
export const markCitationAccuracyBatch_compat = async (items: MarkAccuracyItem[]) =>
  unwrap(await markCitationAccuracyBatch(items));

/** @deprecated Use the ApiResult-returning version and handle errors explicitly. */
export const createAccuracySnapshot_compat = async () =>
  unwrap(await createAccuracySnapshot());

/** @deprecated Use the ApiResult-returning version and handle errors explicitly. */
export const getAccuracyDashboard_compat = async () =>
  unwrap(await getAccuracyDashboard());
