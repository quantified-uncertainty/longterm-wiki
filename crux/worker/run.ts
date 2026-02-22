/**
 * Job Worker Runner
 *
 * Standalone worker process that claims and executes jobs from the queue.
 * Designed to run both locally (CLI) and in GitHub Actions.
 *
 * Usage:
 *   node --import tsx/esm crux/worker/run.ts [options]
 *
 * Options:
 *   --type=<type>     Only claim jobs of this type
 *   --max-jobs=<n>    Max jobs to process before exiting (default: 1)
 *   --poll            Keep polling for jobs (instead of exit after max-jobs)
 *   --poll-interval=<ms>  Polling interval in ms (default: 30000)
 *   --verbose         Verbose output
 *   --worker-id=<id>  Custom worker ID (default: auto-generated)
 *
 * Environment:
 *   LONGTERMWIKI_SERVER_URL     — Wiki server URL (required)
 *   LONGTERMWIKI_SERVER_API_KEY — API key for authentication
 */

import { join } from 'path';
import { getHandler, isKnownType, getRegisteredTypes } from '../lib/job-handlers/index.ts';
import { claimJob, startJob, completeJob, failJob } from '../lib/wiki-server/jobs.ts';
import type { JobHandlerContext } from '../lib/job-handlers/types.ts';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface WorkerConfig {
  workerId: string;
  type?: string;
  maxJobs: number;
  poll: boolean;
  pollIntervalMs: number;
  verbose: boolean;
  projectRoot: string;
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

  return {
    workerId,
    type: opts['type'] as string | undefined,
    maxJobs: parseInt(opts['max-jobs'] as string || '1', 10),
    poll: opts['poll'] === true,
    pollIntervalMs: parseInt(opts['poll-interval'] as string || '30000', 10),
    verbose: opts['verbose'] === true,
    projectRoot: join(import.meta.dirname ?? process.cwd(), '..'),
  };
}

// ---------------------------------------------------------------------------
// Worker Loop
// ---------------------------------------------------------------------------

async function processOneJob(config: WorkerConfig): Promise<boolean> {
  const { workerId, type, verbose, projectRoot } = config;

  // Claim a job
  if (verbose) {
    console.log(`[worker] Claiming job (type: ${type ?? 'any'})...`);
  }

  const claimResult = await claimJob(workerId, type);

  if (!claimResult.ok) {
    console.error(`[worker] Failed to claim job: ${claimResult.message}`);
    return false;
  }

  const claimed = claimResult.data.job;
  if (!claimed) {
    if (verbose) {
      console.log('[worker] No pending jobs available');
    }
    return false;
  }

  const jobId = claimed.id;
  const jobType = claimed.type;
  const jobParams = (claimed.params ?? {}) as Record<string, unknown>;

  console.log(`[worker] Claimed job #${jobId} (type: ${jobType})`);

  // Mark as running — if this fails (e.g. job was cancelled), skip execution
  const startResult = await startJob(jobId);
  if (!startResult.ok) {
    console.error(`[worker] Failed to start job #${jobId}: ${startResult.message}`);
    return true; // Job was claimed but couldn't start — continue to next
  }

  // Look up the handler
  const handler = getHandler(jobType);

  if (!handler) {
    const msg = `Unknown job type: ${jobType}. Known types: ${getRegisteredTypes().join(', ')}`;
    console.error(`[worker] ${msg}`);
    await failJob(jobId, msg);
    return true; // Job was processed (failed), continue to next
  }

  // Execute the handler
  const context: JobHandlerContext = {
    workerId,
    projectRoot,
    verbose,
  };

  try {
    const result = await handler(jobParams, context);

    if (result.success) {
      console.log(`[worker] Job #${jobId} completed successfully`);
      await completeJob(jobId, result.data);
    } else {
      console.error(`[worker] Job #${jobId} failed: ${result.error}`);
      await failJob(jobId, result.error ?? 'Handler returned success: false');
    }
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[worker] Job #${jobId} threw exception: ${error}`);
    await failJob(jobId, error.slice(0, 500));
  }

  return true;
}

async function runWorker(config: WorkerConfig): Promise<void> {
  console.log(`[worker] Starting (id: ${config.workerId})`);
  console.log(`[worker] Type filter: ${config.type ?? 'any'}`);
  console.log(`[worker] Max jobs: ${config.maxJobs}`);
  console.log(`[worker] Poll mode: ${config.poll}`);
  console.log(`[worker] Known types: ${getRegisteredTypes().join(', ')}`);

  let processed = 0;

  while (processed < config.maxJobs || config.poll) {
    const didProcess = await processOneJob(config);

    if (didProcess) {
      processed++;
      console.log(`[worker] Processed ${processed}/${config.maxJobs} jobs`);

      if (!config.poll && processed >= config.maxJobs) {
        break;
      }
    }

    if (!didProcess && config.poll) {
      if (config.verbose) {
        console.log(`[worker] No jobs available, waiting ${config.pollIntervalMs}ms...`);
      }
      await new Promise(resolve => setTimeout(resolve, config.pollIntervalMs));
    } else if (!didProcess) {
      // No job available and not polling — exit
      break;
    }
  }

  console.log(`[worker] Finished (processed ${processed} jobs)`);
}

// ---------------------------------------------------------------------------
// Entry Point
// ---------------------------------------------------------------------------

const config = parseConfig();

// Validate configuration
if (config.type && !isKnownType(config.type)) {
  console.warn(`[worker] Warning: type "${config.type}" has no registered handler`);
  console.warn(`[worker] Known types: ${getRegisteredTypes().join(', ')}`);
}

runWorker(config).catch(err => {
  console.error(`[worker] Fatal error: ${err}`);
  process.exit(1);
});
