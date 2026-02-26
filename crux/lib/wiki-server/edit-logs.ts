/**
 * Edit Logs API — wiki-server client module
 *
 * Input types are derived from the canonical Zod schemas in api-types.ts.
 * Response types are inferred from the Hono RPC route type (EditLogsRoute) to
 * stay in sync automatically when the server shape changes.
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { EditLogEntry } from '../../../apps/wiki-server/src/api-types.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { EditLogsRoute } from '../../../apps/wiki-server/src/routes/edit-logs.ts';

// ---------------------------------------------------------------------------
// RPC type inference — response shapes derived from the server route
// ---------------------------------------------------------------------------

type RpcClient = ReturnType<typeof hc<EditLogsRoute>>;

export type AppendResult = InferResponseType<RpcClient['index']['$post'], 201>;
export type BatchResult = InferResponseType<RpcClient['batch']['$post'], 201>;
export type GetEntriesResult = InferResponseType<RpcClient['index']['$get'], 200>;
export type GetAllEntriesResult = InferResponseType<RpcClient['all']['$get'], 200>;
export type StatsResult = InferResponseType<RpcClient['stats']['$get'], 200>;
export type LatestDatesResult = InferResponseType<RpcClient['latest-dates']['$get'], 200>;

// ---------------------------------------------------------------------------
// Types — input (derived from server Zod schemas)
// ---------------------------------------------------------------------------

export type EditLogApiEntry = EditLogEntry;

// ---------------------------------------------------------------------------
// API functions (return ApiResult<T>)
// ---------------------------------------------------------------------------

export async function appendEditLogToServer(
  entry: EditLogApiEntry,
): Promise<ApiResult<AppendResult>> {
  return apiRequest<AppendResult>('POST', '/api/edit-logs', entry, undefined, 'project');
}

export async function appendEditLogBatch(
  items: EditLogApiEntry[],
): Promise<ApiResult<BatchResult>> {
  return apiRequest<BatchResult>('POST', '/api/edit-logs/batch', { items }, undefined, 'project');
}

export async function getEditLogsForPage(
  pageId: string,
): Promise<ApiResult<GetEntriesResult>> {
  return apiRequest<GetEntriesResult>(
    'GET',
    `/api/edit-logs?page_id=${encodeURIComponent(pageId)}`,
  );
}

export async function getEditLogStats(): Promise<ApiResult<StatsResult>> {
  return apiRequest<StatsResult>('GET', '/api/edit-logs/stats');
}

export async function getEditLogLatestDates(): Promise<ApiResult<LatestDatesResult>> {
  return apiRequest<LatestDatesResult>('GET', '/api/edit-logs/latest-dates');
}

