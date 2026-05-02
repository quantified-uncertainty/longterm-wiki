/**
 * ScorecardGrades API — wiki-server client module
 *
 * Response types are inferred from the Hono RPC route type via
 * InferResponseType<>, except SyncResult which comes from the shared
 * factory response type (Hono RPC can't narrow through createSyncHandler).
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { ScorecardGradesRoute } from '../../../apps/wiki-server/src/routes/tablebase/scorecard-grades.ts';
import type { SyncResponse } from '../../../apps/wiki-server/src/routes/tablebase/sync-factory.ts';

type RpcClient = ReturnType<typeof hc<ScorecardGradesRoute>>;

export type ScorecardGradesAllResult = InferResponseType<RpcClient['all']['$get'], 200>;
export type ScorecardGradesSyncResult = SyncResponse;

/** Fetch all scorecard-grades rows with pagination + optional filters. */
export async function getAllScorecardGrades(
  options?: {
    limit?: number;
    offset?: number;
    snapshotId?: string;
    entityId?: string;
    scorecardSource?: string;
    /** Filter to grades whose snapshot has `is_latest=true`. */
    latest?: boolean;
    /** Filter to dimension_slug='overall' (the per-org rollup row). */
    overall?: boolean;
  },
): Promise<ApiResult<ScorecardGradesAllResult>> {
  const params = new URLSearchParams();
  if (options?.limit != null) params.set('limit', String(options.limit));
  if (options?.offset != null) params.set('offset', String(options.offset));
  if (options?.snapshotId) params.set('snapshotId', options.snapshotId);
  if (options?.entityId) params.set('entityId', options.entityId);
  if (options?.scorecardSource) params.set('scorecardSource', options.scorecardSource);
  if (options?.latest != null) params.set('latest', String(options.latest));
  if (options?.overall != null) params.set('overall', String(options.overall));
  const qs = params.toString();
  return apiRequest<ScorecardGradesAllResult>(
    'GET',
    `/api/scorecard-grades/all${qs ? `?${qs}` : ''}`,
  );
}

/** Sync scorecard-grades (upsert). */
export async function syncScorecardGrades(
  items: Array<Record<string, unknown>>,
): Promise<ApiResult<ScorecardGradesSyncResult>> {
  return apiRequest<ScorecardGradesSyncResult>('POST', '/api/scorecard-grades/sync', { items });
}
