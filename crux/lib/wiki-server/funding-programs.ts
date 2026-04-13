/**
 * Funding Programs API — wiki-server client module
 *
 * Response types are inferred from the Hono RPC route type via InferResponseType<>.
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { FundingProgramsRoute } from '../../../apps/wiki-server/src/routes/tablebase/funding-programs.ts';
import type { SyncResponse } from '../../../apps/wiki-server/src/routes/tablebase/sync-factory.ts';

// ---------------------------------------------------------------------------
// Types — response (inferred from Hono RPC route)
// ---------------------------------------------------------------------------

type RpcClient = ReturnType<typeof hc<FundingProgramsRoute>>;

export type FundingProgramsByOrgResult = InferResponseType<RpcClient['by-org'][':orgId']['$get'], 200>;
export type FundingProgramsAllResult = InferResponseType<RpcClient['all']['$get'], 200>;
// createSyncHandler returns Promise<Response>, erasing the typed shape for
// InferResponseType — import the concrete factory response type instead.
export type FundingProgramsSyncResult = SyncResponse;
export type FundingProgramsDeleteResult = InferResponseType<RpcClient['delete-batch']['$post'], 200>;

/** A single funding program row from the by-org result. */
export type FundingProgramEntry = FundingProgramsByOrgResult['fundingPrograms'][number];

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/** Fetch funding programs for an org. */
export async function getFundingProgramsByOrg(
  orgId: string,
  options?: { limit?: number },
): Promise<ApiResult<FundingProgramsByOrgResult>> {
  const params = new URLSearchParams();
  if (options?.limit != null) params.set('limit', String(options.limit));
  const qs = params.toString();
  return apiRequest<FundingProgramsByOrgResult>(
    'GET',
    `/api/funding-programs/by-org/${encodeURIComponent(orgId)}${qs ? `?${qs}` : ''}`,
  );
}

/** Fetch all funding programs with pagination. */
export async function getAllFundingPrograms(
  options?: { limit?: number; offset?: number },
): Promise<ApiResult<FundingProgramsAllResult>> {
  const params = new URLSearchParams();
  if (options?.limit != null) params.set('limit', String(options.limit));
  if (options?.offset != null) params.set('offset', String(options.offset));
  const qs = params.toString();
  return apiRequest<FundingProgramsAllResult>(
    'GET',
    `/api/funding-programs/all${qs ? `?${qs}` : ''}`,
  );
}

/** Sync funding programs (upsert). */
export async function syncFundingPrograms(
  items: Array<Record<string, unknown>>,
): Promise<ApiResult<FundingProgramsSyncResult>> {
  return apiRequest<FundingProgramsSyncResult>('POST', '/api/funding-programs/sync', { items });
}

/** Delete funding programs by ID. */
export async function deleteFundingPrograms(
  ids: string[],
): Promise<ApiResult<FundingProgramsDeleteResult>> {
  return apiRequest<FundingProgramsDeleteResult>('POST', '/api/funding-programs/delete-batch', { ids });
}
