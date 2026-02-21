/**
 * Citation Quotes & Accuracy API — wiki-server client module
 *
 * Input types are derived from the canonical Zod schemas in api-types.ts.
 */

import { apiRequest, type ApiResult } from './client.ts';
import type {
  UpsertCitationQuote,
  AccuracyVerdict as AccuracyVerdictType,
  MarkAccuracy,
} from '../../../apps/wiki-server/src/api-types.ts';

// ---------------------------------------------------------------------------
// Citation Quotes Types — input (derived from server Zod schemas)
// ---------------------------------------------------------------------------

export type UpsertCitationQuoteItem = UpsertCitationQuote;

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
// Citation Accuracy Types — input (derived from server Zod schemas)
// ---------------------------------------------------------------------------

export type AccuracyVerdict = AccuracyVerdictType;

export type MarkAccuracyItem = MarkAccuracy;

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

