/**
 * QA Checks API — wiki-server client module
 *
 * Records page check results and queries the staleness-ordered queue
 * so /qa-sweep can prioritize least-recently-checked pages.
 *
 * Response types are inferred via Hono RPC InferResponseType<>.
 */

import type { hc, InferResponseType } from 'hono/client';
import type { QaChecksRoute } from '../../../apps/wiki-server/src/routes/operational/qa-checks.ts';
import { apiRequest, type ApiResult } from './client.ts';

// ---------------------------------------------------------------------------
// Types — response (inferred from Hono RPC route)
// ---------------------------------------------------------------------------

type RpcClient = ReturnType<typeof hc<QaChecksRoute>>;

export type QaCheckRecord = InferResponseType<RpcClient['index']['$post'], 201>;
export type QaCheckBatchResult = InferResponseType<RpcClient['batch']['$post'], 201>;
export type QaCheckListResult = InferResponseType<RpcClient['index']['$get'], 200>;
export type QaQueueResult = InferResponseType<RpcClient['queue']['$get'], 200>;
export type QaCoverageResult = InferResponseType<RpcClient['coverage']['$get'], 200>;

// ---------------------------------------------------------------------------
// Types — input
// ---------------------------------------------------------------------------

export interface QaCheckInput {
  thingId?: string | null;
  pageUrl: string;
  directory?: string | null;
  checkType?: 'index' | 'detail' | 'cross-consistency';
  result: 'clean' | 'issues_found' | 'error' | '404';
  findings?: { severity: 'P0' | 'P1' | 'P2'; description: string; githubIssue?: number }[] | null;
  depth?: 'quick' | 'standard' | 'deep' | 'exhaustive' | null;
  sweepId?: string | null;
  checkedAt?: string;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Get the staleness-ordered queue of pages to check.
 */
export async function getQaQueue(
  directory?: string,
  limit?: number,
): Promise<ApiResult<QaQueueResult>> {
  const params = new URLSearchParams();
  if (directory) params.set('directory', directory);
  if (limit) params.set('limit', String(limit));
  const qs = params.toString();
  return apiRequest<QaQueueResult>('GET', `/api/qa-checks/queue${qs ? `?${qs}` : ''}`);
}

/**
 * Record a single QA check result.
 */
export async function recordQaCheck(
  data: QaCheckInput,
): Promise<ApiResult<QaCheckRecord>> {
  return apiRequest<QaCheckRecord>('POST', '/api/qa-checks', data);
}

/**
 * Record multiple QA check results in a single request.
 */
export async function recordQaCheckBatch(
  items: QaCheckInput[],
): Promise<ApiResult<QaCheckBatchResult>> {
  return apiRequest<QaCheckBatchResult>('POST', '/api/qa-checks/batch', { items });
}

/**
 * Get per-directory coverage stats.
 */
export async function getQaCoverage(): Promise<ApiResult<QaCoverageResult>> {
  return apiRequest<QaCoverageResult>('GET', '/api/qa-checks/coverage');
}

/**
 * List recent QA checks with optional filters.
 */
export async function listQaChecks(opts?: {
  directory?: string;
  sweepId?: string;
  limit?: number;
  offset?: number;
}): Promise<ApiResult<QaCheckListResult>> {
  const params = new URLSearchParams();
  if (opts?.directory) params.set('directory', opts.directory);
  if (opts?.sweepId) params.set('sweep_id', opts.sweepId);
  if (opts?.limit) params.set('limit', String(opts.limit));
  if (opts?.offset) params.set('offset', String(opts.offset));
  const qs = params.toString();
  return apiRequest<QaCheckListResult>('GET', `/api/qa-checks${qs ? `?${qs}` : ''}`);
}
