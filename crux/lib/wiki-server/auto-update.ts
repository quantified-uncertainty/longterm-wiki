/**
 * Auto-Update Runs & News Items API — wiki-server client module
 *
 * Input types are derived from the canonical Zod schemas in api-types.ts.
 * Response types are imported from api-types.ts (single source of truth).
 */

import { apiRequest, getServerUrl, type ApiResult } from './client.ts';
import type { z } from 'zod';
import type {
  AutoUpdateResult,
  RecordAutoUpdateRun,
  AutoUpdateNewsItemSchema,
  RecordAutoUpdateRunResult,
  AutoUpdateRunRow,
  AutoUpdateRunsListResult,
  AutoUpdateStatsResult,
  AutoUpdateNewsBatchResult,
  AutoUpdateNewsRow,
  AutoUpdateNewsDashboardResult,
} from '../../../apps/wiki-server/src/api-types.ts';

// ---------------------------------------------------------------------------
// Auto-Update Runs Types — input (derived from server Zod schemas)
// ---------------------------------------------------------------------------

export type AutoUpdateRunResultEntry = AutoUpdateResult;

export type RecordAutoUpdateRunInput = RecordAutoUpdateRun;

// ---------------------------------------------------------------------------
// Auto-Update Runs Types — response (re-exported from canonical api-types.ts)
// ---------------------------------------------------------------------------

export type RecordRunResult = RecordAutoUpdateRunResult;
export type AutoUpdateRunEntry = AutoUpdateRunRow;
export type GetRunsResult = AutoUpdateRunsListResult;
export type { AutoUpdateStatsResult };

// ---------------------------------------------------------------------------
// Auto-Update News Items Types
// ---------------------------------------------------------------------------

/** Uses z.input (not z.infer) because the schema has .default([]) on topics/entities. */
export type AutoUpdateNewsItem = z.input<typeof AutoUpdateNewsItemSchema>;

export type NewsItemBatchResult = AutoUpdateNewsBatchResult;
export type AutoUpdateNewsItemEntry = AutoUpdateNewsRow;
export type NewsDashboardResult = AutoUpdateNewsDashboardResult;

// ---------------------------------------------------------------------------
// Auto-Update Runs API functions
// ---------------------------------------------------------------------------

export async function recordAutoUpdateRun(
  run: RecordAutoUpdateRunInput,
): Promise<ApiResult<RecordRunResult>> {
  return apiRequest<RecordRunResult>('POST', '/api/auto-update-runs', run, undefined, 'project');
}

export async function getAutoUpdateRuns(
  limit = 50,
  offset = 0,
): Promise<ApiResult<GetRunsResult>> {
  return apiRequest<GetRunsResult>(
    'GET',
    `/api/auto-update-runs/all?limit=${limit}&offset=${offset}`,
  );
}

export async function getAutoUpdateStats(): Promise<ApiResult<AutoUpdateStatsResult>> {
  return apiRequest<AutoUpdateStatsResult>('GET', '/api/auto-update-runs/stats');
}

// ---------------------------------------------------------------------------
// Auto-Update News Items API functions
// ---------------------------------------------------------------------------

export async function insertAutoUpdateNewsItems(
  runId: number,
  items: AutoUpdateNewsItem[],
): Promise<ApiResult<NewsItemBatchResult>> {
  const serverUrl = getServerUrl();
  if (!serverUrl) return { ok: false, error: 'unavailable', message: 'LONGTERMWIKI_SERVER_URL not set' };

  // Split into batches of 500
  let totalInserted = 0;
  const BATCH_SIZE = 500;

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const result = await apiRequest<NewsItemBatchResult>(
      'POST',
      '/api/auto-update-news/batch',
      { runId, items: batch },
      undefined,
      'project',
    );
    if (result.ok) {
      totalInserted += result.data.inserted;
    } else {
      return result;
    }
  }

  return { ok: true, data: { inserted: totalInserted } };
}

export async function getAutoUpdateNewsDashboard(
  maxRuns = 10,
): Promise<ApiResult<NewsDashboardResult>> {
  return apiRequest<NewsDashboardResult>(
    'GET',
    `/api/auto-update-news/dashboard?runs=${maxRuns}`,
  );
}
