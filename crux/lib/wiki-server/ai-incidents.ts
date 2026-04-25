/**
 * AiIncidents API — wiki-server client module
 *
 * Response types are inferred from the Hono RPC route type via
 * InferResponseType<>, except SyncResult which comes from the shared
 * factory response type (Hono RPC can't narrow through createSyncHandler).
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { AiIncidentsRoute } from '../../../apps/wiki-server/src/routes/tablebase/ai-incidents.ts';
import type { SyncResponse } from '../../../apps/wiki-server/src/routes/tablebase/sync-factory.ts';
import type { AiIncidentSyncItem } from '../aiid/transform.ts';

type RpcClient = ReturnType<typeof hc<AiIncidentsRoute>>;

export type AiIncidentsAllResult = InferResponseType<RpcClient['all']['$get'], 200>;
export type AiIncidentsSyncResult = SyncResponse;

/** Fetch all ai-incidents rows with pagination. */
export async function getAllAiIncidents(
  options?: { limit?: number; offset?: number },
): Promise<ApiResult<AiIncidentsAllResult>> {
  const params = new URLSearchParams();
  if (options?.limit != null) params.set('limit', String(options.limit));
  if (options?.offset != null) params.set('offset', String(options.offset));
  const qs = params.toString();
  return apiRequest<AiIncidentsAllResult>(
    'GET',
    `/api/ai-incidents/all${qs ? `?${qs}` : ''}`,
  );
}

/** Sync ai-incidents (upsert). Items must match the route's Zod schema. */
export async function syncAiIncidents(
  items: AiIncidentSyncItem[],
): Promise<ApiResult<AiIncidentsSyncResult>> {
  return apiRequest<AiIncidentsSyncResult>('POST', '/api/ai-incidents/sync', { items });
}
