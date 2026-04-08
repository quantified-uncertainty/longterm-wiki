/**
 * Data Sources API — wiki-server client module.
 *
 * Response types inferred from Hono RPC route types (single source of truth).
 * Part of Phase 1: Data Source Resources (Discussion #3567).
 */

import { apiRequest, batchedRequest, type ApiResult } from './client.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { DataSourcesRoute } from '../../../apps/wiki-server/src/routes/tablebase/data-sources.ts';

// ---------------------------------------------------------------------------
// RPC type inference
// ---------------------------------------------------------------------------

type RpcClient = ReturnType<typeof hc<DataSourcesRoute>>;

export type DataSourceList = InferResponseType<RpcClient['index']['$get'], 200>;
export type DataSourceDetail = InferResponseType<RpcClient[':id']['$get'], 200>;
export type SyncResult = InferResponseType<RpcClient['sync']['$post'], 200>;
export type SnapshotList = InferResponseType<RpcClient[':id']['snapshots']['$get'], 200>;
export type SnapshotCreateResult = InferResponseType<RpcClient[':id']['snapshots']['$post']>;
export type SnapshotLatest = InferResponseType<RpcClient[':id']['snapshots']['latest']['$get'], 200>;

// ---------------------------------------------------------------------------
// Client functions
// ---------------------------------------------------------------------------

export async function listDataSources(): Promise<ApiResult<DataSourceList>> {
  return apiRequest<DataSourceList>('GET', '/api/data-sources');
}

export async function getDataSource(id: string): Promise<ApiResult<DataSourceDetail>> {
  return apiRequest<DataSourceDetail>('GET', `/api/data-sources/${encodeURIComponent(id)}`);
}

export interface SyncDataSourceInput {
  id: string;
  name: string;
  dataFormat: 'csv' | 'html_table' | 'json_api' | 'spreadsheet';
  accessMethod: 'direct_download' | 'api_endpoint' | 'web_scrape' | 'manual_export';
  recordType: 'grant' | 'personnel' | 'investment' | 'publication' | 'mixed';
  fetchUrl?: string | null;
  resourceId?: string | null;
  publisherEntityId?: string | null;
  updateFrequency?: 'static' | 'weekly' | 'monthly' | 'quarterly' | 'annual' | null;
  columnMapping?: Record<string, string> | null;
  sourceSchema?: Record<string, unknown> | null;
  verificationConfig?: {
    strategy: string;
    matchFields?: string[];
    fuzzyFields?: string[];
    [key: string]: unknown; // passthrough for future fields
  } | null;
  sourceStatus?: 'active' | 'archived' | 'defunct';
}

export async function syncDataSource(input: SyncDataSourceInput): Promise<ApiResult<SyncResult>> {
  return apiRequest<SyncResult>('POST', '/api/data-sources/sync', input);
}

export async function listSnapshots(
  dataSourceId: string,
  limit = 20,
  offset = 0,
): Promise<ApiResult<SnapshotList>> {
  return apiRequest<SnapshotList>(
    'GET',
    `/api/data-sources/${encodeURIComponent(dataSourceId)}/snapshots?limit=${limit}&offset=${offset}`,
  );
}

export interface CreateSnapshotInput {
  snapshotHash: string;
  rawContent: string;
  recordCount?: number | null;
  fetchedAt?: string;
  mappingValid?: boolean;
  parserVersion?: string | null;
  notes?: string | null;
}

export async function createSnapshot(
  dataSourceId: string,
  input: CreateSnapshotInput,
): Promise<ApiResult<SnapshotCreateResult>> {
  // Large snapshots (grant CSVs up to 40MB) need extended timeout
  const payloadSizeMB = input.rawContent.length / (1024 * 1024);
  const timeoutMs = payloadSizeMB > 1 ? 120_000 : 30_000;
  return batchedRequest<SnapshotCreateResult>(
    'POST',
    `/api/data-sources/${encodeURIComponent(dataSourceId)}/snapshots`,
    input,
    timeoutMs,
  );
}

export async function getLatestSnapshot(
  dataSourceId: string,
): Promise<ApiResult<SnapshotLatest>> {
  return apiRequest<SnapshotLatest>(
    'GET',
    `/api/data-sources/${encodeURIComponent(dataSourceId)}/snapshots/latest`,
  );
}
