/**
 * Reconciliation Runs API — wiki-server client (QUA-958, parent QUA-943).
 *
 * Used by:
 *   - `crux/commands/maintenance-reconcile-stakeholders.ts` to record cron ticks
 *   - `crux/pr-patrol/health-scan.ts` to drive the `pg-yaml-divergence` sentinel
 *   - `crux/commands/research-improve-entity.ts` for the auto-halt guard
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { ReconciliationRunsRoute } from '../../../apps/wiki-server/src/routes/operational/reconciliation-runs.ts';

type RpcClient = ReturnType<typeof hc<ReconciliationRunsRoute>>;

export type ReconciliationStartResult = InferResponseType<
  RpcClient['start']['$post'],
  200
>;
export type ReconciliationCompleteResult = InferResponseType<
  RpcClient['complete']['$post'],
  200
>;
export type ReconciliationSummaryResult = InferResponseType<
  RpcClient['summary']['$get'],
  200
>;
export type ReconciliationListResult = InferResponseType<
  RpcClient['list']['$get'],
  200
>;

export type ReconciliationDomain = 'policy_stakeholders';

export interface StartReconciliationInput {
  domain: ReconciliationDomain;
  trigger: 'scheduled' | 'manual';
  startedAt?: string;
}

export interface CompleteReconciliationInput {
  id: number;
  entitiesScanned: number;
  entitiesNonEmpty: number;
  diffsDetected: number;
  nonEmptyDiffsObserved: number;
  detailsJson?: Record<string, unknown>;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export async function startReconciliationRun(
  input: StartReconciliationInput,
): Promise<ApiResult<ReconciliationStartResult>> {
  return apiRequest<ReconciliationStartResult>(
    'POST',
    '/api/reconciliation-runs/start',
    input,
  );
}

export async function completeReconciliationRun(
  input: CompleteReconciliationInput,
): Promise<ApiResult<ReconciliationCompleteResult>> {
  return apiRequest<ReconciliationCompleteResult>(
    'POST',
    '/api/reconciliation-runs/complete',
    input,
  );
}

export async function getReconciliationSummary(options?: {
  domain?: ReconciliationDomain;
  windowDays?: number;
}): Promise<ApiResult<ReconciliationSummaryResult>> {
  const params = new URLSearchParams();
  if (options?.domain) params.set('domain', options.domain);
  if (options?.windowDays != null)
    params.set('windowDays', String(options.windowDays));
  const qs = params.toString();
  return apiRequest<ReconciliationSummaryResult>(
    'GET',
    `/api/reconciliation-runs/summary${qs ? `?${qs}` : ''}`,
  );
}

export async function listReconciliationRuns(options?: {
  domain?: ReconciliationDomain;
  limit?: number;
}): Promise<ApiResult<ReconciliationListResult>> {
  const params = new URLSearchParams();
  if (options?.domain) params.set('domain', options.domain);
  if (options?.limit != null) params.set('limit', String(options.limit));
  const qs = params.toString();
  return apiRequest<ReconciliationListResult>(
    'GET',
    `/api/reconciliation-runs/list${qs ? `?${qs}` : ''}`,
  );
}
