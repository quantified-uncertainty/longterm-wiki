/**
 * Sessions API — wiki-server client module
 *
 * Input types are derived from the canonical Zod schemas in api-types.ts.
 * Response types are imported from api-types.ts (single source of truth).
 */

import type { z } from 'zod';
import { apiRequest, type ApiResult } from './client.ts';
import type {
  CreateSessionSchema,
  CreateSessionResult,
  SessionBatchResult,
  SessionRow,
  SessionListResult,
  SessionByPageResult,
  SessionStatsResult,
  SessionPageChangesResult,
} from '../../../apps/wiki-server/src/api-types.ts';

// ---------------------------------------------------------------------------
// Types — input (derived from server Zod schemas)
// ---------------------------------------------------------------------------

/** Uses z.input (not z.infer) because the schema has .default() and .transform() on pages. */
export type SessionApiEntry = z.input<typeof CreateSessionSchema>;

// ---------------------------------------------------------------------------
// Types — response (re-exported from canonical api-types.ts)
// ---------------------------------------------------------------------------

export type {
  CreateSessionResult,
  SessionBatchResult,
  SessionListResult,
  SessionByPageResult,
  SessionStatsResult,
  SessionPageChangesResult,
};

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
