/**
 * Pipeline Runs API — wiki-server client (QUA-954).
 *
 * Mirrors grants.ts: response types are inferred from the Hono RPC route
 * via InferResponseType<>, no raw `apiRequest<T>` with hand-written
 * generics. Used by `crux/lib/pipeline-runs/lifecycle.ts::withPipelineRun`.
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { hc, InferResponseType } from 'hono/client';
import type { PipelineRunsRoute } from '../../../apps/wiki-server/src/routes/operational/pipeline-runs.ts';

// ---------------------------------------------------------------------------
// Types — response (inferred from Hono RPC route)
// ---------------------------------------------------------------------------

type RpcClient = ReturnType<typeof hc<PipelineRunsRoute>>;

export type PipelineRunCreated = InferResponseType<RpcClient['index']['$post'], 201>;
export type PipelineRunHeartbeatResult = InferResponseType<
  RpcClient[':id']['heartbeat']['$patch'],
  200
>;
export type PipelineRunEndResult = InferResponseType<RpcClient[':id']['end']['$patch'], 200>;

export type PipelineRunsListResult = InferResponseType<RpcClient['index']['$get'], 200>;
export type PipelineRunRow = PipelineRunsListResult['runs'][number];
export type PipelineRunsStatsResult = InferResponseType<RpcClient['stats']['$get'], 200>;

// ---------------------------------------------------------------------------
// Types — request payloads
// ---------------------------------------------------------------------------

export interface StartPipelineRunInput {
  runId: string;
  pipelineName: string;
  agentSessionId?: number | null;
  entityId?: string | null;
  shape?: string | null;
}

export type PipelineRunEndStatus =
  | 'committed'
  | 'aborted'
  | 'oscillation'
  | 'partial_failure';

export interface EndPipelineRunInput {
  status: PipelineRunEndStatus;
  failureReason?: string | null;
  errorCode?: string | null;
  errorPayload?: Record<string, unknown> | null;
  snapshotPath?: string | null;
  followupActions?: Array<Record<string, unknown>>;
  // QUA-1012 cost telemetry. All optional — pipelines that don't track
  // cost simply omit them. Server caps: costUsd <= 10_000, each token
  // count <= 2_000_000_000.
  costUsd?: number | null;
  tokensInput?: number | null;
  tokensOutput?: number | null;
  tokensCacheRead?: number | null;
  tokensCacheWrite?: number | null;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/** Start a pipeline run. Returns the inserted row. */
export async function startPipelineRun(
  input: StartPipelineRunInput,
): Promise<ApiResult<PipelineRunCreated>> {
  return apiRequest<PipelineRunCreated>('POST', '/api/pipeline-runs', input);
}

/** Bump heartbeat_at on a running pipeline run. */
export async function heartbeatPipelineRun(
  runId: string,
): Promise<ApiResult<PipelineRunHeartbeatResult>> {
  return apiRequest<PipelineRunHeartbeatResult>(
    'PATCH',
    `/api/pipeline-runs/${encodeURIComponent(runId)}/heartbeat`,
  );
}

/** Finish a pipeline run — sets status, ended_at, and any failure context. */
export async function endPipelineRun(
  runId: string,
  input: EndPipelineRunInput,
): Promise<ApiResult<PipelineRunEndResult>> {
  return apiRequest<PipelineRunEndResult>(
    'PATCH',
    `/api/pipeline-runs/${encodeURIComponent(runId)}/end`,
    input,
  );
}

/** List pipeline runs, optionally filtered by status / pipeline_name. */
export async function listPipelineRuns(options?: {
  status?: 'running' | 'committed' | 'aborted' | 'oscillation' | 'partial_failure';
  pipelineName?: string;
  limit?: number;
}): Promise<ApiResult<PipelineRunsListResult>> {
  const params = new URLSearchParams();
  if (options?.status) params.set('status', options.status);
  if (options?.pipelineName) params.set('pipelineName', options.pipelineName);
  if (options?.limit != null) params.set('limit', String(options.limit));
  const qs = params.toString();
  return apiRequest<PipelineRunsListResult>(
    'GET',
    `/api/pipeline-runs${qs ? `?${qs}` : ''}`,
  );
}

/** Aggregate stats for the dashboard (last 24h). */
export async function getPipelineRunsStats(): Promise<ApiResult<PipelineRunsStatsResult>> {
  return apiRequest<PipelineRunsStatsResult>('GET', '/api/pipeline-runs/stats');
}
