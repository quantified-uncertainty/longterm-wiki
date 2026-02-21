/**
 * Edit Logs API — wiki-server client module
 */

import { apiRequest, unwrap, type ApiResult } from './client.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EditLogApiEntry {
  pageId: string;
  date: string;
  tool: string;
  agency: string;
  requestedBy?: string | null;
  note?: string | null;
}

export interface AppendResult {
  id: number;
  pageId: string;
  date: string;
  createdAt: string;
}

export interface BatchResult {
  inserted: number;
  results: Array<{ id: number; pageId: string }>;
}

export interface GetEntriesResult {
  entries: Array<{
    id: number;
    pageId: string;
    date: string;
    tool: string;
    agency: string;
    requestedBy: string | null;
    note: string | null;
    createdAt: string;
  }>;
}

export interface StatsResult {
  totalEntries: number;
  pagesWithLogs: number;
  byTool: Record<string, number>;
  byAgency: Record<string, number>;
}

export interface LatestDatesResult {
  dates: Record<string, string>;
}

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

// ---------------------------------------------------------------------------
// Backward-compatible wrappers (return T | null)
// ---------------------------------------------------------------------------

/** @deprecated Use the ApiResult-returning version and handle errors explicitly. */
export const appendEditLogToServer_compat = async (entry: EditLogApiEntry) =>
  unwrap(await appendEditLogToServer(entry));

/** @deprecated Use the ApiResult-returning version and handle errors explicitly. */
export const appendEditLogBatch_compat = async (items: EditLogApiEntry[]) =>
  unwrap(await appendEditLogBatch(items));

/** @deprecated Use the ApiResult-returning version and handle errors explicitly. */
export const getEditLogsForPage_compat = async (pageId: string) =>
  unwrap(await getEditLogsForPage(pageId));

/** @deprecated Use the ApiResult-returning version and handle errors explicitly. */
export const getEditLogStats_compat = async () =>
  unwrap(await getEditLogStats());

/** @deprecated Use the ApiResult-returning version and handle errors explicitly. */
export const getEditLogLatestDates_compat = async () =>
  unwrap(await getEditLogLatestDates());
