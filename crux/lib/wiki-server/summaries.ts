/**
 * Summaries API — wiki-server client module
 *
 * Input types are derived from the canonical Zod schemas in api-types.ts.
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { UpsertSummary } from '../../../apps/wiki-server/src/api-types.ts';

// ---------------------------------------------------------------------------
// Types — input (derived from server Zod schemas)
// ---------------------------------------------------------------------------

export type UpsertSummaryItem = UpsertSummary;

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

