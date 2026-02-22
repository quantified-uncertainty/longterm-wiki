/**
 * Jobs Command Handlers
 *
 * Manage background job queue: create, list, status, cancel, retry, sweep, ping.
 *
 * Usage:
 *   crux jobs                                     List recent jobs
 *   crux jobs list [--status=X] [--type=X]        List jobs with filters
 *   crux jobs create <type> [--params='{}']       Create a job
 *   crux jobs status <id>                         Show single job details
 *   crux jobs cancel <id>                         Cancel a pending/claimed job
 *   crux jobs retry <id>                          Reset a failed job to pending
 *   crux jobs sweep                               Trigger stale job cleanup
 *   crux jobs ping                                Create a ping job (smoke test)
 */

import { createLogger } from '../lib/output.ts';
import {
  createJob,
  createJobBatch,
  listJobs,
  getJob,
  cancelJob,
  sweepJobs,
  getJobStats,
  type JobEntry,
} from '../lib/wiki-server/jobs.ts';
import { apiRequest, type ApiResult } from '../lib/wiki-server/client.ts';
import { getRegisteredTypes } from '../lib/job-handlers/index.ts';
import { type CommandResult, parseIntOpt } from '../lib/cli.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CommandOptions {
  ci?: boolean;
  json?: boolean;
  status?: string;
  type?: string;
  params?: string;
  priority?: string;
  maxRetries?: string;
  limit?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTimestamp(ts: string | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function formatDuration(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt || !completedAt) return '—';
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

const STATUS_COLORS: Record<string, string> = {
  pending: '\x1b[90m',    // gray
  claimed: '\x1b[33m',    // yellow
  running: '\x1b[33m',    // yellow
  completed: '\x1b[32m',  // green
  failed: '\x1b[31m',     // red
  cancelled: '\x1b[90m',  // gray
};

function colorStatus(status: string): string {
  const color = STATUS_COLORS[status] || '';
  return `${color}${status}\x1b[0m`;
}

function formatJobRow(job: JobEntry): string {
  const id = String(job.id).padEnd(6);
  const type = job.type.padEnd(20);
  const status = colorStatus(job.status).padEnd(20); // padEnd accounts for escape codes approx
  const created = formatTimestamp(job.createdAt);
  const duration = formatDuration(job.startedAt, job.completedAt);
  const retries = job.retries > 0 ? ` [retry ${job.retries}/${job.maxRetries}]` : '';
  const error = job.error ? ` \x1b[31m${job.error.slice(0, 50)}\x1b[0m` : '';

  return `  ${id} ${type} ${status} ${created}  ${duration}${retries}${error}`;
}

function handleApiError(result: { ok: false; error: string; message: string }, c: Record<string, string>): CommandResult {
  if (result.error === 'unavailable') {
    return {
      output: `${c.red}Error: Wiki server not available.${c.reset}\n${c.dim}Ensure LONGTERMWIKI_SERVER_URL is set and the server is running.${c.reset}\n`,
      exitCode: 1,
    };
  }
  return {
    output: `${c.red}Error: ${result.message}${c.reset}\n`,
    exitCode: 1,
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * List jobs with optional filters.
 */
async function list(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  const limit = parseIntOpt(options.limit, 50);

  const result = await listJobs({
    status: options.status,
    type: options.type,
    limit,
  });

  if (!result.ok) return handleApiError(result, c);

  const { entries, total } = result.data;

  if (options.json) {
    return { output: JSON.stringify(result.data, null, 2), exitCode: 0 };
  }

  let output = '';
  output += `${c.bold}${c.blue}Jobs (${total} total)${c.reset}\n`;
  if (options.status) output += `${c.dim}Filter: status=${options.status}${c.reset}\n`;
  if (options.type) output += `${c.dim}Filter: type=${options.type}${c.reset}\n`;
  output += '\n';

  if (entries.length === 0) {
    output += `${c.dim}No jobs found matching filters.${c.reset}\n`;
  } else {
    output += `${c.dim}  ${'ID'.padEnd(6)} ${'Type'.padEnd(20)} ${'Status'.padEnd(12)} ${'Created'.padEnd(22)} Duration${c.reset}\n`;
    for (const job of entries) {
      output += `${formatJobRow(job)}\n`;
    }
    if (total > entries.length) {
      output += `\n${c.dim}...and ${total - entries.length} more. Use --limit=N to see more.${c.reset}\n`;
    }
  }

  return { output, exitCode: 0 };
}

/**
 * Create a new job.
 */
async function create(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  const type = args[0];
  if (!type) {
    return {
      output: `${c.red}Usage: crux jobs create <type> [--params='{}'] [--priority=N]${c.reset}\n`,
      exitCode: 1,
    };
  }

  let params: Record<string, unknown> | null = null;
  if (options.params) {
    try {
      params = JSON.parse(options.params as string);
    } catch {
      return {
        output: `${c.red}Error: --params must be valid JSON${c.reset}\n`,
        exitCode: 1,
      };
    }
  }

  const priority = options.priority ? parseInt(options.priority as string, 10) : 0;
  const maxRetries = options.maxRetries ? parseInt(options.maxRetries as string, 10) : 3;

  const result = await createJob({ type, params, priority, maxRetries });

  if (!result.ok) return handleApiError(result, c);

  const job = result.data;
  let output = '';
  output += `${c.green}✓${c.reset} Created job #${job.id}\n`;
  output += `  Type: ${c.bold}${job.type}${c.reset}\n`;
  output += `  Priority: ${job.priority}\n`;
  if (params) output += `  Params: ${JSON.stringify(params)}\n`;

  if (options.json) {
    return { output: JSON.stringify(job, null, 2), exitCode: 0 };
  }

  return { output, exitCode: 0 };
}

/**
 * Show single job details.
 */
async function status(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  const id = parseInt(args[0], 10);
  if (!id || isNaN(id)) {
    return {
      output: `${c.red}Usage: crux jobs status <id>${c.reset}\n`,
      exitCode: 1,
    };
  }

  const result = await getJob(id);

  if (!result.ok) return handleApiError(result, c);

  const job = result.data;

  if (options.json) {
    return { output: JSON.stringify(job, null, 2), exitCode: 0 };
  }

  let output = '';
  output += `${c.bold}Job #${job.id}${c.reset}\n\n`;
  output += `  Type:       ${c.bold}${job.type}${c.reset}\n`;
  output += `  Status:     ${colorStatus(job.status)}\n`;
  output += `  Priority:   ${job.priority}\n`;
  output += `  Retries:    ${job.retries} / ${job.maxRetries}\n`;
  output += `  Worker:     ${job.workerId ?? '—'}\n`;
  output += `  Created:    ${formatTimestamp(job.createdAt)}\n`;
  output += `  Claimed:    ${formatTimestamp(job.claimedAt)}\n`;
  output += `  Started:    ${formatTimestamp(job.startedAt)}\n`;
  output += `  Completed:  ${formatTimestamp(job.completedAt)}\n`;
  output += `  Duration:   ${formatDuration(job.startedAt, job.completedAt)}\n`;

  if (job.params) {
    output += `\n  ${c.bold}Params:${c.reset}\n`;
    output += `  ${JSON.stringify(job.params, null, 2).split('\n').join('\n  ')}\n`;
  }

  if (job.result) {
    output += `\n  ${c.bold}Result:${c.reset}\n`;
    output += `  ${JSON.stringify(job.result, null, 2).split('\n').join('\n  ')}\n`;
  }

  if (job.error) {
    output += `\n  ${c.red}${c.bold}Error:${c.reset}\n`;
    output += `  ${c.red}${job.error}${c.reset}\n`;
  }

  return { output, exitCode: 0 };
}

/**
 * Cancel a pending or claimed job.
 */
async function cancel(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  const id = parseInt(args[0], 10);
  if (!id || isNaN(id)) {
    return {
      output: `${c.red}Usage: crux jobs cancel <id>${c.reset}\n`,
      exitCode: 1,
    };
  }

  const result = await cancelJob(id);

  if (!result.ok) return handleApiError(result, c);

  return {
    output: `${c.green}✓${c.reset} Cancelled job #${id}\n`,
    exitCode: 0,
  };
}

/**
 * Retry a failed job (reset to pending).
 */
async function retry(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  const id = parseInt(args[0], 10);
  if (!id || isNaN(id)) {
    return {
      output: `${c.red}Usage: crux jobs retry <id>${c.reset}\n`,
      exitCode: 1,
    };
  }

  // Use a direct API request to reset to pending
  const result = await apiRequest<JobEntry>('POST', `/api/jobs/${id}/fail`, {
    error: 'Manual retry requested',
  });

  if (!result.ok) return handleApiError(result, c);

  return {
    output: `${c.green}✓${c.reset} Job #${id} reset to pending for retry\n`,
    exitCode: 0,
  };
}

/**
 * Trigger stale job cleanup.
 */
async function sweep(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  const result = await sweepJobs();

  if (!result.ok) return handleApiError(result, c);

  const { swept, jobs: sweptJobs } = result.data;

  if (options.json) {
    return { output: JSON.stringify(result.data, null, 2), exitCode: 0 };
  }

  let output = '';
  if (swept === 0) {
    output += `${c.green}✓${c.reset} No stale jobs found.\n`;
  } else {
    output += `${c.yellow}⚠${c.reset} Swept ${swept} stale job(s) back to pending:\n`;
    for (const job of sweptJobs) {
      output += `  #${job.id} (${job.type})\n`;
    }
  }

  return { output, exitCode: 0 };
}

/**
 * Create a ping job and poll until completion (smoke test).
 */
async function ping(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  // Create a ping job
  const createResult = await createJob({ type: 'ping', priority: 10 });

  if (!createResult.ok) return handleApiError(createResult, c);

  const jobId = createResult.data.id;
  let output = `${c.green}✓${c.reset} Created ping job #${jobId}\n`;
  output += `${c.dim}Waiting for completion...${c.reset}\n`;

  // Poll for completion (max 2 minutes)
  const MAX_POLLS = 24;
  const POLL_INTERVAL_MS = 5000;

  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    const statusResult = await getJob(jobId);
    if (!statusResult.ok) {
      output += `${c.red}Error polling job: ${statusResult.message}${c.reset}\n`;
      return { output, exitCode: 1 };
    }

    const job = statusResult.data;
    if (job.status === 'completed') {
      output += `${c.green}✓${c.reset} Ping job #${jobId} completed successfully!\n`;
      output += `  Duration: ${formatDuration(job.startedAt, job.completedAt)}\n`;
      if (job.result) {
        output += `  Result: ${JSON.stringify(job.result)}\n`;
      }
      return { output, exitCode: 0 };
    }

    if (job.status === 'failed') {
      output += `${c.red}✗${c.reset} Ping job #${jobId} failed: ${job.error}\n`;
      return { output, exitCode: 1 };
    }

    output += `${c.dim}  [${i + 1}/${MAX_POLLS}] Status: ${job.status}${c.reset}\n`;
  }

  output += `${c.yellow}⚠${c.reset} Timed out waiting for ping job #${jobId} to complete.\n`;
  output += `${c.dim}The job may still be running. Check: crux jobs status ${jobId}${c.reset}\n`;
  return { output, exitCode: 1 };
}

/**
 * Show job statistics.
 */
async function stats(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  const result = await getJobStats();

  if (!result.ok) return handleApiError(result, c);

  if (options.json) {
    return { output: JSON.stringify(result.data, null, 2), exitCode: 0 };
  }

  const { totalJobs, byType } = result.data;

  let output = '';
  output += `${c.bold}${c.blue}Job Statistics${c.reset}\n\n`;
  output += `  Total jobs: ${c.bold}${totalJobs}${c.reset}\n\n`;

  if (Object.keys(byType).length === 0) {
    output += `${c.dim}No jobs recorded yet.${c.reset}\n`;
  } else {
    for (const [type, info] of Object.entries(byType)) {
      output += `  ${c.bold}${type}${c.reset}\n`;
      for (const [status, cnt] of Object.entries(info.byStatus)) {
        output += `    ${colorStatus(status)}: ${cnt}\n`;
      }
      if (info.avgDurationMs !== undefined) {
        output += `    ${c.dim}Avg duration: ${info.avgDurationMs}ms${c.reset}\n`;
      }
      if (info.failureRate !== undefined) {
        output += `    ${c.dim}Failure rate: ${(info.failureRate * 100).toFixed(1)}%${c.reset}\n`;
      }
      output += '\n';
    }
  }

  return { output, exitCode: 0 };
}

/**
 * Submit a batch of page-improve or page-create jobs.
 *
 * Usage:
 *   crux jobs batch improve <pageId1> <pageId2> ... [--tier=standard] [--batch-id=X]
 *   crux jobs batch create "Title 1" "Title 2" ... [--tier=standard] [--batch-id=X]
 */
async function batch(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  const subcommand = args[0]; // 'improve' or 'create'
  const items = args.slice(1);

  if (!subcommand || !['improve', 'create'].includes(subcommand)) {
    return {
      output: `${c.red}Usage: crux jobs batch <improve|create> <item1> [item2...] [--tier=X] [--batch-id=X]${c.reset}\n`,
      exitCode: 1,
    };
  }

  if (items.length === 0) {
    return {
      output: `${c.red}Error: No items provided. Provide page IDs (improve) or titles (create).${c.reset}\n`,
      exitCode: 1,
    };
  }

  const tier = (options.tier as string) || (subcommand === 'improve' ? 'standard' : 'standard');
  const batchId = (options.batchId as string) || `batch-${Date.now().toString(36)}`;
  const prTitle = (options.prTitle as string) || `Batch ${subcommand}: ${items.length} pages`;

  let output = '';
  output += `${c.bold}Creating batch "${batchId}"${c.reset}\n`;
  output += `  Type: ${subcommand === 'improve' ? 'page-improve' : 'page-create'}\n`;
  output += `  Items: ${items.length}\n`;
  output += `  Tier: ${tier}\n\n`;

  // Create individual content jobs
  const jobInputs = items.map((item, i) => ({
    type: subcommand === 'improve' ? 'page-improve' : 'page-create',
    params: subcommand === 'improve'
      ? { pageId: item, tier, batchId, directions: options.directions as string || undefined }
      : { title: item, tier, batchId },
    priority: 5,
    maxRetries: 2,
  }));

  const childJobIds: number[] = [];
  const batchResult = await createJobBatch(jobInputs);

  if (batchResult.ok) {
    for (const job of batchResult.data) {
      childJobIds.push(job.id);
      output += `  ${c.green}✓${c.reset} Created job #${job.id} (${job.type})\n`;
    }
  } else {
    // Fall back to individual creation
    for (const input of jobInputs) {
      const singleResult = await createJob(input);
      if (singleResult.ok) {
        childJobIds.push(singleResult.data.id);
        output += `  ${c.green}✓${c.reset} Created job #${singleResult.data.id}\n`;
      } else {
        output += `  ${c.red}✗${c.reset} Failed to create job: ${singleResult.message}\n`;
      }
    }
  }

  if (childJobIds.length === 0) {
    output += `\n${c.red}Error: No jobs were created.${c.reset}\n`;
    return { output, exitCode: 1 };
  }

  // Create the batch-commit job
  const commitResult = await createJob({
    type: 'batch-commit',
    params: {
      batchId,
      childJobIds,
      prTitle,
      prLabels: ['batch'],
    },
    priority: 1,
    maxRetries: 5,
  });

  if (commitResult.ok) {
    output += `\n  ${c.green}✓${c.reset} Created batch-commit job #${commitResult.data.id}\n`;
  } else {
    output += `\n  ${c.yellow}⚠${c.reset} Failed to create batch-commit job: ${commitResult.message}\n`;
    output += `  You can create it manually:\n`;
    output += `  ${c.dim}crux jobs create batch-commit --params='${JSON.stringify({ batchId, childJobIds, prTitle })}'${c.reset}\n`;
  }

  output += `\n${c.bold}Batch "${batchId}" created with ${childJobIds.length} content jobs.${c.reset}\n`;
  output += `${c.dim}Jobs will be processed by workers. Monitor: crux jobs list --type=page-improve${c.reset}\n`;

  if (options.json) {
    return {
      output: JSON.stringify({ batchId, childJobIds, commitJobId: commitResult.ok ? commitResult.data.id : null }),
      exitCode: 0,
    };
  }

  return { output, exitCode: 0 };
}

/**
 * Run the worker inline (for local development/testing).
 *
 * Usage:
 *   crux jobs worker [--type=X] [--max-jobs=N] [--poll] [--verbose]
 */
async function worker(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  // Delegate to the worker runner script
  const { execFileSync } = await import('child_process');
  const { join } = await import('path');

  const workerArgs = [
    '--import', 'tsx/esm', '--no-warnings',
    join(import.meta.dirname ?? process.cwd(), '..', 'worker', 'run.ts'),
  ];

  if (options.type) workerArgs.push(`--type=${options.type}`);
  if (options.maxJobs) workerArgs.push(`--max-jobs=${options.maxJobs}`);
  if (options.poll) workerArgs.push('--poll');
  if (options.verbose) workerArgs.push('--verbose');
  if (options.pollInterval) workerArgs.push(`--poll-interval=${options.pollInterval}`);

  try {
    execFileSync('node', workerArgs, {
      cwd: join(import.meta.dirname ?? process.cwd(), '..'),
      stdio: 'inherit',
      timeout: 60 * 60 * 1000, // 1 hour max
    });

    return { output: '', exitCode: 0 };
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      output: `${c.red}Worker exited with error: ${error}${c.reset}\n`,
      exitCode: 1,
    };
  }
}

/**
 * Show registered job types.
 */
async function types(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;
  const registered = getRegisteredTypes();

  if (options.json) {
    return { output: JSON.stringify(registered), exitCode: 0 };
  }

  let output = `${c.bold}Registered Job Types${c.reset}\n\n`;
  for (const type of registered) {
    output += `  ${c.green}•${c.reset} ${type}\n`;
  }
  output += `\n${c.dim}${registered.length} types registered. Workers can handle these job types.${c.reset}\n`;

  return { output, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Command registry
// ---------------------------------------------------------------------------

export const commands = {
  default: list,
  list,
  create,
  status,
  cancel,
  retry,
  sweep,
  ping,
  stats,
  batch,
  worker,
  types,
};

export function getHelp(): string {
  return `
Jobs Domain - Background job queue management

Commands:
  list            List recent jobs (default)
  create <type>   Create a new job
  status <id>     Show single job details
  cancel <id>     Cancel a pending/claimed job
  retry <id>      Reset a failed job to pending
  sweep           Trigger stale job cleanup
  ping            Create a ping job and wait for completion (smoke test)
  stats           Show aggregate job statistics
  batch           Create a batch of content jobs with auto batch-commit
  worker          Run the job worker locally
  types           List registered job handler types

Options:
  --status=X      Filter by status (pending, claimed, running, completed, failed, cancelled)
  --type=X        Filter by job type
  --limit=N       Max jobs to show in list (default: 50)
  --params='{}'   JSON parameters for job creation
  --priority=N    Job priority (higher = more urgent, default: 0)
  --max-retries=N Max retry attempts (default: 3)
  --json          JSON output

Batch Options:
  --tier=X        Tier for content jobs (polish/standard/deep or budget/standard/premium)
  --batch-id=X    Custom batch identifier
  --pr-title=X    Custom PR title for batch commit
  --directions=X  Improvement directions (for batch improve)

Worker Options:
  --max-jobs=N    Max jobs to process (default: 1)
  --poll          Keep polling for new jobs
  --poll-interval=N  Polling interval in ms (default: 30000)
  --verbose       Verbose output

Job Types:
  ping              Smoke test (echoes worker info)
  page-improve      Run content improve pipeline on a page
  page-create       Run content create pipeline for a new page
  batch-commit      Collect completed job results and create a PR
  auto-update-digest  Run news digest and create page-improve jobs
  citation-verify   Verify citations on a page

Examples:
  crux jobs                                     List recent jobs
  crux jobs list --status=failed                List failed jobs
  crux jobs create page-improve --params='{"pageId":"ai-safety","tier":"polish"}'
                                                Create a page improve job
  crux jobs batch improve ai-safety miri --tier=polish
                                                Batch improve two pages
  crux jobs batch create "New Topic" "Another" --tier=budget
                                                Batch create two pages
  crux jobs create auto-update-digest --params='{"budget":30,"maxPages":5}'
                                                Trigger auto-update via jobs
  crux jobs worker --type=page-improve --verbose
                                                Run worker locally for page-improve jobs
  crux jobs types                               List registered job types
  crux jobs stats                               Show job statistics
`;
}
