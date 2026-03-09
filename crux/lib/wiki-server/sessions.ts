/**
 * Sessions API — wiki-server client module
 *
 * Input types are derived from the canonical Zod schemas in api-types.ts.
 * Response types are inferred from the Hono RPC route type (single source of truth).
 */

import type { z } from 'zod';
import type { hc, InferResponseType } from 'hono/client';
import type { SessionsRoute } from '../../../apps/wiki-server/src/routes/sessions.ts';
import { apiRequest, type ApiResult } from './client.ts';
import type { CreateSessionSchema } from '../../../apps/wiki-server/src/api-types.ts';

// ---------------------------------------------------------------------------
// Types — input (derived from server Zod schemas)
// ---------------------------------------------------------------------------

/** Uses z.input (not z.infer) because the schema has .default() and .transform() on pages. */
export type SessionApiEntry = z.input<typeof CreateSessionSchema>;

// ---------------------------------------------------------------------------
// Types — response (inferred from Hono RPC route)
// ---------------------------------------------------------------------------

type RpcClient = ReturnType<typeof hc<SessionsRoute>>;

export type CreateSessionResult = InferResponseType<RpcClient['index']['$post'], 201>;
export type SessionBatchResult = InferResponseType<RpcClient['batch']['$post'], 201>;
export type SessionListResult = InferResponseType<RpcClient['index']['$get'], 200>;
export type SessionByPageResult = InferResponseType<RpcClient['by-page']['$get'], 200>;
export type SessionStatsResult = InferResponseType<RpcClient['stats']['$get'], 200>;
export type SessionPageChangesResult = InferResponseType<RpcClient['page-changes']['$get'], 200>;

/** SessionRow — extracted from the list result (sessions array element). */
export type SessionRow = SessionListResult['sessions'][number];

/** Backward-compatible alias for SessionRow. */
export type SessionEntry = SessionRow;

// ---------------------------------------------------------------------------
// API functions (return ApiResult<T>)
// ---------------------------------------------------------------------------

export async function createSession(
  entry: SessionApiEntry,
): Promise<ApiResult<CreateSessionResult>> {
  return apiRequest<CreateSessionResult>('POST', '/api/sessions', entry);
}

export async function createSessionBatch(
  items: SessionApiEntry[],
): Promise<ApiResult<SessionBatchResult>> {
  return apiRequest<SessionBatchResult>('POST', '/api/sessions/batch', { items });
}

export async function listSessions(
  limit = 100,
  offset = 0,
): Promise<ApiResult<SessionListResult>> {
  return apiRequest<SessionListResult>(
    'GET',
    `/api/sessions?limit=${limit}&offset=${offset}`,
  );
}

export async function getSessionsByPage(
  pageId: string,
): Promise<ApiResult<SessionByPageResult>> {
  return apiRequest<SessionByPageResult>(
    'GET',
    `/api/sessions/by-page?page_id=${encodeURIComponent(pageId)}`,
  );
}

export async function getSessionStats(): Promise<ApiResult<SessionStatsResult>> {
  return apiRequest<SessionStatsResult>('GET', '/api/sessions/stats');
}

export async function getSessionPageChanges(): Promise<ApiResult<SessionPageChangesResult>> {
  return apiRequest<SessionPageChangesResult>('GET', '/api/sessions/page-changes?limit=500');
}
