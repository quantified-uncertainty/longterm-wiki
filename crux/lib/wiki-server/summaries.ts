/**
 * Summaries API — wiki-server client module
 */

import { apiRequest, unwrap, type ApiResult } from './client.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UpsertSummaryItem {
  entityId: string;
  entityType: string;
  oneLiner?: string | null;
  summary?: string | null;
  review?: string | null;
  keyPoints?: string[] | null;
  keyClaims?: string[] | null;
  model?: string | null;
  tokensUsed?: number | null;
}

export interface UpsertSummaryResult {
  entityId: string;
  entityType: string;
}

export interface UpsertSummaryBatchResult {
  inserted: number;
  results: Array<{ entityId: string; entityType: string }>;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export async function upsertSummary(
  item: UpsertSummaryItem,
): Promise<ApiResult<UpsertSummaryResult>> {
  return apiRequest<UpsertSummaryResult>('POST', '/api/summaries', item);
}

export async function upsertSummaryBatch(
  items: UpsertSummaryItem[],
): Promise<ApiResult<UpsertSummaryBatchResult>> {
  return apiRequest<UpsertSummaryBatchResult>(
    'POST',
    '/api/summaries/batch',
    { items },
  );
}

// ---------------------------------------------------------------------------
// Backward-compatible wrappers
// ---------------------------------------------------------------------------

/** @deprecated Use the ApiResult-returning version and handle errors explicitly. */
export const upsertSummary_compat = async (item: UpsertSummaryItem) =>
  unwrap(await upsertSummary(item));

/** @deprecated Use the ApiResult-returning version and handle errors explicitly. */
export const upsertSummaryBatch_compat = async (items: UpsertSummaryItem[]) =>
  unwrap(await upsertSummaryBatch(items));
