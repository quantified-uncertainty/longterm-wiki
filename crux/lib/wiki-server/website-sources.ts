/**
 * Website Sources API — wiki-server client module.
 *
 * Response types inferred from Hono RPC route types (single source of truth).
 * Part of Discussion #2928: Websites as Data Feeds (Issue #3652).
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { WebsiteSourcesRoute } from '../../../apps/wiki-server/src/routes/tablebase/website-sources.ts';

// ---------------------------------------------------------------------------
// RPC type inference
// ---------------------------------------------------------------------------

type RpcClient = ReturnType<typeof hc<WebsiteSourcesRoute>>;

export type WebsiteSourceStats = InferResponseType<RpcClient['stats']['$get'], 200>;
export type WebsiteSourceList = InferResponseType<RpcClient['all']['$get'], 200>;
export type WebsiteSourceByEntity = InferResponseType<RpcClient['by-entity'][':entityId']['$get'], 200>;
export type WebsiteSourcePages = InferResponseType<RpcClient[':sourceId']['pages']['$get'], 200>;
export type PageSnapshotList = InferResponseType<RpcClient[':sourceId']['snapshots']['$get'], 200>;
export type PageSnapshotDetail = InferResponseType<RpcClient[':sourceId']['snapshots'][':snapshotId']['$get'], 200>;
export type PageSnapshotCreateResult = InferResponseType<RpcClient[':sourceId']['snapshots']['$post'], 201>;

// ---------------------------------------------------------------------------
// Client functions
// ---------------------------------------------------------------------------

export async function getWebsiteSourceStats(): Promise<ApiResult<WebsiteSourceStats>> {
  return apiRequest<WebsiteSourceStats>('GET', '/api/website-sources/stats');
}

export async function listWebsiteSources(
  limit = 200,
  offset = 0,
  enabled?: boolean,
): Promise<ApiResult<WebsiteSourceList>> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (enabled !== undefined) params.set('enabled', String(enabled));
  return apiRequest<WebsiteSourceList>('GET', `/api/website-sources/all?${params}`);
}

export async function getWebsiteSourcePages(
  sourceId: string,
): Promise<ApiResult<WebsiteSourcePages>> {
  return apiRequest<WebsiteSourcePages>(
    'GET',
    `/api/website-sources/${encodeURIComponent(sourceId)}/pages`,
  );
}

export async function listPageSnapshots(
  sourceId: string,
  limit = 20,
  offset = 0,
): Promise<ApiResult<PageSnapshotList>> {
  return apiRequest<PageSnapshotList>(
    'GET',
    `/api/website-sources/${encodeURIComponent(sourceId)}/snapshots?limit=${limit}&offset=${offset}`,
  );
}

export async function getPageSnapshot(
  sourceId: string,
  snapshotId: string,
): Promise<ApiResult<PageSnapshotDetail>> {
  return apiRequest<PageSnapshotDetail>(
    'GET',
    `/api/website-sources/${encodeURIComponent(sourceId)}/snapshots/${encodeURIComponent(snapshotId)}`,
  );
}

export interface CreatePageSnapshotInput {
  id: string;
  websiteSourcePageId: string;
  url: string;
  contentHash: string;
  fullText: string;
  titleAtTime?: string | null;
  httpStatus?: number;
  contentLength?: number;
  extractionStatus?: 'pending' | 'extracted' | 'failed' | 'skipped';
  fetchedAt?: string;
}

export async function createPageSnapshot(
  sourceId: string,
  input: CreatePageSnapshotInput,
): Promise<ApiResult<PageSnapshotCreateResult>> {
  return apiRequest<PageSnapshotCreateResult>(
    'POST',
    `/api/website-sources/${encodeURIComponent(sourceId)}/snapshots`,
    input,
  );
}

// ---------------------------------------------------------------------------
// Sync helpers — upsert sources and pages (QUA-642 register command)
// ---------------------------------------------------------------------------

export interface SyncWebsiteSourceInput {
  id: string;
  domain: string;
  entityId?: string | null;
  entityDisplayName?: string | null;
  reliability?: 'high' | 'medium' | 'low';
  refreshIntervalDays?: number;
  enabled?: boolean;
  notes?: string | null;
}

export interface SyncWebsitePageInput {
  id: string;
  sourceId: string;
  path: string;
  pageRole?:
    | 'about'
    | 'team'
    | 'research'
    | 'pricing'
    | 'careers'
    | 'docs'
    | 'landing'
    | 'blog-index'
    | 'other'
    | null;
  extractTargets?: string[] | null;
  refreshIntervalDays?: number | null;
  enabled?: boolean;
}

export async function syncWebsiteSources(
  items: SyncWebsiteSourceInput[],
): Promise<ApiResult<{ upserted: number }>> {
  return apiRequest<{ upserted: number }>(
    'POST',
    '/api/website-sources/sync',
    { items },
  );
}

export async function syncWebsitePages(
  items: SyncWebsitePageInput[],
): Promise<ApiResult<{ upserted: number }>> {
  return apiRequest<{ upserted: number }>(
    'POST',
    '/api/website-sources/sync-pages',
    { items },
  );
}

// ---------------------------------------------------------------------------
// Extraction workflow helpers (QUA-642 extract command)
// ---------------------------------------------------------------------------

export interface PendingSnapshot {
  id: string;
  websiteSourcePageId: string;
  sourceId: string;
  domain: string;
  entityId: string | null;
  entityDisplayName: string | null;
  pagePath: string;
  pageRole: string | null;
  url: string;
  fetchedAt: string;
  contentHash: string;
  contentLength: number;
  extractionStatus: string;
}

export async function listPendingSnapshots(
  limit = 50,
  offset = 0,
): Promise<
  ApiResult<{
    snapshots: PendingSnapshot[];
    total: number;
    limit: number;
    offset: number;
  }>
> {
  return apiRequest(
    'GET',
    `/api/website-sources/snapshots/pending?limit=${limit}&offset=${offset}`,
  );
}

export async function updateSnapshotExtraction(
  sourceId: string,
  snapshotId: string,
  extractionStatus: 'pending' | 'extracted' | 'failed' | 'skipped',
  extractedFacts: unknown = null,
): Promise<ApiResult<{ ok: true; id: string }>> {
  return apiRequest(
    'POST',
    `/api/website-sources/${encodeURIComponent(sourceId)}/snapshots/${encodeURIComponent(
      snapshotId,
    )}/extraction`,
    { extractionStatus, extractedFacts },
  );
}
