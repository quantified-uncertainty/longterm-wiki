/**
 * Edit Logs API — wiki-server client module
 *
 * Input types are derived from the canonical Zod schemas in api-types.ts.
 */

import { apiRequest, type ApiResult } from './client.ts';
import type {
  EditLogEntry,
  EditLogAppendResult,
  EditLogBatchResult,
  EditLogEntriesResult,
  EditLogStatsResult,
  EditLogLatestDatesResult,
} from '../../../apps/wiki-server/src/api-types.ts';

// ---------------------------------------------------------------------------
// Types — input (derived from server Zod schemas)
// ---------------------------------------------------------------------------

export type EditLogApiEntry = EditLogEntry;

// ---------------------------------------------------------------------------
// Types — response (re-exported from canonical api-types.ts)
// ---------------------------------------------------------------------------

export type AppendResult = EditLogAppendResult;
export type BatchResult = EditLogBatchResult;
export type GetEntriesResult = EditLogEntriesResult;
export type StatsResult = EditLogStatsResult;
export type LatestDatesResult = EditLogLatestDatesResult;

// ---------------------------------------------------------------------------
// API functions (return ApiResult<T>)
// ---------------------------------------------------------------------------

export async function appendEditLogToServer(
  entry: EditLogApiEntry,
): Promise<ApiResult<AppendResult>> {
  return apiRequest<AppendResult>('POST', '/api/edit-logs', entry);
}

export async function appendEditLogBatch(
  items: EditLogApiEntry[],
): Promise<ApiResult<BatchResult>> {
  return apiRequest<BatchResult>('POST', '/api/edit-logs/batch', { items });
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

