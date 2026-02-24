/**
 * Summaries API — wiki-server client module
 *
 * Input types are derived from the canonical Zod schemas in api-types.ts.
 * Response types are imported from the canonical api-types.ts definitions.
 */

import { apiRequest, type ApiResult } from './client.ts';
import type {
  UpsertSummary,
  UpsertSummaryResult,
  UpsertSummaryBatchResult,
} from '../../../apps/wiki-server/src/api-types.ts';

// ---------------------------------------------------------------------------
// Types — input (derived from server Zod schemas)
// ---------------------------------------------------------------------------

export type UpsertSummaryItem = UpsertSummary;

// ---------------------------------------------------------------------------
// Types — response (re-exported from canonical api-types.ts)
// ---------------------------------------------------------------------------

export type { UpsertSummaryResult, UpsertSummaryBatchResult };

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

