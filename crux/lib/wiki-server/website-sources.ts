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
export type PageSnapshotCreateResult = InferResponseType<RpcClient[':sourceId']['snapshots']['$post'], 200>;

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
