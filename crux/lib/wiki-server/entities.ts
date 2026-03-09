/**
 * Entities API — wiki-server client module
 *
 * Response types are inferred from the server route via Hono RPC type system,
 * eliminating hand-written response interfaces and preventing type drift.
 * All imports from hono/client are type-only — zero runtime cost.
 *
 * Runtime HTTP still uses `apiRequest` (for mock compatibility in tests).
 * Input types are derived from the canonical Zod schemas in api-types.ts.
 */

import type { hc, InferResponseType } from 'hono/client';
import { batchedRequest, getServerUrl, apiRequest, type ApiResult } from './client.ts';
import type { EntitiesRoute } from '../../../apps/wiki-server/src/routes/entities.ts';
import type { SyncEntity } from '../../../apps/wiki-server/src/api-types.ts';

// ---------------------------------------------------------------------------
// RPC type inference (compile-time only — no runtime cost)
// ---------------------------------------------------------------------------

type RpcClient = ReturnType<typeof hc<EntitiesRoute>>;

/** Response type for POST /api/entities/sync (inferred from server). */
export type SyncEntitiesResult = InferResponseType<RpcClient['sync']['$post'], 200>;

/** Response type for GET /api/entities/:id (inferred from server). */
type EntityRow = InferResponseType<RpcClient[':id']['$get'], 200>;

/** Response type for GET /api/entities (inferred from server). */
export type EntityListResult = InferResponseType<RpcClient['index']['$get'], 200>;

/** Response type for GET /api/entities/search (inferred from server). */
export type EntitySearchResult = InferResponseType<RpcClient['search']['$get'], 200>;

/** Response type for GET /api/entities/stats (inferred from server). */
export type EntityStatsResult = InferResponseType<RpcClient['stats']['$get'], 200>;

// ---------------------------------------------------------------------------
// Types — input (derived from server Zod schemas)
// ---------------------------------------------------------------------------

export type SyncEntityItem = SyncEntity;

// ---------------------------------------------------------------------------
// Types — response aliases
// ---------------------------------------------------------------------------

/** Backward-compatible alias for EntityRow. */
export type EntityEntry = EntityRow;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Must match MAX_BATCH_SIZE in apps/wiki-server/src/api-types.ts.
 * The server enforces this limit via Zod validation on batch endpoints.
 */
const ENTITY_BATCH_SIZE = 200;

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Sync entities to the wiki-server.
 * Splits into batches for large entity sets.
 */
export async function syncEntities(
  items: SyncEntityItem[],
): Promise<ApiResult<SyncEntitiesResult>> {
  const serverUrl = getServerUrl();
  if (!serverUrl) return { ok: false, error: 'unavailable', message: 'LONGTERMWIKI_SERVER_URL not set' };

  let totalUpserted = 0;

  for (let i = 0; i < items.length; i += ENTITY_BATCH_SIZE) {
    const batch = items.slice(i, i + ENTITY_BATCH_SIZE);

    const result = await batchedRequest<SyncEntitiesResult>(
      'POST',
      '/api/entities/sync',
      { entities: batch }
    );

    if (!result.ok) {
      console.warn(`  WARNING: Entity sync batch failed: ${result.message}`);
      return result;
    }

    totalUpserted += result.data.upserted;
  }

  return { ok: true, data: { upserted: totalUpserted } };
}

export async function getEntity(
  id: string,
): Promise<ApiResult<EntityEntry>> {
  return apiRequest<EntityEntry>('GET', `/api/entities/${encodeURIComponent(id)}`);
}

export async function listEntities(
  limit = 50,
  offset = 0,
  entityType?: string,
): Promise<ApiResult<EntityListResult>> {
  let path = `/api/entities?limit=${limit}&offset=${offset}`;
  if (entityType) path += `&entityType=${encodeURIComponent(entityType)}`;
  return apiRequest<EntityListResult>('GET', path);
}

export async function searchEntities(
  q: string,
  limit = 20,
): Promise<ApiResult<EntitySearchResult>> {
  return apiRequest<EntitySearchResult>(
    'GET',
    `/api/entities/search?q=${encodeURIComponent(q)}&limit=${limit}`,
  );
}

export async function getEntityStats(): Promise<ApiResult<EntityStatsResult>> {
  return apiRequest<EntityStatsResult>('GET', '/api/entities/stats');
}
