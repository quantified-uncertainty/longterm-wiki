/**
 * Cost — Claude Code spend reporting
 *
 * Wraps ccusage (https://github.com/ryoppippi/ccusage), which reads
 * ~/.claude/projects/*.jsonl directly and reports token + USD spend.
 *
 * Usage:
 *   crux sys cost report                       # daily summary, last 7 days
 *   crux sys cost report --by=session          # per-session ranking
 *   crux sys cost report --since=14d           # last 14 days
 *   crux sys cost report --by=session --json   # machine-readable
 *
 * "session" in ccusage's vocabulary = one project directory (= one slot for us).
 * For finer per-conversation breakdowns use `--by=session --breakdown`.
 */

import { spawn, spawnSync } from 'child_process';
import type { CommandOptions, CommandResult } from '../lib/command-types.ts';

interface CostOptions extends CommandOptions {
  by?: string;
  since?: string;
  until?: string;
  json?: boolean;
  breakdown?: boolean;
  all?: boolean;
  order?: string;
  ci?: boolean;
}

const VALID_BY = ['day', 'daily', 'session', 'week', 'weekly', 'month', 'monthly', 'block', 'blocks'] as const;
const VALID_ORDER = ['asc', 'desc'] as const;

export function normalizeBy(by: string | undefined): string {
  const v = (by ?? 'day').toLowerCase();
  switch (v) {
    case 'day':
    case 'daily':
      return 'daily';
    case 'session':
      return 'session';
    case 'week':
    case 'weekly':
      return 'weekly';
    case 'month':
    case 'monthly':
      return 'monthly';
    case 'block':
    case 'blocks':
      return 'blocks';
    default:
      throw new Error(`Invalid --by=${by}. Valid: ${VALID_BY.join(', ')}`);
  }
}

/**
 * Translate friendly period strings to ccusage's YYYYMMDD format.
 * Accepts: "7d", "14d", "30d", "1w", "2w", or a literal YYYYMMDD.
 *
 * Validates that YYYYMMDD passthrough is a real calendar date.
 */
export function resolveDate(input: string | undefined, now: Date = new Date()): string | undefined {
  if (!input) return undefined;
  const trimmed = input.trim();
  if (/^\d{8}$/.test(trimmed)) {
    const yyyy = parseInt(trimmed.slice(0, 4), 10);
    const mm = parseInt(trimmed.slice(4, 6), 10);
    const dd = parseInt(trimmed.slice(6, 8), 10);
    const d = new Date(yyyy, mm - 1, dd);
    if (d.getFullYear() !== yyyy || d.getMonth() !== mm - 1 || d.getDate() !== dd) {
      throw new Error(`Invalid date "${input}". YYYYMMDD must be a real calendar date.`);
    }
    return trimmed;
  }
  const m = trimmed.match(/^(\d+)([dw])$/i);
  if (!m) {
    throw new Error(`Invalid date "${input}". Use YYYYMMDD or Nd / Nw (e.g. 7d, 2w).`);
  }
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const days = unit === 'w' ? n * 7 : n;
  const d = new Date(now);
  d.setDate(d.getDate() - days);
  const yyyy = d.getFullYear().toString();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

export function validateOrder(order: string | undefined): string | undefined {
  if (order === undefined) return undefined;
  const v = order.toLowerCase();
  if (!(VALID_ORDER as readonly string[]).includes(v)) {
    throw new Error(`Invalid --order=${order}. Valid: ${VALID_ORDER.join(', ')}`);
  }
  return v;
}

/**
 * Build the ccusage argv from validated CostOptions.
 *
 * Pure function — no subprocess, no I/O. Exported for tests.
 */
export function buildCcusageArgs(options: CostOptions, now: Date = new Date()): string[] {
  const subcommand = normalizeBy(options.by);
  let since = resolveDate(options.since, now);
  const until = resolveDate(options.until, now);
  const order = validateOrder(options.order);

  // Default since=7d when no --since and no --all
  if (!since && !options.all) {
    since = resolveDate('7d', now);
  }

  const args: string[] = [subcommand];
  if (since) args.push('--since', since);
  if (until) args.push('--until', until);
  if (options.json) args.push('--json');
  if (options.breakdown) args.push('--breakdown');
  if (order) args.push('--order', order);
  // Sane default for session view: order desc (highest spend first)
  if (subcommand === 'session' && !order) args.push('--order', 'desc');

  return args;
}

/**
 * Run ccusage and stream its output to the parent process.
 * Resolves with the exit code; rejects only on spawn-launch failure
 * (binary missing, EACCES). Caller wraps to convert reject → exit code.
 */
function runCcusage(args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['ccusage', ...args], {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 0));
  });
}

/**
 * Run ccusage and capture its output (for --json post-processing or tests).
 */
function runCcusageCapture(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync('npx', ['ccusage', ...args], {
    encoding: 'utf-8',
    env: process.env,
  });
  if (result.error) {
    return {
      stdout: '',
      stderr: `Failed to spawn ccusage: ${result.error.message}\n`,
      exitCode: 127,
    };
  }
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 0,
  };
}

async function reportCommand(_args: string[], options: CostOptions): Promise<CommandResult> {
  let ccArgs: string[];
  try {
    ccArgs = buildCcusageArgs(options);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return { output: '', exitCode: 2 };
  }

  if (options.json) {
    const { stdout, stderr, exitCode } = runCcusageCapture(ccArgs);
    if (exitCode !== 0) {
      process.stderr.write(stderr);
      return { output: '', exitCode };
    }
    process.stdout.write(stdout);
    return { output: stdout, exitCode };
  }

  try {
    const exitCode = await runCcusage(ccArgs);
    return { output: '', exitCode };
  } catch (e) {
    process.stderr.write(`Failed to launch ccusage: ${(e as Error).message}\n`);
    return { output: '', exitCode: 127 };
  }
}

export const commands: Record<
  string,
  (args: string[], options: CommandOptions) => Promise<CommandResult>
> = {
  report: reportCommand,
  default: reportCommand,
};

export function getHelp(): string {
  return `
Cost — Claude Code spend reporting (wraps ccusage)

Reads ~/.claude/projects/*.jsonl and reports token usage + USD spend.

Commands:
  report   Show spend report (default)

Options:
  --by=<window>     daily (default), session, weekly, monthly, blocks
                      "session" = per project directory (= per slot)
                      "blocks"  = per 5-hour billing window
  --since=<period>  Filter from date. Accepts: 7d, 14d, 30d, 1w, or YYYYMMDD.
                      Default: 7d.
  --until=<period>  Filter until date. Same format as --since.
  --all             No --since filter (overrides default 7d)
  --breakdown       Show per-model cost breakdown
  --order=<dir>     desc (default for --by=session) or asc
  --json            Machine-readable JSON output
  --ci              CI-friendly output (no colors)

Examples:
  crux sys cost report                          # last 7 days, daily breakdown
  crux sys cost report --by=session             # rank slots by spend (last 7d)
  crux sys cost report --since=30d --by=day     # last 30 days
  crux sys cost report --by=session --json      # JSON for piping/dashboards
  crux sys cost report --by=blocks              # 5h billing-window view
`;
}
