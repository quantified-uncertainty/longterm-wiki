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
  listJobs,
  getJob,
  cancelJob,
  sweepJobs,
  getJobStats,
  type JobEntry,
} from '../lib/wiki-server/jobs.ts';
import { apiRequest, type ApiResult } from '../lib/wiki-server/client.ts';
import type { CommandResult } from '../lib/cli.ts';

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

  const limit = parseInt(options.limit as string || '50', 10);

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

Options:
  --status=X      Filter by status (pending, claimed, running, completed, failed, cancelled)
  --type=X        Filter by job type
  --limit=N       Max jobs to show in list (default: 50)
  --params='{}'   JSON parameters for job creation
  --priority=N    Job priority (higher = more urgent, default: 0)
  --max-retries=N Max retry attempts (default: 3)
  --json          JSON output

Examples:
  crux jobs                                     List recent jobs
  crux jobs list --status=failed                List failed jobs
  crux jobs list --type=citation-verify         List citation verify jobs
  crux jobs create ping                         Create a ping test job
  crux jobs create citation-verify --params='{"pageId":"ai-safety"}'
                                                Create a citation verify job
  crux jobs status 42                           Show details for job #42
  crux jobs cancel 42                           Cancel job #42
  crux jobs retry 42                            Retry failed job #42
  crux jobs sweep                               Clean up stale jobs
  crux jobs ping                                Smoke test: create ping + wait
  crux jobs stats                               Show job statistics
`;
}
