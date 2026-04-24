/**
 * ScorecardSnapshots API — wiki-server client module
 *
 * Response types are inferred from the Hono RPC route type via
 * InferResponseType<>, except SyncResult which comes from the shared
 * factory response type (Hono RPC can't narrow through createSyncHandler).
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { ScorecardSnapshotsRoute } from '../../../apps/wiki-server/src/routes/tablebase/scorecard-snapshots.ts';
import type { SyncResponse } from '../../../apps/wiki-server/src/routes/tablebase/sync-factory.ts';

type RpcClient = ReturnType<typeof hc<ScorecardSnapshotsRoute>>;

export type ScorecardSnapshotsAllResult = InferResponseType<RpcClient['all']['$get'], 200>;
export type ScorecardSnapshotsSyncResult = SyncResponse;

/** Fetch all scorecard-snapshots rows with pagination. */
export async function getAllScorecardSnapshots(
  options?: { limit?: number; offset?: number },
): Promise<ApiResult<ScorecardSnapshotsAllResult>> {
  const params = new URLSearchParams();
  if (options?.limit != null) params.set('limit', String(options.limit));
  if (options?.offset != null) params.set('offset', String(options.offset));
  const qs = params.toString();
  return apiRequest<ScorecardSnapshotsAllResult>(
    'GET',
    `/api/scorecard-snapshots/all${qs ? `?${qs}` : ''}`,
  );
}

/** Sync scorecard-snapshots (upsert). */
export async function syncScorecardSnapshots(
  items: Array<Record<string, unknown>>,
): Promise<ApiResult<ScorecardSnapshotsSyncResult>> {
  return apiRequest<ScorecardSnapshotsSyncResult>('POST', '/api/scorecard-snapshots/sync', { items });
}
