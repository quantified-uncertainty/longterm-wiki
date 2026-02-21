/**
 * Facts API — wiki-server client module
 *
 * Input types are derived from the canonical Zod schemas in api-types.ts.
 */

import { batchedRequest, getServerUrl, apiRequest, type ApiResult } from './client.ts';
import type { SyncFact } from '../../../apps/wiki-server/src/api-types.ts';

// ---------------------------------------------------------------------------
// Types — input (derived from server Zod schemas)
// ---------------------------------------------------------------------------

export type SyncFactItem = SyncFact;

export interface SyncFactsResult {
  upserted: number;
}

export interface FactEntry {
  id: number;
  entityId: string;
  factId: string;
  label: string | null;
  value: string | null;
  numeric: number | null;
  low: number | null;
  high: number | null;
  asOf: string | null;
  measure: string | null;
  subject: string | null;
  note: string | null;
  source: string | null;
  sourceResource: string | null;
  format: string | null;
  formatDivisor: number | null;
  syncedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface FactsByEntityResult {
  entityId: string;
  facts: FactEntry[];
  total: number;
  limit: number;
  offset: number;
}

export interface TimeseriesResult {
  entityId: string;
  measure: string;
  points: FactEntry[];
  total: number;
}

export interface StaleFactsResult {
  facts: Array<{
    entityId: string;
    factId: string;
    label: string | null;
    asOf: string | null;
    measure: string | null;
    value: string | null;
    numeric: number | null;
  }>;
  total: number;
  limit: number;
  offset: number;
}

export interface FactStatsResult {
  total: number;
  uniqueEntities: number;
  uniqueMeasures: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FACT_BATCH_SIZE = 500;

// ---------------------------------------------------------------------------
// API functions
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
      { facts: batch },
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

