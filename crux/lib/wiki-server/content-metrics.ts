/**
 * Content Metrics API — wiki-server client module
 *
 * Syncs build-time content metrics (coverage, schedule, structural, similarity)
 * to the wiki-server. Fire-and-forget: failures log a warning but never block
 * the build pipeline.
 *
 * Part of the PG-First Migration (Epic #2428, Issue #2434).
 */

import type { hc, InferResponseType } from 'hono/client';
import type { ContentMetricsRoute } from '../../../apps/wiki-server/src/routes/content-metrics.ts';
import type {
  SyncContentMetricsPage,
  SyncSimilarityItem,
} from '../../../apps/wiki-server/src/api-types.ts';
import { batchedRequest, getServerUrl, type ApiResult } from './client.ts';

// ---------------------------------------------------------------------------
// Types — response (inferred from Hono RPC route)
// ---------------------------------------------------------------------------

type RpcClient = ReturnType<typeof hc<ContentMetricsRoute>>;
export type SyncMetricsResult = InferResponseType<RpcClient['sync']['$post'], 200>;
export type SyncSimilarityResult = InferResponseType<RpcClient['similarity']['sync']['$post'], 200>;
export type ContentMetricsStatsResult = InferResponseType<RpcClient['stats']['$get'], 200>;

// ---------------------------------------------------------------------------
// Re-export input types for convenience
// ---------------------------------------------------------------------------

export type { SyncContentMetricsPage, SyncSimilarityItem };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const METRICS_BATCH_SIZE = 200;
const SIMILARITY_BATCH_SIZE = 2000;

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Sync content metrics (coverage, schedule, structural) for multiple pages.
 * Splits into batches of 200.
 */
export async function syncContentMetrics(
  pages: SyncContentMetricsPage[],
): Promise<ApiResult<{ updated: number }>> {
  const serverUrl = getServerUrl();
  if (!serverUrl) return { ok: false, error: 'unavailable', message: 'LONGTERMWIKI_SERVER_URL not set' };

  let totalUpdated = 0;

  for (let i = 0; i < pages.length; i += METRICS_BATCH_SIZE) {
    const batch = pages.slice(i, i + METRICS_BATCH_SIZE);
    const result = await batchedRequest<SyncMetricsResult>(
      'POST',
      '/api/content-metrics/sync',
      { pages: batch },
    );

    if (!result.ok) {
      console.warn(`  WARNING: Content metrics sync batch failed: ${result.message}`);
      return result;
    }

    totalUpdated += result.data.updated;
  }

  return { ok: true, data: { updated: totalUpdated } };
}

/**
 * Sync page similarity data. Replaces all existing similarity data on first batch.
 * Splits into batches of 2000.
 */
export async function syncSimilarity(
  items: SyncSimilarityItem[],
): Promise<ApiResult<{ upserted: number }>> {
  const serverUrl = getServerUrl();
  if (!serverUrl) return { ok: false, error: 'unavailable', message: 'LONGTERMWIKI_SERVER_URL not set' };

  let totalUpserted = 0;

  for (let i = 0; i < items.length; i += SIMILARITY_BATCH_SIZE) {
    const batch = items.slice(i, i + SIMILARITY_BATCH_SIZE);
    const isFirst = i === 0;

    const result = await batchedRequest<SyncSimilarityResult>(
      'POST',
      '/api/content-metrics/similarity/sync',
      { items: batch, replace: isFirst },
    );

    if (!result.ok) {
      console.warn(`  WARNING: Similarity sync batch failed: ${result.message}`);
      return result;
    }

    totalUpserted += result.data.upserted;
  }

  return { ok: true, data: { upserted: totalUpserted } };
}
