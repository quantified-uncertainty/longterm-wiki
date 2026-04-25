/**
 * ModelSystemCards API — wiki-server client module
 *
 * Response types are inferred from the Hono RPC route type via
 * InferResponseType<>, except SyncResult which comes from the shared
 * factory response type (Hono RPC can't narrow through createSyncHandler).
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { ModelSystemCardsRoute } from '../../../apps/wiki-server/src/routes/tablebase/model-system-cards.ts';
import type { SyncResponse } from '../../../apps/wiki-server/src/routes/tablebase/sync-factory.ts';

type RpcClient = ReturnType<typeof hc<ModelSystemCardsRoute>>;

export type ModelSystemCardsAllResult = InferResponseType<RpcClient['all']['$get'], 200>;
export type ModelSystemCardsSyncResult = SyncResponse;

/** Fetch all model-system-cards rows with pagination. */
export async function getAllModelSystemCards(
  options?: { limit?: number; offset?: number },
): Promise<ApiResult<ModelSystemCardsAllResult>> {
  const params = new URLSearchParams();
  if (options?.limit != null) params.set('limit', String(options.limit));
  if (options?.offset != null) params.set('offset', String(options.offset));
  const qs = params.toString();
  return apiRequest<ModelSystemCardsAllResult>(
    'GET',
    `/api/model-system-cards/all${qs ? `?${qs}` : ''}`,
  );
}

/** Sync model-system-cards (upsert). */
export async function syncModelSystemCards(
  items: Array<Record<string, unknown>>,
): Promise<ApiResult<ModelSystemCardsSyncResult>> {
  return apiRequest<ModelSystemCardsSyncResult>('POST', '/api/model-system-cards/sync', { items });
}
