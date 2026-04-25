/**
 * BenchmarkResultsPending API — wiki-server client module.
 *
 * Phase 2 ingesters write rows here when a raw model name fails alias
 * resolution. The /internal/benchmark-quarantine dashboard (follow-up PR)
 * promotes them via syncModelAliases() + syncBenchmarkResults().
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { BenchmarkResultsPendingRoute } from '../../../apps/wiki-server/src/routes/tablebase/benchmark-results-pending.ts';
import type { SyncResponse } from '../../../apps/wiki-server/src/routes/tablebase/sync-factory.ts';

type RpcClient = ReturnType<typeof hc<BenchmarkResultsPendingRoute>>;

export type BenchmarkResultsPendingAllResult = InferResponseType<
  RpcClient['all']['$get'],
  200
>;
export type BenchmarkResultsPendingStatsResult = InferResponseType<
  RpcClient['stats']['$get'],
  200
>;
export type BenchmarkResultsPendingSyncResult = SyncResponse;

/** Fetch quarantine rows with pagination + filters. */
export async function getAllBenchmarkResultsPending(
  options?: {
    limit?: number;
    offset?: number;
    status?: 'pending' | 'resolved' | 'rejected';
    ingesterSource?: string;
    benchmarkId?: string;
    q?: string;
  },
): Promise<ApiResult<BenchmarkResultsPendingAllResult>> {
  const params = new URLSearchParams();
  if (options?.limit != null) params.set('limit', String(options.limit));
  if (options?.offset != null) params.set('offset', String(options.offset));
  if (options?.status) params.set('status', options.status);
  if (options?.ingesterSource)
    params.set('ingesterSource', options.ingesterSource);
  if (options?.benchmarkId) params.set('benchmarkId', options.benchmarkId);
  if (options?.q) params.set('q', options.q);
  const qs = params.toString();
  return apiRequest<BenchmarkResultsPendingAllResult>(
    'GET',
    `/api/benchmark-results-pending/all${qs ? `?${qs}` : ''}`,
  );
}

/** Quarantine queue depth + breakdown. */
export async function getBenchmarkResultsPendingStats(): Promise<
  ApiResult<BenchmarkResultsPendingStatsResult>
> {
  return apiRequest<BenchmarkResultsPendingStatsResult>(
    'GET',
    '/api/benchmark-results-pending/stats',
  );
}

/** Sync benchmark_results_pending (upsert). */
export async function syncBenchmarkResultsPending(
  items: Array<Record<string, unknown>>,
): Promise<ApiResult<BenchmarkResultsPendingSyncResult>> {
  return apiRequest<BenchmarkResultsPendingSyncResult>(
    'POST',
    '/api/benchmark-results-pending/sync',
    { items },
  );
}
