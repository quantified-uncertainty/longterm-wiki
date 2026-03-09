/**
 * Entity ID Allocation API — wiki-server client module
 *
 * Wraps the /api/ids/* endpoints for allocating and querying
 * numeric entity IDs from the centralized server.
 *
 * IDs use the format E{number} (e.g. E42, E886).
 * The server guarantees uniqueness via PostgreSQL sequences.
 */

import type { hc, InferResponseType } from 'hono/client';
import type { IdsRoute } from '../../../apps/wiki-server/src/routes/ids.ts';
import { apiRequest, getServerUrl, type ApiResult } from './client.ts';

// ---------------------------------------------------------------------------
// Types (inferred from Hono RPC route)
// ---------------------------------------------------------------------------

type RpcClient = ReturnType<typeof hc<IdsRoute>>;

export type AllocatedId = InferResponseType<RpcClient['allocate']['$post'], 200>;

export type AllocateBatchResult = InferResponseType<
  RpcClient['allocate-batch']['$post'],
  200
>;

export type IdListResult = InferResponseType<RpcClient['index']['$get'], 200>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Must match server-side limit in apps/wiki-server/src/routes/ids.ts */
const BATCH_CHUNK_SIZE = 50;

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Allocate a single numeric ID for a slug.
 * Idempotent: returns existing ID if slug is already registered.
 */
export async function allocateId(
  slug: string,
  description?: string,
): Promise<ApiResult<AllocatedId>> {
  const body: Record<string, string> = { slug };
  if (description) body.description = description;

  return apiRequest<AllocatedId>(
    'POST',
    '/api/ids/allocate',
    body
  );
}

/**
 * Allocate numeric IDs for multiple slugs in a single request.
 * All-or-nothing: either all succeed or the whole batch fails.
 */
export async function allocateBatch(
  items: Array<{ slug: string; description?: string }>,
): Promise<ApiResult<AllocateBatchResult>> {
  return apiRequest<AllocateBatchResult>(
    'POST',
    '/api/ids/allocate-batch',
    { items },
    30_000,
    'project',
  );
}

/**
 * Allocate IDs for a list of slugs, automatically chunking into
 * groups to respect server batch limits.
 */
export async function allocateIds(
  slugs: string[],
): Promise<ApiResult<Map<string, string>>> {
  const resultMap = new Map<string, string>();

  for (let i = 0; i < slugs.length; i += BATCH_CHUNK_SIZE) {
    const batch = slugs.slice(i, i + BATCH_CHUNK_SIZE);
    const items = batch.map(slug => ({ slug }));
    const result = await allocateBatch(items);

    if (!result.ok) {
      return result as ApiResult<Map<string, string>>;
    }

    for (const r of result.data.results) {
      resultMap.set(r.slug, r.numericId);
    }
  }

  return { ok: true, data: resultMap };
}

/**
 * Look up the numeric ID for a single slug.
 */
export async function getIdBySlug(
  slug: string,
): Promise<ApiResult<AllocatedId>> {
  return apiRequest<AllocatedId>(
    'GET',
    `/api/ids/by-slug?slug=${encodeURIComponent(slug)}`,
  );
}

/**
 * List all allocated IDs (paginated).
 */
export async function listIds(
  limit = 50,
  offset = 0,
): Promise<ApiResult<IdListResult>> {
  return apiRequest<IdListResult>(
    'GET',
    `/api/ids?limit=${limit}&offset=${offset}`,
  );
}

/**
 * Check if the server is configured and reachable.
 */
export function isConfigured(): boolean {
  return Boolean(getServerUrl());
}
