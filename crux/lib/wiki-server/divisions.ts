/**
 * Divisions API — wiki-server client module
 *
 * Response types are inferred from the Hono RPC route type via InferResponseType<>.
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { DivisionsRoute } from '../../../apps/wiki-server/src/routes/tablebase/divisions.ts';
import type { SyncResponse } from '../../../apps/wiki-server/src/routes/tablebase/sync-factory.ts';

// ---------------------------------------------------------------------------
// Types — response (inferred from Hono RPC route)
// ---------------------------------------------------------------------------

type RpcClient = ReturnType<typeof hc<DivisionsRoute>>;

export type DivisionsByOrgResult = InferResponseType<RpcClient['by-org'][':orgId']['$get'], 200>;
// createSyncHandler returns Promise<Response>, erasing the typed shape for
// InferResponseType — import the concrete factory response type instead.
export type DivisionsSyncResult = SyncResponse;

/** A single division row. */
export type DivisionEntry = DivisionsByOrgResult['divisions'][number];

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/** Fetch divisions for an org. */
export async function getDivisionsByOrg(
  orgId: string,
  options?: { limit?: number },
): Promise<ApiResult<DivisionsByOrgResult>> {
  const params = new URLSearchParams();
  if (options?.limit != null) params.set('limit', String(options.limit));
  const qs = params.toString();
  return apiRequest<DivisionsByOrgResult>(
    'GET',
    `/api/divisions/by-org/${encodeURIComponent(orgId)}${qs ? `?${qs}` : ''}`,
  );
}

/** Sync divisions (upsert). */
export async function syncDivisions(
  items: Array<Record<string, unknown>>,
): Promise<ApiResult<DivisionsSyncResult>> {
  return apiRequest<DivisionsSyncResult>('POST', '/api/divisions/sync', { items });
}
