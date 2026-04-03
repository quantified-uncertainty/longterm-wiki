/**
 * Benchmark Results API — wiki-server client module
 *
 * Response types are inferred from the Hono RPC route type via InferResponseType<>.
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { BenchmarkResultsRoute } from '../../../apps/wiki-server/src/routes/tablebase/benchmark-results.ts';

// ---------------------------------------------------------------------------
// Types — response (inferred from Hono RPC route)
// ---------------------------------------------------------------------------

type RpcClient = ReturnType<typeof hc<BenchmarkResultsRoute>>;

export type BenchmarkResultsByModelResult = InferResponseType<RpcClient['by-model'][':modelId']['$get'], 200>;
export type BenchmarkResultsSyncResult = InferResponseType<RpcClient['sync']['$post'], 200>;

/** A single benchmark result row. */
export type BenchmarkResultEntry = BenchmarkResultsByModelResult['benchmarkResults'][number];

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/** Fetch benchmark results for a model. */
export async function getBenchmarkResultsByModel(
  modelId: string,
  options?: { limit?: number },
): Promise<ApiResult<BenchmarkResultsByModelResult>> {
  const params = new URLSearchParams();
  if (options?.limit != null) params.set('limit', String(options.limit));
  const qs = params.toString();
  return apiRequest<BenchmarkResultsByModelResult>(
    'GET',
    `/api/benchmark-results/by-model/${encodeURIComponent(modelId)}${qs ? `?${qs}` : ''}`,
  );
}
