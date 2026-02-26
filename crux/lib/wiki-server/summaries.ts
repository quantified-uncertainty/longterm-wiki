/**
 * Summaries API — wiki-server client module
 *
 * Input types are derived from the canonical Zod schemas in api-types.ts.
 * Response types are inferred from the Hono route via InferResponseType<>.
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { UpsertSummary } from '../../../apps/wiki-server/src/api-types.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { SummariesRoute } from '../../../apps/wiki-server/src/routes/summaries.ts';

// ---------------------------------------------------------------------------
// Types — input (derived from server Zod schemas)
// ---------------------------------------------------------------------------

export type UpsertSummaryItem = UpsertSummary;

// ---------------------------------------------------------------------------
// Types — response (inferred from Hono RPC route)
// ---------------------------------------------------------------------------

type RpcClient = ReturnType<typeof hc<SummariesRoute>>;

export type UpsertSummaryResult = InferResponseType<RpcClient['index']['$post'], 201>;
export type UpsertSummaryBatchResult = InferResponseType<RpcClient['batch']['$post'], 201>;

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export async function upsertSummary(
  item: UpsertSummaryItem,
): Promise<ApiResult<UpsertSummaryResult>> {
  return apiRequest<UpsertSummaryResult>('POST', '/api/summaries', item, undefined, 'content');
}

export async function upsertSummaryBatch(
  items: UpsertSummaryItem[],
): Promise<ApiResult<UpsertSummaryBatchResult>> {
  return apiRequest<UpsertSummaryBatchResult>(
    'POST',
    '/api/summaries/batch',
    { items },
    undefined,
    'content',
  );
}

