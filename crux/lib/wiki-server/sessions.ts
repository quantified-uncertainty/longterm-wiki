/**
 * Sessions API — wiki-server client module
 *
 * Input types are derived from the canonical Zod schemas in api-types.ts.
 */

import type { z } from 'zod';
import { apiRequest, type ApiResult } from './client.ts';
import type { CreateSessionSchema } from '../../../apps/wiki-server/src/api-types.ts';

// ---------------------------------------------------------------------------
// Types — input (derived from server Zod schemas)
// ---------------------------------------------------------------------------

/** Uses z.input (not z.infer) because the schema has .default() and .transform() on pages. */
export type SessionApiEntry = z.input<typeof CreateSessionSchema>;

export interface CreateSessionResult {
  id: number;
  date: string;
  title: string;
  pages: string[];
  createdAt: string;
}

export interface SessionBatchResult {
  upserted: number;
  results: Array<{ id: number; title: string; pageCount: number }>;
}

export interface SessionEntry {
  id: number;
  date: string;
  branch: string | null;
  title: string;
  summary: string | null;
  model: string | null;
  duration: string | null;
  cost: string | null;
  prUrl: string | null;
  checksYaml: string | null;
  issuesJson: unknown;
  learningsJson: unknown;
  recommendationsJson: unknown;
  pages: string[];
  createdAt: string;
}

export interface SessionListResult {
  sessions: SessionEntry[];
  total: number;
  limit: number;
  offset: number;
}

export interface SessionByPageResult {
  sessions: SessionEntry[];
}

export interface SessionStatsResult {
  totalSessions: number;
  uniquePages: number;
  totalPageEdits: number;
  byModel: Record<string, number>;
}

export interface SessionPageChangesResult {
  sessions: SessionEntry[];
}

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

