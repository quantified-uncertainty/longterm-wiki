/**
 * Auto-Update Runs & News Items API — wiki-server client module
 */

import { apiRequest, unwrap, getServerUrl, type ApiResult } from './client.ts';

// ---------------------------------------------------------------------------
// Auto-Update Runs Types
// ---------------------------------------------------------------------------

export interface AutoUpdateRunResultEntry {
  pageId: string;
  status: 'success' | 'failed' | 'skipped';
  tier?: string | null;
  durationMs?: number | null;
  errorMessage?: string | null;
}

export interface RecordAutoUpdateRunInput {
  date: string;
  startedAt: string;
  completedAt?: string | null;
  trigger: 'scheduled' | 'manual';
  budgetLimit?: number | null;
  budgetSpent?: number | null;
  sourcesChecked?: number | null;
  sourcesFailed?: number | null;
  itemsFetched?: number | null;
  itemsRelevant?: number | null;
  pagesPlanned?: number | null;
  pagesUpdated?: number | null;
  pagesFailed?: number | null;
  pagesSkipped?: number | null;
  newPagesCreated?: string[];
  results?: AutoUpdateRunResultEntry[];
}

export interface RecordRunResult {
  id: number;
  date: string;
  startedAt: string;
  createdAt: string;
  resultsInserted: number;
}

export interface AutoUpdateRunEntry {
  id: number;
  date: string;
  startedAt: string;
  completedAt: string | null;
  trigger: string;
  budgetLimit: number | null;
  budgetSpent: number | null;
  sourcesChecked: number | null;
  sourcesFailed: number | null;
  itemsFetched: number | null;
  itemsRelevant: number | null;
  pagesPlanned: number | null;
  pagesUpdated: number | null;
  pagesFailed: number | null;
  pagesSkipped: number | null;
  newPagesCreated: string[];
  results: AutoUpdateRunResultEntry[];
  createdAt: string;
}

export interface GetRunsResult {
  entries: AutoUpdateRunEntry[];
  total: number;
  limit: number;
  offset: number;
}

export interface AutoUpdateStatsResult {
  totalRuns: number;
  totalBudgetSpent: number;
  totalPagesUpdated: number;
  totalPagesFailed: number;
  byTrigger: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Auto-Update News Items Types
// ---------------------------------------------------------------------------

export interface AutoUpdateNewsItem {
  title: string;
  url: string;
  sourceId: string;
  publishedAt?: string | null;
  summary?: string | null;
  relevanceScore?: number | null;
  topics?: string[];
  entities?: string[];
  routedToPageId?: string | null;
  routedToPageTitle?: string | null;
  routedTier?: string | null;
}

export interface NewsItemBatchResult {
  inserted: number;
}

export interface AutoUpdateNewsItemEntry {
  id: number;
  runId: number;
  title: string;
  url: string;
  sourceId: string;
  publishedAt: string | null;
  summary: string | null;
  relevanceScore: number | null;
  topics: string[];
  entities: string[];
  routedToPageId: string | null;
  routedToPageTitle: string | null;
  routedTier: string | null;
  runDate?: string | null;
  createdAt: string;
}

export interface NewsDashboardResult {
  items: AutoUpdateNewsItemEntry[];
  runDates: string[];
}

// ---------------------------------------------------------------------------
// Auto-Update Runs API functions
// ---------------------------------------------------------------------------

export async function recordAutoUpdateRun(
  run: RecordAutoUpdateRunInput,
): Promise<ApiResult<RecordRunResult>> {
  return apiRequest<RecordRunResult>('POST', '/api/auto-update-runs', run);
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

// ---------------------------------------------------------------------------
// Backward-compatible wrappers (return T | null)
// ---------------------------------------------------------------------------

/** @deprecated Use the ApiResult-returning version and handle errors explicitly. */
export const recordAutoUpdateRun_compat = async (run: RecordAutoUpdateRunInput) =>
  unwrap(await recordAutoUpdateRun(run));

/** @deprecated Use the ApiResult-returning version and handle errors explicitly. */
export const getAutoUpdateRuns_compat = async (limit = 50, offset = 0) =>
  unwrap(await getAutoUpdateRuns(limit, offset));

/** @deprecated Use the ApiResult-returning version and handle errors explicitly. */
export const getAutoUpdateStats_compat = async () =>
  unwrap(await getAutoUpdateStats());

/** @deprecated Use the ApiResult-returning version and handle errors explicitly. */
export const insertAutoUpdateNewsItems_compat = async (runId: number, items: AutoUpdateNewsItem[]) =>
  unwrap(await insertAutoUpdateNewsItems(runId, items));
