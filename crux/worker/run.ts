/**
 * Job Worker Runner
 *
 * Long-lived worker process that polls the wiki-server job queue, claims jobs,
 * executes handlers, and reports results. Designed for K8s deployment with
 * graceful shutdown, health probes, memory watchdog, and exponential backoff.
 *
 * Usage:
 *   node --import tsx/esm crux/worker/run.ts [options]
 *
 * Options:
 *   --types=<t1,t2,...>   Only claim jobs of these types (comma-separated)
 *   --type=<type>         Only claim jobs of this type (single; alias for --types)
 *   --max-jobs=<n>        Max jobs to process before exiting (default: Infinity in poll mode, 1 otherwise)
 *   --poll                Keep polling for jobs (instead of exit after max-jobs)
 *   --poll-interval=<ms>  Base polling interval in ms (default: 30000)
 *   --concurrency=<n>     Max concurrent jobs per worker (default: 1)
 *   --verbose             Verbose output
 *   --worker-id=<id>      Custom worker ID (default: auto-generated)
 *   --smoke-test          Run a ping job round-trip and exit
 *
 * Environment:
 *   LONGTERMWIKI_SERVER_URL     -- Wiki server URL (required)
 *   LONGTERMWIKI_SERVER_API_KEY -- API key for authentication
 *   WORKER_HEALTH_PORT          -- HTTP health endpoint port (default: 3101)
 *   WORKER_MAX_RSS_MB           -- Memory limit in MB before graceful exit (default: 768)
 */

import { join } from 'path';
import { createServer, type Server } from 'http';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { getHandler, getRegisteredTypes } from '../lib/job-handlers/index.ts';
import { assertConfiguredTypesAreRegistered } from './types-guard.ts';
import {
  claimJob, claimJobWithTypes, startJob, completeJob, failJob, cancelJob,
  createJob, sweepJobs,
} from '../lib/wiki-server/jobs.ts';
import { apiRequest } from '../lib/wiki-server/client.ts';
import type { ApiResult } from '../lib/wiki-server/client.ts';
import type { JobHandlerContext } from '../lib/job-handlers/types.ts';
import type { ClaimResult } from '../lib/wiki-server/jobs.ts';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface WorkerConfig {
  workerId: string;
  types: string[];
  maxJobs: number;
  poll: boolean;
  pollIntervalMs: number;
  concurrency: number;
  verbose: boolean;
  projectRoot: string;
  smokeTest: boolean;
}

function parseConfig(): WorkerConfig {
  const args = process.argv.slice(2);
  const opts: Record<string, string | boolean> = {};

  for (const arg of args) {
    if (arg.startsWith('--')) {
      const [key, ...valueParts] = arg.slice(2).split('=');
      const value = valueParts.join('=');
      opts[key] = value || true;
    }
  }

  const workerId = (opts['worker-id'] as string) ??
    `worker-${process.pid}-${Date.now().toString(36)}`;

  // --types=a,b,c or --type=a (single type alias)
  let types: string[] = [];
  if (typeof opts['types'] === 'string') {
    types = opts['types'].split(',').map(t => t.trim()).filter(Boolean);
  } else if (typeof opts['type'] === 'string') {
    types = [opts['type']];
  }

  const poll = opts['poll'] === true;

  return {
    workerId,
    types,
    maxJobs: parseInt(opts['max-jobs'] as string || (poll ? '0' : '1'), 10) || Infinity,
    poll,
    pollIntervalMs: parseInt(opts['poll-interval'] as string || '30000', 10),
    concurrency: Math.max(1, parseInt(opts['concurrency'] as string || '1', 10) || 1),
    verbose: opts['verbose'] === true,
    projectRoot: PROJECT_ROOT,
    smokeTest: opts['smoke-test'] === true,
  };
}

// ---------------------------------------------------------------------------
// Shutdown coordination
// ---------------------------------------------------------------------------

let shuttingDown = false;
const activeJobIds = new Set<number>();
const jobStartTimes = new Map<number, { start: number; type: string }>(); // jobId -> start timestamp + type

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    console.log(`[worker] Received ${sig}, finishing ${activeJobIds.size} in-flight job(s) and shutting down...`);
    shuttingDown = true;
    // If idle (no jobs in flight), exit immediately
    if (activeJobIds.size === 0) {
      cleanup()
        .then(() => process.exit(0))
        .catch(() => process.exit(0));
    }
    // Otherwise, the main loop will exit after in-flight jobs complete
  });
}

// ---------------------------------------------------------------------------
// Health endpoint (K8s liveness/readiness probes)
// ---------------------------------------------------------------------------

let lastJobCompletedAt = Date.now();
let totalProcessed = 0;
let totalFailed = 0;
const startedAt = Date.now();
let healthServer: Server | null = null;

function startHealthServer(): void {
  const healthPort = parseInt(process.env.WORKER_HEALTH_PORT ?? '3101', 10);

  healthServer = createServer((req, res) => {
    if (req.url === '/healthz' || req.url === '/health') {
      const now = Date.now();
      // Stuck if any in-flight job has run past its own handler timeout (+grace),
      // so a legitimately long job like backfill-sources isn't restarted mid-run.
      let isStuck = false;
      for (const [, { start, type }] of jobStartTimes) {
        if (now - start > handlerTimeoutMs(type) + STUCK_GRACE_MS) { isStuck = true; break; }
      }
      const status = shuttingDown ? 'shutting_down' : isStuck ? 'stuck' : 'ok';
      const statusCode = (status === 'ok') ? 200 : 503;

      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status,
        shuttingDown,
        jobsInFlight: activeJobIds.size,
        totalProcessed,
        totalFailed,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        rssMb: Math.floor(process.memoryUsage().rss / 1024 / 1024),
        lastCompletedAgoMs: Date.now() - lastJobCompletedAt,
      }));
    } else if (req.url === '/readyz') {
      // Readiness: not ready if shutting down (stop sending new traffic)
      const code = shuttingDown ? 503 : 200;
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ready: !shuttingDown }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  healthServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[worker] Health port ${healthPort} already in use, continuing without health endpoint`);
      healthServer = null;
    } else {
      console.error(`[worker] Health server error: ${err.message}`);
      healthServer = null;
    }
  });

  healthServer.listen(healthPort, () => {
    console.log(`[worker] Health endpoint listening on port ${healthPort}`);
  });

  // Don't let the health server prevent process exit
  healthServer.unref();
}

// ---------------------------------------------------------------------------
// Active agent registration + heartbeat
// ---------------------------------------------------------------------------

let agentId: number | null = null;
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

async function registerAgent(workerId: string, types: string[]): Promise<void> {
  const typeDesc = types.length > 0 ? types.join(', ') : 'all';
  // typed-client-ok: QUA-770 baseline — worker control plane, internal endpoint
  const result = await apiRequest<{ id: number }>('POST', '/api/active-agents', {
    sessionId: workerId,
    task: `Job worker (types: ${typeDesc})`,
    model: 'job-worker-daemon',
  });

  if (result.ok) {
    agentId = result.data.id;
    console.log(`[worker] Registered as active agent: ${agentId}`);
  } else {
    console.warn(`[worker] Failed to register as active agent: ${result.message}`);
  }
}

async function sendHeartbeat(metadata: Record<string, unknown>): Promise<void> {
  if (agentId == null) return;
  await apiRequest('POST', `/api/active-agents/${agentId}/heartbeat`, {
    currentStep: metadata.currentStep,
    metadata,
  }).catch((e: unknown) => {
    // Best-effort: heartbeat failures are expected during connectivity blips
    console.warn(`[worker] Heartbeat failed: ${e instanceof Error ? e.message : String(e)}`);
  });
}

function startHeartbeat(): void {
  heartbeatInterval = setInterval(() => {
    const jobIds = [...activeJobIds];
    sendHeartbeat({
      currentStep: jobIds.length > 0 ? `Processing ${jobIds.length} job(s): #${jobIds.join(', #')}` : 'Polling for jobs',
      jobsInFlight: jobIds.length,
      totalProcessed,
      totalFailed,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      rssMb: Math.floor(process.memoryUsage().rss / 1024 / 1024),
    }).catch(() => {
      // Intentionally quiet: interval callback errors must not propagate
    });
  }, 60_000);

  // Don't let the heartbeat interval prevent process exit
  heartbeatInterval.unref();
}

// ---------------------------------------------------------------------------
// Memory watchdog
// ---------------------------------------------------------------------------

const DEFAULT_HANDLER_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

// Per-type overrides for handlers that legitimately run long. The handler's own
// child-process timeout fires slightly earlier and kills the child; this is the
// worker-side backstop.
const HANDLER_TIMEOUT_OVERRIDES_MS: Record<string, number> = {
  'backfill-sources': 3 * 60 * 60 * 1000 + 5 * 60 * 1000, // 3h5m (child killed at 3h)
};

function handlerTimeoutMs(jobType: string): number {
  return HANDLER_TIMEOUT_OVERRIDES_MS[jobType] ?? DEFAULT_HANDLER_TIMEOUT_MS;
}

// Grace above the handler timeout before the watchdog flags a job "stuck",
// so the handler's own timeout fires first on a real hang.
const STUCK_GRACE_MS = 5 * 60 * 1000; // 5 minutes

// The idle poll loop runs every few seconds; logging "claiming / no jobs /
// waiting" each time floods the logs. Throttle that heartbeat to one line per
// interval so verbose logs still show real job activity without the noise.
const IDLE_LOG_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
let lastIdleLogAt = 0;
function logIdleHeartbeat(msg: string, verbose: boolean): void {
  if (!verbose) return;
  const now = Date.now();
  if (now - lastIdleLogAt < IDLE_LOG_INTERVAL_MS) return;
  lastIdleLogAt = now;
  console.log(msg);
}

const MAX_RSS_MB = parseInt(process.env.WORKER_MAX_RSS_MB ?? '768', 10);

function checkMemory(): boolean {
  const rssMb = process.memoryUsage().rss / 1024 / 1024;
  if (rssMb > MAX_RSS_MB) {
    console.warn(`[worker] Memory usage ${rssMb.toFixed(0)}MB exceeds ${MAX_RSS_MB}MB limit, shutting down for restart`);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Resilient job result reporting
// ---------------------------------------------------------------------------

async function reportJobResult(
  jobId: number,
  success: boolean,
  data: Record<string, unknown> | null,
  error?: string,
): Promise<void> {
  const maxAttempts = 3;
  const delays = [5_000, 15_000, 30_000];

  // Extract cost from handler result data (handlers may use either field name)
  const costUsd = data != null
    ? (typeof data.costUsd === 'number' ? data.costUsd
      : typeof data.estimatedCostUsd === 'number' ? data.estimatedCostUsd
      : undefined)
    : undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const result = success
        ? await completeJob(jobId, data, costUsd)
        : await failJob(jobId, error ?? 'Unknown error');

      if (result.ok) return;

      console.error(
        `[worker] Failed to report job #${jobId} result (attempt ${attempt + 1}/${maxAttempts}): ${result.message}`,
      );
    } catch (err: unknown) {
      console.error(
        `[worker] Exception reporting job #${jobId} result (attempt ${attempt + 1}/${maxAttempts}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (attempt < maxAttempts - 1) {
      await new Promise(resolve => setTimeout(resolve, delays[attempt]));
    }
  }

  console.error(
    `[worker] CRITICAL: Could not report result for job #${jobId} after ${maxAttempts} attempts. Job may be orphaned.`,
  );
}

// ---------------------------------------------------------------------------
// Multi-type claim with client-side fallback
// ---------------------------------------------------------------------------

/**
 * Claim a job matching any of the given types. Uses the server's native
 * `types[]` array support (= ANY($2::text[])) for a single HTTP call.
 * When `types` is empty, claims any available job.
 */
async function claimWithTypes(
  workerId: string,
  types: string[],
): Promise<ApiResult<ClaimResult>> {
  if (types.length === 0) {
    return claimJob(workerId);
  }
  return claimJobWithTypes(workerId, types);
}

// ---------------------------------------------------------------------------
// Auto-sweep on idle
// ---------------------------------------------------------------------------

let lastSweepAt = 0;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

async function maybeSweep(verbose: boolean): Promise<void> {
  if (Date.now() - lastSweepAt < SWEEP_INTERVAL_MS) return;

  if (verbose) {
    console.log('[worker] Running periodic sweep of stale jobs...');
  }

  const result = await sweepJobs(60); // 60-minute timeout
  lastSweepAt = Date.now();

  if (result.ok) {
    const swept = result.data;
    if (swept.swept > 0) {
      console.log(`[worker] Sweep: reset ${swept.swept} stale jobs`);
    } else if (verbose) {
      console.log('[worker] Sweep: no stale jobs found');
    }
  } else {
    console.warn(`[worker] Sweep failed: ${result.message}`);
  }
}

// ---------------------------------------------------------------------------
// Poll backoff on consecutive failures
// ---------------------------------------------------------------------------

let consecutiveFailures = 0;
const MAX_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes

function getEffectivePollInterval(basePollMs: number): number {
  if (consecutiveFailures === 0) return basePollMs;
  return Math.min(basePollMs * Math.pow(2, consecutiveFailures), MAX_BACKOFF_MS);
}

// ---------------------------------------------------------------------------
// Smoke test
// ---------------------------------------------------------------------------

async function runSmokeTest(workerId: string): Promise<void> {
  console.log('[worker] Running smoke test...');

  // 1. Create a ping job
  const createResult = await createJob({ type: 'ping', params: { smokeTest: true } });
  if (!createResult.ok) {
    console.error(`[worker] Smoke test FAILED: could not create job: ${createResult.message}`);
    process.exit(1);
  }
  const jobId = createResult.data.id;
  console.log(`[worker] Smoke test: created job #${jobId}`);

  // 2. Claim it
  const claimResult = await claimJob(workerId, 'ping');
  if (!claimResult.ok || !claimResult.data.job) {
    console.error(`[worker] Smoke test FAILED: could not claim job: ${!claimResult.ok ? claimResult.message : 'no job available'}`);
    process.exit(1);
  }
  const claimedId = claimResult.data.job.id;
  console.log(`[worker] Smoke test: claimed job #${claimedId}`);

  // C2: Verify we claimed the correct job (queue interference detection)
  if (claimedId !== jobId) {
    console.error(`[worker] Smoke test FAILED: queue interference — expected job #${jobId}, got #${claimedId}`);
    await failJob(claimedId, 'Accidentally claimed by smoke test').catch((e) =>
      console.error(`[worker] Smoke test cleanup: failed to fail job #${claimedId}: ${e instanceof Error ? e.message : String(e)}`),
    );
    await cancelJob(jobId).catch((e) =>
      console.error(`[worker] Smoke test cleanup: failed to cancel job #${jobId}: ${e instanceof Error ? e.message : String(e)}`),
    );
    process.exit(1);
  }

  // 3. Start it
  const startResult = await startJob(claimedId);
  if (!startResult.ok) {
    console.error(`[worker] Smoke test FAILED: could not start job: ${startResult.message}`);
    process.exit(1);
  }

  // 4. Execute the ping handler
  const handler = getHandler('ping');
  if (!handler) {
    console.error('[worker] Smoke test FAILED: ping handler not registered');
    await failJob(claimedId, 'ping handler not registered').catch((e) =>
      console.error(`[worker] Smoke test cleanup: failed to fail job #${claimedId}: ${e instanceof Error ? e.message : String(e)}`),
    );
    process.exit(1);
  }

  let handlerResult;
  try {
    handlerResult = await handler(
      { smokeTest: true },
      { workerId, projectRoot: PROJECT_ROOT, verbose: false },
    );
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[worker] Smoke test FAILED: handler threw: ${error}`);
    await failJob(claimedId, `Smoke test handler exception: ${error}`).catch((e) =>
      console.error(`[worker] Smoke test cleanup: failed to fail job #${claimedId}: ${e instanceof Error ? e.message : String(e)}`),
    );
    process.exit(1);
  }

  if (!handlerResult.success) {
    console.error(`[worker] Smoke test FAILED: handler error: ${handlerResult.error}`);
    await failJob(claimedId, handlerResult.error ?? 'Handler returned failure').catch((e) =>
      console.error(`[worker] Smoke test cleanup: failed to fail job #${claimedId}: ${e instanceof Error ? e.message : String(e)}`),
    );
    process.exit(1);
  }

  // 5. Complete it
  const completeResult = await completeJob(claimedId, handlerResult.data);
  if (!completeResult.ok) {
    console.error(`[worker] Smoke test FAILED: could not complete job: ${completeResult.message}`);
    process.exit(1);
  }

  console.log('[worker] Smoke test PASSED');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Claim a job from the queue (does NOT process it)
// ---------------------------------------------------------------------------

interface ClaimedJob {
  id: number;
  type: string;
  params: Record<string, unknown>;
}

async function claimOneJob(config: WorkerConfig): Promise<'no_job' | 'error' | ClaimedJob> {
  const { workerId, types, verbose } = config;

  if (verbose) {
    const typeDesc = types.length > 0 ? types.join(', ') : 'any';
    logIdleHeartbeat(`[worker] Claiming job (types: ${typeDesc})...`, verbose);
  }

  const claimResult = await claimWithTypes(workerId, types);

  if (!claimResult.ok) {
    console.error(`[worker] Failed to claim job: ${claimResult.message}`);
    consecutiveFailures++;
    return 'error';
  }

  const claimed = claimResult.data.job;
  if (!claimed) {
    consecutiveFailures = 0;
    return 'no_job';
  }

  consecutiveFailures = 0;
  return {
    id: claimed.id,
    type: claimed.type,
    params: (claimed.params ?? {}) as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// Execute a claimed job (handler + result reporting)
// ---------------------------------------------------------------------------

async function executeJob(job: ClaimedJob, config: WorkerConfig): Promise<void> {
  const { workerId, verbose, projectRoot } = config;
  const { id: jobId, type: jobType, params: jobParams } = job;

  console.log(`[worker] Processing job #${jobId} (type: ${jobType})`);

  try {
    // Mark as running
    const startResult = await startJob(jobId);
    if (!startResult.ok) {
      console.error(`[worker] Failed to start job #${jobId}: ${startResult.message}`);
      totalFailed++;
      await reportJobResult(jobId, false, null, `Failed to start: ${startResult.message}`);
      return;
    }

    // Look up the handler
    const handler = getHandler(jobType);

    if (!handler) {
      const msg = `Unknown job type: ${jobType}. Known types: ${getRegisteredTypes().join(', ')}`;
      console.error(`[worker] ${msg}`);
      totalFailed++;
      await reportJobResult(jobId, false, null, msg);
      return;
    }

    // Execute the handler with timeout
    const context: JobHandlerContext = { workerId, projectRoot, verbose };
    let handlerTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutMs = handlerTimeoutMs(jobType);

    try {
      const result = await Promise.race([
        handler(jobParams, context),
        new Promise<never>((_, reject) => {
          handlerTimer = setTimeout(
            () => reject(new Error(`Handler timed out after ${timeoutMs / 1000}s`)),
            timeoutMs,
          );
        }),
      ]);

      if (result.success) {
        console.log(`[worker] Job #${jobId} completed successfully`);
        await reportJobResult(jobId, true, result.data);
      } else {
        console.error(`[worker] Job #${jobId} failed: ${result.error}`);
        totalFailed++;
        await reportJobResult(jobId, false, result.data, result.error ?? 'Handler returned success: false');
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[worker] Job #${jobId} threw exception: ${error}`);
      totalFailed++;
      await reportJobResult(jobId, false, null, error.slice(0, 500));
    } finally {
      // Always clear the timeout timer to prevent leaks when the handler
      // resolves before the timeout fires (especially with concurrency > 1)
      if (handlerTimer !== undefined) clearTimeout(handlerTimer);
    }
  } finally {
    activeJobIds.delete(jobId);
    jobStartTimes.delete(jobId);
    totalProcessed++;
    lastJobCompletedAt = Date.now();
  }
}

// ---------------------------------------------------------------------------
// Main worker loop
// ---------------------------------------------------------------------------

async function runWorker(config: WorkerConfig): Promise<void> {
  const typeDesc = config.types.length > 0 ? config.types.join(', ') : 'any';
  console.log(`[worker] Starting (id: ${config.workerId})`);
  console.log(`[worker] Type filter: ${typeDesc}`);
  console.log(`[worker] Max jobs: ${config.maxJobs === Infinity ? 'unlimited' : config.maxJobs}`);
  console.log(`[worker] Poll mode: ${config.poll}`);
  console.log(`[worker] Poll interval: ${config.pollIntervalMs}ms`);
  console.log(`[worker] Concurrency: ${config.concurrency}`);
  console.log(`[worker] Memory limit: ${MAX_RSS_MB}MB`);
  console.log(`[worker] Known handler types: ${getRegisteredTypes().join(', ')}`);

  // Fail-fast if --types contains anything not in the handler registry.
  // QUA-1041: a silent rename otherwise CrashLoops at deploy time instead of
  // piling up unconsumed jobs in prod (QUA-699 / QUA-1039 incident class).
  assertConfiguredTypesAreRegistered(config.types, getRegisteredTypes());

  // Start health server for K8s probes
  startHealthServer();

  // Register as active agent (best-effort)
  await registerAgent(config.workerId, config.types);
  startHeartbeat();

  let dispatched = 0; // Jobs claimed and dispatched (including in-flight)
  const inFlightSlots = new Set<Promise<void>>();

  while (!shuttingDown) {
    // Check if we've dispatched enough jobs — drain remaining and exit
    if (dispatched >= config.maxJobs) {
      break;
    }

    // Wait for a slot to open if at concurrency limit
    if (inFlightSlots.size >= config.concurrency) {
      await Promise.race(inFlightSlots);
      continue;
    }

    // Memory watchdog: stop claiming new jobs if memory is high
    if (checkMemory()) {
      console.log('[worker] Memory limit exceeded, draining in-flight jobs...');
      break;
    }

    // Try to claim a job
    const outcome = await claimOneJob(config);

    if (typeof outcome === 'object') {
      // C1: Track job immediately before async dispatch to close SIGTERM race window.
      // If SIGTERM arrives between claim and executeJob, the handler sees the job as in-flight.
      activeJobIds.add(outcome.id);
      jobStartTimes.set(outcome.id, { start: Date.now(), type: outcome.type });
      dispatched++;
      const slot = executeJob(outcome, config)
        .catch((err: unknown) => {
          // executeJob has its own try/finally, so this should never fire.
          // Safety net to prevent unhandled rejection from crashing the process.
          console.error(`[worker] Unexpected error in job #${outcome.id}: ${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => {
          inFlightSlots.delete(slot);
          console.log(`[worker] Completed ${totalProcessed}${config.maxJobs === Infinity ? '' : `/${config.maxJobs}`} jobs (${inFlightSlots.size} in-flight)`);
        });
      inFlightSlots.add(slot);

      // Small delay between claims to avoid hammering the server
      if (!shuttingDown && config.concurrency <= 1) {
        await new Promise(resolve => setTimeout(resolve, 1_000));
      } else if (!shuttingDown) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } else if (outcome === 'no_job') {
      if (!config.poll) {
        if (inFlightSlots.size === 0) break;
        await Promise.race(inFlightSlots);
        continue;
      }

      // Auto-sweep stale jobs during idle time (only if fully idle)
      if (inFlightSlots.size === 0) {
        await maybeSweep(config.verbose);
      }

      const interval = getEffectivePollInterval(config.pollIntervalMs);
      logIdleHeartbeat(`[worker] No jobs available, waiting ${interval}ms...`, config.verbose);

      // If we have in-flight jobs, race the poll interval against job completion
      if (inFlightSlots.size > 0) {
        let timer: ReturnType<typeof setTimeout>;
        await Promise.race([
          ...inFlightSlots,
          new Promise<void>(resolve => { timer = setTimeout(resolve, interval); }),
        ]);
        clearTimeout(timer!);
      } else {
        await new Promise(resolve => setTimeout(resolve, interval));
      }
    } else {
      // 'error' -- server issue
      if (!config.poll) {
        if (inFlightSlots.size === 0) break;
        await Promise.race(inFlightSlots);
        continue;
      }

      const interval = getEffectivePollInterval(config.pollIntervalMs);
      console.warn(
        `[worker] Claim failed (${consecutiveFailures} consecutive), backing off ${interval}ms...`,
      );
      await new Promise(resolve => setTimeout(resolve, interval));
    }
  }

  // Drain in-flight jobs before exiting
  if (inFlightSlots.size > 0) {
    console.log(`[worker] Draining ${inFlightSlots.size} in-flight job(s)...`);
    await Promise.all(inFlightSlots);
  }

  if (shuttingDown) {
    console.log(`[worker] Shutdown requested, exiting after processing ${totalProcessed} jobs`);
  } else {
    console.log(`[worker] Finished (processed ${totalProcessed} jobs)`);
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

let cleanupDone = false;

async function cleanup(): Promise<void> {
  if (cleanupDone) return;
  cleanupDone = true;

  // Clear heartbeat
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }

  // Deregister active agent (best-effort)
  if (agentId != null) {
    await apiRequest('PATCH', `/api/active-agents/${agentId}`, {
      status: 'completed',
    }).catch((e: unknown) => {
      // Best-effort: don't block shutdown, but log for diagnostics
      console.warn(`[worker] Failed to deregister agent: ${e instanceof Error ? e.message : String(e)}`);
    });
  }

  // Close health server (null-check: may have been cleared by EADDRINUSE handler)
  if (healthServer != null) {
    healthServer.close();
    healthServer = null;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const config = parseConfig();

if (config.smokeTest) {
  runSmokeTest(config.workerId).catch(err => {
    console.error(`[worker] Smoke test error: ${err}`);
    process.exit(1);
  });
} else {
  runWorker(config)
    .then(() => cleanup())
    .then(() => process.exit(0))
    .catch(err => {
      console.error(`[worker] Fatal error: ${err}`);
      cleanup()
        .then(() => process.exit(1))
        .catch(() => process.exit(1));
    });
}
