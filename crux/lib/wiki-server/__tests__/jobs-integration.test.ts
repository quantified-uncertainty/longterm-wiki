/**
 * Integration tests for the job queue API.
 *
 * These tests run against the REAL wiki-server and are skipped unless
 * explicitly opted in via the RUN_INTEGRATION env var. This prevents them
 * from breaking `pnpm test` when the server is not running.
 *
 * To run against production:
 *
 *   WIKI_SERVER_ENV=prod RUN_INTEGRATION=1 pnpm vitest run --config crux/vitest.config.ts crux/lib/wiki-server/__tests__/jobs-integration.test.ts
 *
 * Or against a local wiki-server:
 *
 *   LONGTERMWIKI_SERVER_URL=http://localhost:3112 RUN_INTEGRATION=1 pnpm vitest run --config crux/vitest.config.ts crux/lib/wiki-server/__tests__/jobs-integration.test.ts
 */

import dotenv from 'dotenv';
import { resolve } from 'path';

// Load .env from project root so env vars are available in vitest
dotenv.config({ path: resolve(import.meta.dirname, '../../../../.env') });

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import {
  createJob,
  claimJob,
  startJob,
  completeJob,
  failJob,
  cancelJob,
  getJob,
  listJobs,
} from '../jobs.ts';
import { apiRequest, getServerUrl, isServerAvailable } from '../client.ts';

const SERVER_URL = getServerUrl();
const RUN_INTEGRATION = process.env.RUN_INTEGRATION === '1';
const TEST_PREFIX = `test-integration-${Date.now()}`;

/** Track all job IDs created during tests so we can clean them up. */
const createdJobIds: number[] = [];

/** Helper: create a job and track it for cleanup. */
async function createTrackedJob(
  input: Parameters<typeof createJob>[0],
) {
  const result = await createJob(input);
  if (result.ok) {
    createdJobIds.push(result.data.id);
  }
  return result;
}

describe.skipIf(!RUN_INTEGRATION || !SERVER_URL)('jobs integration (real server)', () => {
  // Verify server is actually reachable before running tests
  beforeAll(async () => {
    const available = await isServerAvailable();
    if (!available) {
      throw new Error(
        `Wiki-server at ${SERVER_URL} is not reachable. ` +
        `Ensure the server is running or set WIKI_SERVER_ENV=prod to use production.`
      );
    }
  });

  // Clean up all jobs created during tests
  afterAll(async () => {
    for (const id of createdJobIds) {
      // Try to cancel first (works for pending/claimed)
      const cancelResult = await cancelJob(id);
      if (!cancelResult.ok) {
        // Job might be running — try to complete it
        const job = await getJob(id);
        if (job.ok && job.data.status === 'running') {
          await completeJob(id, { cleanup: true });
        }
        // If it's already completed/failed/cancelled, nothing to do
      }
    }
  });

  // ------------------------------------------------------------------
  // Test 1: Dedup key prevents duplicate enqueue
  // ------------------------------------------------------------------
  it('returns existing job when dedupKey conflicts', async () => {
    const dedupKey = `${TEST_PREFIX}-dedup-${Date.now()}`;
    const job1 = await createTrackedJob({
      type: `${TEST_PREFIX}-dedup`,
      dedupKey,
    });
    expect(job1.ok).toBe(true);
    if (!job1.ok) return;

    const job2 = await createTrackedJob({
      type: `${TEST_PREFIX}-dedup`,
      dedupKey,
    });
    expect(job2.ok).toBe(true);
    if (!job2.ok) return;

    // Should return the existing job, not create a new one
    expect(job2.data.id).toBe(job1.data.id);

    // Clean up
    await cancelJob(job1.data.id);
  });

  // ------------------------------------------------------------------
  // Test 2: Dedup key allows re-enqueue after completion
  // ------------------------------------------------------------------
  it('allows same dedupKey after original completes', async () => {
    const uniqueType = `${TEST_PREFIX}-reuse-${Date.now()}`;
    const dedupKey = `${TEST_PREFIX}-reuse-${Date.now()}`;
    const workerId = `${TEST_PREFIX}-worker-${Date.now()}`;

    const job1 = await createTrackedJob({
      type: uniqueType,
      dedupKey,
    });
    expect(job1.ok).toBe(true);
    if (!job1.ok) return;

    // Claim this specific job type so we get our job
    const claim = await claimJob(workerId, uniqueType);
    expect(claim.ok).toBe(true);
    if (!claim.ok || !claim.data.job) return;
    // claim endpoint returns IDs from raw SQL (may be stringified); compare as numbers
    expect(Number(claim.data.job.id)).toBe(Number(job1.data.id));

    // Drive it through start -> complete
    const started = await startJob(job1.data.id);
    expect(started.ok).toBe(true);
    const completed = await completeJob(job1.data.id, { ok: true });
    expect(completed.ok).toBe(true);

    // Now should be able to create a new job with the same dedupKey
    const job2 = await createTrackedJob({
      type: uniqueType,
      dedupKey,
    });
    expect(job2.ok).toBe(true);
    if (!job2.ok) return;

    expect(job2.data.id).not.toBe(job1.data.id);

    // Clean up the second job
    await cancelJob(job2.data.id);
  });

  // ------------------------------------------------------------------
  // Test 3: Exponential backoff sets run_after
  // ------------------------------------------------------------------
  it('sets run_after with exponential backoff on fail', async () => {
    const uniqueType = `${TEST_PREFIX}-backoff-${Date.now()}`;
    const workerId = `${TEST_PREFIX}-worker-${Date.now()}`;

    const job = await createTrackedJob({
      type: uniqueType,
      maxRetries: 3,
    });
    expect(job.ok).toBe(true);
    if (!job.ok) return;

    // Claim and start the job
    const claim = await claimJob(workerId, uniqueType);
    expect(claim.ok).toBe(true);
    if (!claim.ok || !claim.data.job) return;
    // claim endpoint returns IDs from raw SQL (may be stringified); compare as numbers
    expect(Number(claim.data.job.id)).toBe(Number(job.data.id));

    const started = await startJob(job.data.id);
    expect(started.ok).toBe(true);

    // Fail the job — should trigger retry with backoff
    const beforeFail = Date.now();
    const failed = await failJob(job.data.id, 'test backoff');
    expect(failed.ok).toBe(true);
    if (!failed.ok) return;

    // Should be retried (back to pending)
    expect(failed.data.retried).toBe(true);
    expect(failed.data.status).toBe('pending');
    expect(failed.data.retries).toBe(1);

    // Check the job has run_after set in the future
    const fetched = await getJob(job.data.id);
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;

    expect(fetched.data.runAfter).toBeTruthy();
    const runAfterMs = new Date(fetched.data.runAfter as string).getTime();

    // First retry: 2^0 * 30s = 30s from the server's now()
    // Allow some clock skew between client and server (up to 10s)
    expect(runAfterMs).toBeGreaterThan(beforeFail + 20_000);
    expect(runAfterMs).toBeLessThan(beforeFail + 45_000);

    // Clean up — the job is now pending with future run_after, so cancel it
    await cancelJob(job.data.id);
  });

  // ------------------------------------------------------------------
  // Test 4: run_after prevents premature claim
  // ------------------------------------------------------------------
  it('does not claim jobs with future run_after', async () => {
    const uniqueType = `${TEST_PREFIX}-future-${Date.now()}`;
    const workerId = `${TEST_PREFIX}-worker-${Date.now()}`;

    // Create a job with run_after 1 hour in the future
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const job = await createTrackedJob({
      type: uniqueType,
      runAfter: future,
    });
    expect(job.ok).toBe(true);
    if (!job.ok) return;

    // Try to claim — should NOT get this job since run_after is in the future
    const claim = await claimJob(workerId, uniqueType);
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    // Should get null (no claimable job of this type)
    expect(claim.data.job).toBeNull();

    // Clean up
    await cancelJob(job.data.id);
  });

  // ------------------------------------------------------------------
  // Test 5: Parent-child relationship
  // ------------------------------------------------------------------
  it('returns child job summary via children endpoint', async () => {
    const parentType = `${TEST_PREFIX}-parent-${Date.now()}`;
    const childType = `${TEST_PREFIX}-child-${Date.now()}`;

    const parent = await createTrackedJob({ type: parentType });
    expect(parent.ok).toBe(true);
    if (!parent.ok) return;

    const child1 = await createTrackedJob({
      type: childType,
      parentJobId: parent.data.id,
    });
    const child2 = await createTrackedJob({
      type: childType,
      parentJobId: parent.data.id,
    });
    expect(child1.ok).toBe(true);
    expect(child2.ok).toBe(true);
    if (!child1.ok || !child2.ok) return;

    // Fetch children summary via the API
    const children = await apiRequest<{
      parentJobId: number;
      children: Record<string, number>;
      total: number;
    }>('GET', `/api/jobs/${parent.data.id}/children`);

    expect(children.ok).toBe(true);
    if (!children.ok) return;

    expect(children.data.parentJobId).toBe(parent.data.id);
    expect(children.data.total).toBe(2);
    expect(children.data.children.pending).toBe(2);

    // Clean up
    await cancelJob(child1.data.id);
    await cancelJob(child2.data.id);
    await cancelJob(parent.data.id);
  });

  // ------------------------------------------------------------------
  // Test 6: Cost tracking
  // ------------------------------------------------------------------
  it('stores cost on complete', async () => {
    const uniqueType = `${TEST_PREFIX}-cost-${Date.now()}`;
    const workerId = `${TEST_PREFIX}-worker-${Date.now()}`;

    const job = await createTrackedJob({ type: uniqueType });
    expect(job.ok).toBe(true);
    if (!job.ok) return;

    // Claim and start
    const claim = await claimJob(workerId, uniqueType);
    expect(claim.ok).toBe(true);
    if (!claim.ok || !claim.data.job) return;
    // claim endpoint returns IDs from raw SQL (may be stringified); compare as numbers
    expect(Number(claim.data.job.id)).toBe(Number(job.data.id));

    const started = await startJob(job.data.id);
    expect(started.ok).toBe(true);

    // Complete with cost
    const completed = await completeJob(job.data.id, { ok: true }, 0.0042);
    expect(completed.ok).toBe(true);

    // Fetch and verify cost was stored
    const fetched = await getJob(job.data.id);
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;

    expect(fetched.data.status).toBe('completed');
    expect(fetched.data.costUsd).toBe('0.0042');
  });

  // ------------------------------------------------------------------
  // Test 7: Full lifecycle (create -> claim -> start -> complete -> verify)
  // ------------------------------------------------------------------
  it('completes a full job lifecycle', async () => {
    const uniqueType = `${TEST_PREFIX}-lifecycle-${Date.now()}`;
    const workerId = `${TEST_PREFIX}-worker-${Date.now()}`;

    // Create
    const job = await createTrackedJob({ type: uniqueType });
    expect(job.ok).toBe(true);
    if (!job.ok) return;
    expect(job.data.status).toBe('pending');

    // Claim
    const claim = await claimJob(workerId, uniqueType);
    expect(claim.ok).toBe(true);
    if (!claim.ok || !claim.data.job) return;
    // claim endpoint returns IDs from raw SQL (may be stringified); compare as numbers
    expect(Number(claim.data.job.id)).toBe(Number(job.data.id));
    expect(claim.data.job.status).toBe('claimed');
    expect(claim.data.job.workerId).toBe(workerId);

    // Start
    const started = await startJob(job.data.id);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.data.status).toBe('running');

    // Complete
    const completed = await completeJob(job.data.id, { result: 'success' });
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.data.status).toBe('completed');
    expect(completed.data.result).toEqual({ result: 'success' });

    // Verify via getJob
    const fetched = await getJob(job.data.id);
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;
    expect(fetched.data.status).toBe('completed');
    expect(fetched.data.completedAt).toBeTruthy();
  });

  // ------------------------------------------------------------------
  // Test 8: Cancel prevents claim
  // ------------------------------------------------------------------
  it('cancelled jobs cannot be claimed', async () => {
    const uniqueType = `${TEST_PREFIX}-cancel-${Date.now()}`;
    const workerId = `${TEST_PREFIX}-worker-${Date.now()}`;

    const job = await createTrackedJob({ type: uniqueType });
    expect(job.ok).toBe(true);
    if (!job.ok) return;

    // Cancel immediately
    const cancelled = await cancelJob(job.data.id);
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) return;
    expect(cancelled.data.status).toBe('cancelled');

    // Try to claim — should not get this job
    const claim = await claimJob(workerId, uniqueType);
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    expect(claim.data.job).toBeNull();
  });

  // ------------------------------------------------------------------
  // Test 9: Max retries exhaustion leads to failed status
  // ------------------------------------------------------------------
  it('marks job as failed when retries are exhausted', async () => {
    const uniqueType = `${TEST_PREFIX}-exhaust-${Date.now()}`;
    const workerId = `${TEST_PREFIX}-worker-${Date.now()}`;

    const job = await createTrackedJob({
      type: uniqueType,
      maxRetries: 1,
    });
    expect(job.ok).toBe(true);
    if (!job.ok) return;

    // Claim and start
    const claim = await claimJob(workerId, uniqueType);
    expect(claim.ok).toBe(true);
    if (!claim.ok || !claim.data.job) return;

    const started = await startJob(job.data.id);
    expect(started.ok).toBe(true);

    // Fail — maxRetries=1 means only 1 attempt total, so first fail is permanent
    const fail1 = await failJob(job.data.id, 'first failure');
    expect(fail1.ok).toBe(true);
    if (!fail1.ok) return;
    expect(fail1.data.retried).toBe(false);
    expect(fail1.data.status).toBe('failed');

    // Verify final state
    const fetched = await getJob(job.data.id);
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;
    expect(fetched.data.status).toBe('failed');
    expect(fetched.data.error).toBe('first failure');
    expect(fetched.data.retries).toBe(1);
  });

  // ------------------------------------------------------------------
  // Test 10: listJobs filters by type
  // ------------------------------------------------------------------
  it('lists jobs filtered by type', async () => {
    const uniqueType = `${TEST_PREFIX}-list-${Date.now()}`;

    const job1 = await createTrackedJob({ type: uniqueType });
    const job2 = await createTrackedJob({ type: uniqueType });
    expect(job1.ok).toBe(true);
    expect(job2.ok).toBe(true);
    if (!job1.ok || !job2.ok) return;

    const list = await listJobs({ type: uniqueType });
    expect(list.ok).toBe(true);
    if (!list.ok) return;

    expect(list.data.total).toBe(2);
    expect(list.data.entries).toHaveLength(2);

    const ids = list.data.entries.map((e) => e.id);
    expect(ids).toContain(job1.data.id);
    expect(ids).toContain(job2.data.id);

    // Clean up
    await cancelJob(job1.data.id);
    await cancelJob(job2.data.id);
  });
});
