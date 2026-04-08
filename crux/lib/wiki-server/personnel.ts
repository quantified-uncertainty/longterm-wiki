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

/**
 * Sync personnel records (upsert).
 *
 * If `skipEntityValidation` is requested, the caller MUST also provide
 * `skipEntityValidationReason` — this is a "loud bypass" requirement from
 * epic #4017 Phase A. The reason is forwarded to the wiki-server, which logs
 * it at warn level for every request that uses the bypass.
 *
 * Throws `Error` synchronously (before issuing the request) if the reason is
 * missing. The thrown error has a clear message pointing at issue #4017.
 */
export async function syncPersonnel(
  items: Array<Record<string, unknown>>,
  options?: {
    skipEntityValidation?: boolean;
    /** Required when skipEntityValidation is true. Logged on every bypass. */
    skipEntityValidationReason?: string;
  },
): Promise<ApiResult<PersonnelSyncResult>> {
  if (options?.skipEntityValidation) {
    const reason = options.skipEntityValidationReason?.trim();
    if (!reason) {
      throw new Error(
        'syncPersonnel: skipEntityValidation requires skipEntityValidationReason — entity-validation bypass must be justified (issue #4017)',
      );
    }
  }
  const params = new URLSearchParams();
  if (options?.skipEntityValidation) {
    params.set('skipEntityValidation', 'true'); // skipEntityValidation-ok: typed wrapper enforces reason above
    params.set('skipEntityValidationReason', options.skipEntityValidationReason!);
  }
  const qs = params.toString();
  return apiRequest<PersonnelSyncResult>(
    'POST',
    `/api/personnel/sync${qs ? '?' + qs : ''}`,
    { items },
  );
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
