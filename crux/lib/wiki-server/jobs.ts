/**
 * Jobs API — wiki-server client module
 *
 * Client functions for the job queue system.
 * Input types are derived from the canonical Zod schemas in api-types.ts.
 */

import { apiRequest, batchedRequest, type ApiResult } from './client.ts';
import type {
  CreateJobInput,
  ClaimJob,
  CompleteJob,
  FailJob,
  SweepJobs,
} from '../../../apps/wiki-server/src/api-types.ts';

// ---------------------------------------------------------------------------
// Types — input (derived from server Zod schemas)
// ---------------------------------------------------------------------------

export type { CreateJobInput };
export type { ClaimJob as ClaimJobInput };
export type { CompleteJob as CompleteJobInput };
export type { FailJob as FailJobInput };
export type { SweepJobs as SweepJobsInput };

// ---------------------------------------------------------------------------
// Types — response shapes (defined by server RETURNING clauses)
// ---------------------------------------------------------------------------

export interface JobEntry {
  id: number;
  type: string;
  status: string;
  params: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error: string | null;
  priority: number;
  retries: number;
  maxRetries: number;
  createdAt: string;
  claimedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  workerId: string | null;
}

export interface ListJobsResult {
  entries: JobEntry[];
  total: number;
  limit: number;
  offset: number;
}

export interface ClaimResult {
  job: JobEntry | null;
}

export interface JobStatsResult {
  totalJobs: number;
  byType: Record<
    string,
    {
      byStatus: Record<string, number>;
      avgDurationMs?: number;
      failureRate?: number;
    }
  >;
}

export interface SweepResult {
  swept: number;
  jobs: Array<{ id: number; type: string }>;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/** Create a single job. */
export async function createJob(
  input: CreateJobInput,
): Promise<ApiResult<JobEntry>> {
  return apiRequest<JobEntry>('POST', '/api/jobs', input);
}

/** Create multiple jobs in a batch. */
export async function createJobBatch(
  inputs: CreateJobInput[],
): Promise<ApiResult<JobEntry[]>> {
  return apiRequest<JobEntry[]>('POST', '/api/jobs', inputs);
}

/** List jobs with optional filters. */
export async function listJobs(opts?: {
  status?: string;
  type?: string;
  limit?: number;
  offset?: number;
}): Promise<ApiResult<ListJobsResult>> {
  const params = new URLSearchParams();
  if (opts?.status) params.set('status', opts.status);
  if (opts?.type) params.set('type', opts.type);
  if (opts?.limit != null) params.set('limit', String(opts.limit));
  if (opts?.offset != null) params.set('offset', String(opts.offset));
  const qs = params.toString();
  return apiRequest<ListJobsResult>('GET', `/api/jobs${qs ? `?${qs}` : ''}`);
}

/** Get a single job by ID. */
export async function getJob(id: number): Promise<ApiResult<JobEntry>> {
  return apiRequest<JobEntry>('GET', `/api/jobs/${id}`);
}

/** Claim the next pending job. */
export async function claimJob(
  workerId: string,
  type?: string,
): Promise<ApiResult<ClaimResult>> {
  return batchedRequest<ClaimResult>('POST', '/api/jobs/claim', {
    workerId,
    ...(type ? { type } : {}),
  });
}

/** Mark a claimed job as running. */
export async function startJob(id: number): Promise<ApiResult<JobEntry>> {
  return apiRequest<JobEntry>('POST', `/api/jobs/${id}/start`, {});
}

/** Mark a running job as completed with a result. */
export async function completeJob(
  id: number,
  result?: Record<string, unknown> | null,
): Promise<ApiResult<JobEntry>> {
  return apiRequest<JobEntry>('POST', `/api/jobs/${id}/complete`, {
    result: result ?? null,
  });
}

/** Mark a running/claimed job as failed with an error message. */
export async function failJob(
  id: number,
  error: string,
): Promise<ApiResult<JobEntry & { retried: boolean }>> {
  return apiRequest<JobEntry & { retried: boolean }>(
    'POST',
    `/api/jobs/${id}/fail`,
    { error },
  );
}

/** Cancel a pending or claimed job. */
export async function cancelJob(id: number): Promise<ApiResult<JobEntry>> {
  return apiRequest<JobEntry>('POST', `/api/jobs/${id}/cancel`, {});
}

/** Get aggregate job statistics. */
export async function getJobStats(): Promise<ApiResult<JobStatsResult>> {
  return apiRequest<JobStatsResult>('GET', '/api/jobs/stats');
}

/** Sweep stale jobs (stuck in claimed/running past timeout). */
export async function sweepJobs(
  timeoutMinutes?: number,
): Promise<ApiResult<SweepResult>> {
  return apiRequest<SweepResult>('POST', '/api/jobs/sweep', {
    ...(timeoutMinutes ? { timeoutMinutes } : {}),
  });
}
