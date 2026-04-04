/**
 * Source-Check Verdicts API -- wiki-server client module
 *
 * Provides functions to fetch source-check verdicts from the wiki-server.
 * Used by the auto-update pipeline to skip pages with contradicted verdicts,
 * and by agents to query verification status by entity, page, or failure type.
 *
 * Response types are inferred from the server route via Hono RPC type system.
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { SourceChecksRoute } from '../../../apps/wiki-server/src/routes/source-check/source-checks.ts';

type RpcClient = ReturnType<typeof hc<SourceChecksRoute>>;

// ---------------------------------------------------------------------------
// Response types (inferred from Hono RPC route)
// ---------------------------------------------------------------------------

export type VerdictsResponse = InferResponseType<RpcClient['verdicts']['$get'], 200>;
export type VerdictEntry = VerdictsResponse['verdicts'][number];

export type ByEntityResponse = InferResponseType<RpcClient['by-entity'][':entityId']['$get'], 200>;
export type ByPageResponse = InferResponseType<RpcClient['by-page'][':pageSlug']['$get'], 200>;
export type FailuresResponse = InferResponseType<RpcClient['failures']['$get'], 200>;
export type StaleResponse = InferResponseType<RpcClient['stale']['$get'], 200>;

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Fetch source-check verdicts filtered by verdict type.
 */
export async function getVerdictsByType(
  verdict: string,
  limit = 200,
): Promise<ApiResult<VerdictsResponse>> {
  return apiRequest<VerdictsResponse>(
    'GET',
    `/api/source-checks/verdicts?verdict=${encodeURIComponent(verdict)}&limit=${limit}`,
  );
}

/**
 * Fetch all verdicts for a given entity, including aggregate counts by verdict type.
 */
export async function getVerdictsByEntity(
  entityId: string,
  options: { limit?: number; offset?: number; verdict?: string } = {},
): Promise<ApiResult<ByEntityResponse>> {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  if (options.offset !== undefined) params.set('offset', String(options.offset));
  if (options.verdict) params.set('verdict', options.verdict);
  const qs = params.toString();
  return apiRequest<ByEntityResponse>(
    'GET',
    `/api/source-checks/by-entity/${encodeURIComponent(entityId)}${qs ? `?${qs}` : ''}`,
  );
}

/**
 * Fetch all verdicts for records associated with a wiki page.
 */
export async function getVerdictsByPage(
  pageSlug: string,
  options: { limit?: number; offset?: number } = {},
): Promise<ApiResult<ByPageResponse>> {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  if (options.offset !== undefined) params.set('offset', String(options.offset));
  const qs = params.toString();
  return apiRequest<ByPageResponse>(
    'GET',
    `/api/source-checks/by-page/${encodeURIComponent(pageSlug)}${qs ? `?${qs}` : ''}`,
  );
}

/**
 * Fetch verdicts with failure verdicts (contradicted, outdated, partial, unverifiable).
 */
export async function getFailures(
  options: {
    error_type?: string;
    record_type?: string;
    entity_id?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<ApiResult<FailuresResponse>> {
  const params = new URLSearchParams();
  if (options.error_type) params.set('error_type', options.error_type);
  if (options.record_type) params.set('record_type', options.record_type);
  if (options.entity_id) params.set('entity_id', options.entity_id);
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  if (options.offset !== undefined) params.set('offset', String(options.offset));
  const qs = params.toString();
  return apiRequest<FailuresResponse>(
    'GET',
    `/api/source-checks/failures${qs ? `?${qs}` : ''}`,
  );
}

/**
 * Fetch verdicts older than N days that need rechecking.
 */
export async function getStaleVerdicts(
  options: {
    days?: number;
    record_type?: string;
    entity_id?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<ApiResult<StaleResponse>> {
  const params = new URLSearchParams();
  if (options.days !== undefined) params.set('days', String(options.days));
  if (options.record_type) params.set('record_type', options.record_type);
  if (options.entity_id) params.set('entity_id', options.entity_id);
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  if (options.offset !== undefined) params.set('offset', String(options.offset));
  const qs = params.toString();
  return apiRequest<StaleResponse>(
    'GET',
    `/api/source-checks/stale${qs ? `?${qs}` : ''}`,
  );
}

/**
 * Fetch all contradicted source-check verdicts and return the set of
 * entity IDs (stableIds) that have at least one contradicted verdict.
 */
export async function getContradictedEntityIds(): Promise<Set<string>> {
  const result = await getVerdictsByType('contradicted', 200);

  if (!result.ok) {
    console.warn(`[source-checks] Failed to fetch contradicted verdicts: ${result.message}`);
    return new Set();
  }

  const { verdicts, total } = result.data;
  if (total > verdicts.length) {
    console.warn(`[source-checks] Fetched ${verdicts.length}/${total} contradicted verdicts`);
  }

  const entityIds = new Set<string>();
  for (const verdict of verdicts) {
    if (verdict.entityId) {
      entityIds.add(verdict.entityId);
    }
  }
  return entityIds;
}
