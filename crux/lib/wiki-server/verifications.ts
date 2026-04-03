/**
 * Verifications (Source-Check) API — wiki-server client module
 *
 * Handles source-check evidence and verdict storage.
 * Response types are inferred from the Hono RPC route type via InferResponseType<>.
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { SourceChecksRoute } from '../../../apps/wiki-server/src/routes/source-check/source-checks.ts';

// ---------------------------------------------------------------------------
// Types — response (inferred from Hono RPC route)
// ---------------------------------------------------------------------------

type RpcClient = ReturnType<typeof hc<SourceChecksRoute>>;

export type StoreEvidenceResult = InferResponseType<RpcClient['evidence']['$post'], 201>;
export type StoreVerdictResult = InferResponseType<RpcClient['verdicts']['$post'], 200>;
export type ListVerdictsResult = InferResponseType<RpcClient['verdicts']['$get'], 200>;
export type VerdictByRecordResult = InferResponseType<RpcClient['verdicts'][':recordType'][':recordId']['$get'], 200>;
export type DueForRecheckResult = InferResponseType<RpcClient['due-for-recheck']['$get'], 200>;
export type EvidenceByRecordResult = InferResponseType<RpcClient['evidence'][':recordType'][':recordId']['$get'], 200>;
export type VerificationStatsResult = InferResponseType<RpcClient['stats']['$get'], 200>;

/** A single verdict entry from the list. */
export type VerdictListEntry = ListVerdictsResult['verdicts'][number];

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/** Store individual source-check evidence. */
export async function storeEvidence(
  body: Record<string, unknown>,
): Promise<ApiResult<StoreEvidenceResult>> {
  return apiRequest<StoreEvidenceResult>('POST', '/api/verifications/evidence', body);
}

/** Store an aggregate verdict for a record. */
export async function storeVerdict(
  body: Record<string, unknown>,
): Promise<ApiResult<StoreVerdictResult>> {
  return apiRequest<StoreVerdictResult>('POST', '/api/verifications/verdicts', body);
}

/** List verdicts with optional filters. */
export async function listVerdicts(
  options?: { recordType?: string; verdict?: string; limit?: number; offset?: number },
): Promise<ApiResult<ListVerdictsResult>> {
  const params = new URLSearchParams();
  if (options?.recordType) params.set('record_type', options.recordType);
  if (options?.verdict) params.set('verdict', options.verdict);
  if (options?.limit != null) params.set('limit', String(options.limit));
  if (options?.offset != null) params.set('offset', String(options.offset));
  const qs = params.toString();
  return apiRequest<ListVerdictsResult>(
    'GET',
    `/api/verifications/verdicts${qs ? `?${qs}` : ''}`,
  );
}

/** Get verdicts for a specific record. */
export async function getVerdictByRecord(
  recordType: string,
  recordId: string,
): Promise<ApiResult<VerdictByRecordResult>> {
  return apiRequest<VerdictByRecordResult>(
    'GET',
    `/api/verifications/verdicts/${encodeURIComponent(recordType)}/${encodeURIComponent(recordId)}`,
  );
}

/** Get evidence for a specific record. */
export async function getEvidenceByRecord(
  recordType: string,
  recordId: string,
  options?: { limit?: number },
): Promise<ApiResult<EvidenceByRecordResult>> {
  const params = new URLSearchParams();
  if (options?.limit != null) params.set('limit', String(options.limit));
  const qs = params.toString();
  return apiRequest<EvidenceByRecordResult>(
    'GET',
    `/api/verifications/evidence/${encodeURIComponent(recordType)}/${encodeURIComponent(recordId)}${qs ? '?' + qs : ''}`,
  );
}

/** Get verification statistics. */
export async function getVerificationStats(): Promise<ApiResult<VerificationStatsResult>> {
  return apiRequest<VerificationStatsResult>('GET', '/api/verifications/stats');
}

/** Get records due for re-check. */
export async function getDueForRecheck(
  options?: { recordType?: string; limit?: number },
): Promise<ApiResult<DueForRecheckResult>> {
  const params = new URLSearchParams();
  if (options?.recordType) params.set('record_type', options.recordType);
  if (options?.limit != null) params.set('limit', String(options.limit));
  const qs = params.toString();
  return apiRequest<DueForRecheckResult>(
    'GET',
    `/api/verifications/due-for-recheck${qs ? `?${qs}` : ''}`,
  );
}
