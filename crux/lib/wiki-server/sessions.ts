/**
 * Sessions API — wiki-server client module
 */

import { apiRequest, unwrap, type ApiResult } from './client.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionApiEntry {
  date: string;
  branch?: string | null;
  title: string;
  summary?: string | null;
  model?: string | null;
  duration?: string | null;
  cost?: string | null;
  prUrl?: string | null;
  checksYaml?: string | null;
  issuesJson?: unknown;
  learningsJson?: unknown;
  recommendationsJson?: unknown;
  pages?: string[];
}

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

// ---------------------------------------------------------------------------
// Backward-compatible wrappers (return T | null)
// ---------------------------------------------------------------------------

/** @deprecated Use the ApiResult-returning version and handle errors explicitly. */
export const createSession_compat = async (entry: SessionApiEntry) =>
  unwrap(await createSession(entry));

/** @deprecated Use the ApiResult-returning version and handle errors explicitly. */
export const createSessionBatch_compat = async (items: SessionApiEntry[]) =>
  unwrap(await createSessionBatch(items));

/** @deprecated Use the ApiResult-returning version and handle errors explicitly. */
export const listSessions_compat = async (limit = 100, offset = 0) =>
  unwrap(await listSessions(limit, offset));

/** @deprecated Use the ApiResult-returning version and handle errors explicitly. */
export const getSessionsByPage_compat = async (pageId: string) =>
  unwrap(await getSessionsByPage(pageId));

/** @deprecated Use the ApiResult-returning version and handle errors explicitly. */
export const getSessionStats_compat = async () =>
  unwrap(await getSessionStats());

/** @deprecated Use the ApiResult-returning version and handle errors explicitly. */
export const getSessionPageChanges_compat = async () =>
  unwrap(await getSessionPageChanges());
