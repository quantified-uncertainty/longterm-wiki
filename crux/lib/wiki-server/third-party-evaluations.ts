/**
 * ThirdPartyEvaluations API — wiki-server client module (QUA-692).
 *
 * Response types are inferred from the Hono RPC route type via
 * InferResponseType<>, except SyncResult which comes from the shared
 * factory response type (Hono RPC can't narrow through createSyncHandler).
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { ThirdPartyEvaluationsRoute } from '../../../apps/wiki-server/src/routes/tablebase/third-party-evaluations.ts';
import type { SyncResponse } from '../../../apps/wiki-server/src/routes/tablebase/sync-factory.ts';

type RpcClient = ReturnType<typeof hc<ThirdPartyEvaluationsRoute>>;

export type ThirdPartyEvaluationsAllResult = InferResponseType<RpcClient['all']['$get'], 200>;
export type ThirdPartyEvaluationsSyncResult = SyncResponse;

/** Fetch all third-party evaluations rows with pagination. */
export async function getAllThirdPartyEvaluations(
  options?: { limit?: number; offset?: number; evaluator_org_id?: string },
): Promise<ApiResult<ThirdPartyEvaluationsAllResult>> {
  const params = new URLSearchParams();
  if (options?.limit != null) params.set('limit', String(options.limit));
  if (options?.offset != null) params.set('offset', String(options.offset));
  if (options?.evaluator_org_id) params.set('evaluator_org_id', options.evaluator_org_id);
  const qs = params.toString();
  return apiRequest<ThirdPartyEvaluationsAllResult>(
    'GET',
    `/api/third-party-evaluations/all${qs ? `?${qs}` : ''}`,
  );
}

/** Sync third-party evaluations (upsert). Items may include inline `models` for join-table fan-out. */
export async function syncThirdPartyEvaluations(
  items: Array<Record<string, unknown>>,
): Promise<ApiResult<ThirdPartyEvaluationsSyncResult>> {
  return apiRequest<ThirdPartyEvaluationsSyncResult>(
    'POST',
    '/api/third-party-evaluations/sync',
    { items },
  );
}
