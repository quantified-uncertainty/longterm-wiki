/**
 * Personnel API — wiki-server client module
 *
 * Response types are inferred from the Hono RPC route type via InferResponseType<>.
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { PersonnelRoute } from '../../../apps/wiki-server/src/routes/tablebase/personnel.ts';

// ---------------------------------------------------------------------------
// Types — response (inferred from Hono RPC route)
// ---------------------------------------------------------------------------

type RpcClient = ReturnType<typeof hc<PersonnelRoute>>;

export type PersonnelByEntityResult = InferResponseType<RpcClient['by-entity'][':entityId']['$get'], 200>;
export type PersonnelAllResult = InferResponseType<RpcClient['all']['$get'], 200>;
export type PersonnelSyncResult = InferResponseType<RpcClient['sync']['$post'], 200>;
export type PersonnelDeleteResult = InferResponseType<RpcClient['delete']['$post'], 200>;
export type PersonnelStatsResult = InferResponseType<RpcClient['stats']['$get'], 200>;

/** A single personnel row from the by-entity result. */
export type PersonnelEntry = PersonnelByEntityResult['personnel'][number];

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/** Fetch personnel records for an entity. */
export async function getPersonnelByEntity(
  entityId: string,
  options?: { limit?: number; offset?: number },
): Promise<ApiResult<PersonnelByEntityResult>> {
  const params = new URLSearchParams();
  if (options?.limit != null) params.set('limit', String(options.limit));
  if (options?.offset != null) params.set('offset', String(options.offset));
  const qs = params.toString();
  return apiRequest<PersonnelByEntityResult>(
    'GET',
    `/api/personnel/by-entity/${encodeURIComponent(entityId)}${qs ? `?${qs}` : ''}`,
  );
}

/** Fetch all personnel records with pagination. */
export async function getAllPersonnel(
  options?: { limit?: number; offset?: number },
): Promise<ApiResult<PersonnelAllResult>> {
  const params = new URLSearchParams();
  if (options?.limit != null) params.set('limit', String(options.limit));
  if (options?.offset != null) params.set('offset', String(options.offset));
  const qs = params.toString();
  return apiRequest<PersonnelAllResult>(
    'GET',
    `/api/personnel/all${qs ? `?${qs}` : ''}`,
  );
}

/** Sync personnel records (upsert). */
export async function syncPersonnel(
  items: Array<Record<string, unknown>>,
  options?: { skipEntityValidation?: boolean },
): Promise<ApiResult<PersonnelSyncResult>> {
  const qs = options?.skipEntityValidation ? '?skipEntityValidation=true' : '';
  return apiRequest<PersonnelSyncResult>('POST', `/api/personnel/sync${qs}`, { items });
}

/** Delete personnel records by ID. */
export async function deletePersonnel(
  ids: string[],
): Promise<ApiResult<PersonnelDeleteResult>> {
  return apiRequest<PersonnelDeleteResult>('POST', '/api/personnel/delete', { ids });
}

/** Get personnel statistics. */
export async function getPersonnelStats(): Promise<ApiResult<PersonnelStatsResult>> {
  return apiRequest<PersonnelStatsResult>('GET', '/api/personnel/stats');
}
