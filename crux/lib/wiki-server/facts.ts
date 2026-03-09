/**
 * Facts API — wiki-server client module
 *
 * Response types are inferred from the server route via Hono RPC type system,
 * eliminating hand-written response interfaces and preventing type drift.
 * All imports from hono/client are type-only — zero runtime cost.
 *
 * Runtime HTTP still uses `apiRequest` (for mock compatibility in tests).
 * For true RPC calls, use `getFactsRpcClient()` from `@lib/wiki-server`.
 */

import type { hc, InferResponseType } from 'hono/client';
import { batchedRequest, getServerUrl, apiRequest, type ApiResult } from './client.ts';
import type { FactsRoute } from '../../../apps/wiki-server/src/routes/facts.ts';
import type { SyncFact } from '../../../apps/wiki-server/src/api-types.ts';

// ---------------------------------------------------------------------------
// RPC type inference (compile-time only — no runtime cost)
// ---------------------------------------------------------------------------

// The RPC type system infers a union of success + error response types.
// We use InferResponseType<endpoint, 200> to extract only the success shape,
// which eliminates the hand-written response interfaces from api-types.ts.
type RpcClient = ReturnType<typeof hc<FactsRoute>>;

/** Response type for GET /api/facts/by-entity/:entityId (inferred from server). */
export type FactsByEntityResult = InferResponseType<RpcClient['by-entity'][':entityId']['$get'], 200>;

/** Response type for GET /api/facts/timeseries/:entityId (inferred from server). */
export type TimeseriesResult = InferResponseType<RpcClient['timeseries'][':entityId']['$get'], 200>;

/** Response type for GET /api/facts/stale (inferred from server). */
export type StaleFactsResult = InferResponseType<RpcClient['stale']['$get'], 200>;

/** Response type for GET /api/facts/stats (inferred from server). */
export type FactStatsResult = InferResponseType<RpcClient['stats']['$get'], 200>;

/** Response type for POST /api/facts/sync (inferred from server). */
export type SyncFactsResult = InferResponseType<RpcClient['sync']['$post'], 200>;

/** A single fact row from the server. */
export type FactEntry = FactsByEntityResult['facts'][number];

// ---------------------------------------------------------------------------
// Types — input (from server Zod schemas)
// ---------------------------------------------------------------------------

export type SyncFactItem = SyncFact;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FACT_BATCH_SIZE = 500;

// ---------------------------------------------------------------------------
// API functions (runtime uses apiRequest for test mock compatibility)
// ---------------------------------------------------------------------------

/**
 * Sync facts to the wiki-server.
 * Splits into batches for large fact sets.
 */
export async function syncFacts(
  items: SyncFactItem[],
): Promise<ApiResult<SyncFactsResult>> {
  const serverUrl = getServerUrl();
  if (!serverUrl) return { ok: false, error: 'unavailable', message: 'LONGTERMWIKI_SERVER_URL not set' };

  let totalUpserted = 0;

  for (let i = 0; i < items.length; i += FACT_BATCH_SIZE) {
    const batch = items.slice(i, i + FACT_BATCH_SIZE);

    const result = await batchedRequest<SyncFactsResult>(
      'POST',
      '/api/facts/sync',
      { facts: batch }
    );

    if (!result.ok) {
      console.warn(`  WARNING: Facts sync batch failed: ${result.message}`);
      return result;
    }

    totalUpserted += result.data.upserted;
  }

  return { ok: true, data: { upserted: totalUpserted } };
}

export async function getFactsByEntity(
  entityId: string,
  limit = 100,
  offset = 0,
  measure?: string,
): Promise<ApiResult<FactsByEntityResult>> {
  let path = `/api/facts/by-entity/${encodeURIComponent(entityId)}?limit=${limit}&offset=${offset}`;
  if (measure) path += `&measure=${encodeURIComponent(measure)}`;
  return apiRequest<FactsByEntityResult>('GET', path);
}

export async function getFactTimeseries(
  entityId: string,
  measure: string,
  limit = 100,
): Promise<ApiResult<TimeseriesResult>> {
  return apiRequest<TimeseriesResult>(
    'GET',
    `/api/facts/timeseries/${encodeURIComponent(entityId)}?measure=${encodeURIComponent(measure)}&limit=${limit}`,
  );
}

export async function getStaleFacts(
  olderThan?: string,
  limit = 50,
  offset = 0,
): Promise<ApiResult<StaleFactsResult>> {
  let path = `/api/facts/stale?limit=${limit}&offset=${offset}`;
  if (olderThan) path += `&olderThan=${encodeURIComponent(olderThan)}`;
  return apiRequest<StaleFactsResult>('GET', path);
}

export async function getFactStats(): Promise<ApiResult<FactStatsResult>> {
  return apiRequest<FactStatsResult>('GET', '/api/facts/stats');
}
