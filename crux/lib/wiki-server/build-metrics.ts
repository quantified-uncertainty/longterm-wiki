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
import type { BuildMetricsRoute } from '../../../apps/wiki-server/src/routes/operational/build-metrics.ts';
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

export type CoverageStatus = 'green' | 'amber' | 'red';

export interface CoverageItem {
  pageId: string;
  passing: number;
  total: number;
  items: Record<string, CoverageStatus>;
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

/**
 * Similarity data uses a larger batch because the server-side replace: true
 * pattern (DELETE + INSERT) must complete atomically within a single HTTP call.
 * Splitting across calls would risk partial data loss if a later batch fails.
 * Server accepts up to 5000 pairs, so 5000 here ensures all data fits in one call
 * for the expected ~3500 pairs (~700 pages x 5 similar each).
 */
const SIMILARITY_BATCH_SIZE = 5000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generic batched sync for endpoints that return { updated: number }.
 * Handles URL check, batching, and error aggregation.
 */
async function syncBatched<TResult extends { updated: number }>(
  items: unknown[],
  batchSize: number,
  path: string,
  wrapBatch: (batch: unknown[]) => unknown,
  label: string,
): Promise<ApiResult<TResult>> {
  const serverUrl = getServerUrl();
  if (!serverUrl) return { ok: false, error: 'unavailable', message: 'LONGTERMWIKI_SERVER_URL not set' };

  let totalUpdated = 0;

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const result = await batchedRequest<TResult>(
      'POST',
      path,
      wrapBatch(batch),
    );

    if (!result.ok) {
      console.warn(`  WARNING: ${label} sync batch failed: ${result.message}`);
      return result;
    }

    totalUpdated += result.data.updated;
  }

  return { ok: true, data: { updated: totalUpdated } as TResult };
}

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
  return syncBatched<SyncCoverageResult>(
    items, BATCH_SIZE,
    '/api/build-metrics/coverage',
    (batch) => ({ coverage: batch }),
    'Coverage',
  );
}

/**
 * Sync update schedule data to wiki-server.
 * Batches in groups of BATCH_SIZE.
 */
export async function syncSchedule(
  items: ScheduleItem[],
): Promise<ApiResult<SyncScheduleResult>> {
  return syncBatched<SyncScheduleResult>(
    items, BATCH_SIZE,
    '/api/build-metrics/schedule',
    (batch) => ({ items: batch }),
    'Schedule',
  );
}

/**
 * Sync page rankings (reader rank, research rank, recommended score) to wiki-server.
 * Batches in groups of BATCH_SIZE.
 */
export async function syncRankings(
  items: RankingItem[],
): Promise<ApiResult<SyncRankingsResult>> {
  return syncBatched<SyncRankingsResult>(
    items, BATCH_SIZE,
    '/api/build-metrics/rankings',
    (batch) => ({ rankings: batch }),
    'Rankings',
  );
}

/**
 * Sync page similarity data to wiki-server.
 * Sends all data in a single request with replace: true to avoid partial-delete risk.
 * The server accepts up to 5000 pairs per call, which covers the expected ~3500 pairs.
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

  for (let i = 0; i < pairs.length; i += SIMILARITY_BATCH_SIZE) {
    const batch = pairs.slice(i, i + SIMILARITY_BATCH_SIZE);
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
