/**
 * Build Metrics API — wiki-server client module
 *
 * Syncs coverage, rankings, update schedule, and similarity data
 * computed by build-data.mjs to the wiki-server PG database.
 *
 * All functions are fire-and-forget safe — they return ApiResult and
 * never throw. The build pipeline continues even if the server is down.
 *
 * Response types are inferred via Hono RPC InferResponseType<>.
 */

import type { hc, InferResponseType } from 'hono/client';
import type { BuildMetricsRoute } from '../../../apps/wiki-server/src/routes/build-metrics.ts';
import { batchedRequest, getServerUrl, type ApiResult } from './client.ts';

// ---------------------------------------------------------------------------
// Types — response (inferred from Hono RPC route)
// ---------------------------------------------------------------------------

type RpcClient = ReturnType<typeof hc<BuildMetricsRoute>>;

export type SyncCoverageResult = InferResponseType<RpcClient['coverage']['$post'], 200>;
export type SyncScheduleResult = InferResponseType<RpcClient['schedule']['$post'], 200>;
export type SyncRankingsResult = InferResponseType<RpcClient['rankings']['$post'], 200>;
export type SyncSimilarityResult = InferResponseType<RpcClient['similarity']['$post'], 200>;
export type BuildMetricsStatsResult = InferResponseType<RpcClient['stats']['$get'], 200>;

// ---------------------------------------------------------------------------
// Types — input
// ---------------------------------------------------------------------------

export interface CoverageItem {
  pageId: string;
  passing: number;
  total: number;
  items: Record<string, string>;
}

export interface ScheduleItem {
  pageId: string;
  updateFrequency: number;
  daysSinceUpdate: number;
  daysUntilDue: number;
  staleness: number;
  priority: number;
}

export interface RankingItem {
  pageId: string;
  readerRank: number | null;
  researchRank: number | null;
  recommendedScore: number | null;
}

export interface SimilarityPair {
  pageId: string;
  similarPageId: string;
  similarity: number;
  rank: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BATCH_SIZE = 1000;

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Sync page coverage scores to wiki-server.
 * Batches in groups of BATCH_SIZE.
 */
export async function syncCoverage(
  items: CoverageItem[],
): Promise<ApiResult<SyncCoverageResult>> {
  const serverUrl = getServerUrl();
  if (!serverUrl) return { ok: false, error: 'unavailable', message: 'LONGTERMWIKI_SERVER_URL not set' };

  let totalUpdated = 0;

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const result = await batchedRequest<SyncCoverageResult>(
      'POST',
      '/api/build-metrics/coverage',
      { coverage: batch },
    );

    if (!result.ok) {
      console.warn(`  WARNING: Coverage sync batch failed: ${result.message}`);
      return result;
    }

    totalUpdated += result.data.updated;
  }

  return { ok: true, data: { updated: totalUpdated } };
}

/**
 * Sync update schedule data to wiki-server.
 * Batches in groups of BATCH_SIZE.
 */
export async function syncSchedule(
  items: ScheduleItem[],
): Promise<ApiResult<SyncScheduleResult>> {
  const serverUrl = getServerUrl();
  if (!serverUrl) return { ok: false, error: 'unavailable', message: 'LONGTERMWIKI_SERVER_URL not set' };

  let totalUpdated = 0;

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const result = await batchedRequest<SyncScheduleResult>(
      'POST',
      '/api/build-metrics/schedule',
      { items: batch },
    );

    if (!result.ok) {
      console.warn(`  WARNING: Schedule sync batch failed: ${result.message}`);
      return result;
    }

    totalUpdated += result.data.updated;
  }

  return { ok: true, data: { updated: totalUpdated } };
}

/**
 * Sync page rankings (reader rank, research rank, recommended score) to wiki-server.
 * Batches in groups of BATCH_SIZE.
 */
export async function syncRankings(
  items: RankingItem[],
): Promise<ApiResult<SyncRankingsResult>> {
  const serverUrl = getServerUrl();
  if (!serverUrl) return { ok: false, error: 'unavailable', message: 'LONGTERMWIKI_SERVER_URL not set' };

  let totalUpdated = 0;

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const result = await batchedRequest<SyncRankingsResult>(
      'POST',
      '/api/build-metrics/rankings',
      { rankings: batch },
    );

    if (!result.ok) {
      console.warn(`  WARNING: Rankings sync batch failed: ${result.message}`);
      return result;
    }

    totalUpdated += result.data.updated;
  }

  return { ok: true, data: { updated: totalUpdated } };
}

/**
 * Sync page similarity data to wiki-server.
 * First batch replaces all existing data, subsequent batches append.
 * When pairs is empty, sends a replace=true request to clear existing rows.
 */
export async function syncSimilarity(
  pairs: SimilarityPair[],
): Promise<ApiResult<SyncSimilarityResult>> {
  const serverUrl = getServerUrl();
  if (!serverUrl) return { ok: false, error: 'unavailable', message: 'LONGTERMWIKI_SERVER_URL not set' };

  // Empty array: still send a replace=true request to clear stale rows in the DB
  if (pairs.length === 0) {
    return batchedRequest<SyncSimilarityResult>(
      'POST',
      '/api/build-metrics/similarity',
      { pairs: [], replace: true },
    );
  }

  let totalUpserted = 0;

  for (let i = 0; i < pairs.length; i += BATCH_SIZE) {
    const batch = pairs.slice(i, i + BATCH_SIZE);
    const isFirst = i === 0;

    const result = await batchedRequest<SyncSimilarityResult>(
      'POST',
      '/api/build-metrics/similarity',
      { pairs: batch, replace: isFirst },
    );

    if (!result.ok) {
      console.warn(`  WARNING: Similarity sync batch failed: ${result.message}`);
      return result;
    }

    totalUpserted += result.data.upserted;
  }

  return { ok: true, data: { upserted: totalUpserted } };
}
