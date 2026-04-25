/**
 * ModelAliases API — wiki-server client module.
 *
 * Phase 2 ingesters call resolveModelAlias() per row to map a leaderboard's
 * raw model name to entities.stable_id. Misses are written to
 * benchmark_results_pending (see benchmark-results-pending.ts).
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { ModelAliasesRoute } from '../../../apps/wiki-server/src/routes/tablebase/model-aliases.ts';
import type { SyncResponse } from '../../../apps/wiki-server/src/routes/tablebase/sync-factory.ts';

type RpcClient = ReturnType<typeof hc<ModelAliasesRoute>>;

export type ModelAliasesAllResult = InferResponseType<RpcClient['all']['$get'], 200>;
export type ModelAliasesStatsResult = InferResponseType<RpcClient['stats']['$get'], 200>;
export type ModelAliasesResolveOk = InferResponseType<RpcClient['resolve']['$get'], 200>;
export type ModelAliasesResolveMiss = InferResponseType<RpcClient['resolve']['$get'], 404>;
export type ModelAliasesSyncResult = SyncResponse;

/** Fetch all model_aliases rows with pagination + filters. */
export async function getAllModelAliases(
  options?: {
    limit?: number;
    offset?: number;
    modelStableId?: string;
    source?: string;
    confidence?: 'exact' | 'fuzzy' | 'manual';
    q?: string;
  },
): Promise<ApiResult<ModelAliasesAllResult>> {
  const params = new URLSearchParams();
  if (options?.limit != null) params.set('limit', String(options.limit));
  if (options?.offset != null) params.set('offset', String(options.offset));
  if (options?.modelStableId) params.set('modelStableId', options.modelStableId);
  if (options?.source) params.set('source', options.source);
  if (options?.confidence) params.set('confidence', options.confidence);
  if (options?.q) params.set('q', options.q);
  const qs = params.toString();
  return apiRequest<ModelAliasesAllResult>(
    'GET',
    `/api/model-aliases/all${qs ? `?${qs}` : ''}`,
  );
}

/** Distribution of aliases by source + confidence. */
export async function getModelAliasesStats(): Promise<
  ApiResult<ModelAliasesStatsResult>
> {
  return apiRequest<ModelAliasesStatsResult>('GET', '/api/model-aliases/stats');
}

/**
 * Resolve a single alias to its canonical model stable_id. Returns null on
 * miss (HTTP 404 from the server). Ingesters use this in the hot loop, so
 * callers should batch-cache the table client-side via getAllModelAliases
 * when processing more than ~50 rows.
 */
export async function resolveModelAlias(
  alias: string,
): Promise<ApiResult<ModelAliasesResolveOk | ModelAliasesResolveMiss>> {
  const params = new URLSearchParams({ alias });
  return apiRequest<ModelAliasesResolveOk | ModelAliasesResolveMiss>(
    'GET',
    `/api/model-aliases/resolve?${params.toString()}`,
  );
}

/** Sync model_aliases (upsert). */
export async function syncModelAliases(
  items: Array<Record<string, unknown>>,
): Promise<ApiResult<ModelAliasesSyncResult>> {
  return apiRequest<ModelAliasesSyncResult>('POST', '/api/model-aliases/sync', {
    items,
  });
}
