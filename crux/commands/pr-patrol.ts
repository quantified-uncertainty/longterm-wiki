/**
 * PR Patrol Command Handlers
 *
 * Continuous PR maintenance daemon — scans open PRs for issues,
 * scores them by priority, spawns Claude CLI to fix the top one,
 * and auto-merges PRs labeled `stage:approved` when clean.
 *
 * Usage:
 *   crux gh pr-patrol run              Run the daemon (continuous)
 *   crux gh pr-patrol once             Single check cycle
 *   crux gh pr-patrol once --dry-run   Show what would be done
 *   crux gh pr-patrol status           Show recent patrol activity
 *   crux gh pr-patrol history          Browse full log with filters
 *   crux gh pr-patrol stats            Aggregated metrics
 *   crux gh pr-patrol merge-status     Show merge-eligible PRs
 *   crux gh pr-patrol explain          What PR Patrol does
 */

import type { CommandOptions, CommandResult } from '../lib/command-types.ts';
import { LABELS } from '../lib/labels.ts';
import { getColors } from '../lib/output.ts';
import {
  buildConfig,
  runDaemon,
  fetchOpenPrs,
  findMergeCandidates,
  JSONL_FILE,
  getParallelState,
  getDaemonPid,
  stopDaemon,
} from '../pr-patrol/index.ts';
import {
  readAllEntries,
  filterByTime,
  filterByType,
  filterByPr,
  filterByOutcome,
  computeStats,
} from '../pr-patrol/log-reader.ts';
import {
  formatStatus,
  formatStats,
  formatExplain,
} from '../pr-patrol/format.ts';
import { runWatchLoop } from '../pr-patrol/watch.ts';
import { runBranchAgent, buildBranchAgentConfig } from '../pr-patrol/branch-agent.ts';
import { buildParallelConfig, runParallelDaemon } from '../pr-patrol/parallel.ts';
import { parseRequiredInt } from '../lib/cli.ts';

async function run(
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  await runDaemon(buildConfig(args, options));
  return { output: '', exitCode: 0 };
}

async function once(
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  await runDaemon(buildConfig(args, { ...options, once: true }));
  return { output: '', exitCode: 0 };
}

async function status(
  _args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  // Watch mode — live refresh
  if (options.watch) {
    if (options.json) {
      return { output: 'Error: --json is not supported with --watch\n', exitCode: 1 };
    }
    const rawInterval = typeof options.interval === 'number'
      ? options.interval
      : typeof options.interval === 'string'
        ? parseInt(options.interval, 10)
        : 10;
    const interval = Number.isNaN(rawInterval) || rawInterval < 1 ? 10 : rawInterval;
    await runWatchLoop(interval, options);
    return { output: '', exitCode: 0 };
  }

  const colors = getColors(options.ci as boolean | undefined);
  const count = typeof options.count === 'number' ? options.count : (typeof options.count === 'string' ? parseInt(options.count, 10) : 20);

  let entries = readAllEntries(JSONL_FILE);

  if (options.type) entries = filterByType(entries, options.type as string);
  if (options.pr) entries = filterByPr(entries, parseInt(options.pr as string, 10));

  const recent = entries.slice(-count);

  if (options.json) {
    return { output: JSON.stringify(recent, null, 2) + '\n', exitCode: 0 };
  }

  // Prepend parallel daemon status if running
  let daemonLine = '';
  const pState = getParallelState();
  if (pState) {
    const age = Math.floor((Date.now() - new Date(pState.lastHeartbeat).getTime()) / 1000);
    const isAlive = age < 600; // stale if no heartbeat in 10 min
    const statusIcon = isAlive ? (pState.status === 'dispatching' ? '\u2699\uFE0F' : '\u2705') : '\u274C';
    daemonLine = `${statusIcon} Parallel daemon: ${isAlive ? pState.status : 'STALLED'} (heartbeat ${age}s ago, cycle #${pState.cycleCount}, pid ${pState.pid})\n`;
    if (pState.dispatched > 0 || pState.fixed > 0 || pState.errors > 0) {
      daemonLine += `  Last cycle: ${pState.dispatched} dispatched, ${pState.fixed} fixed, ${pState.errors} errors\n`;
    }
    daemonLine += '\n';
  }

  return { output: daemonLine + formatStatus(recent, colors), exitCode: 0 };
}

async function history(
  _args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const colors = getColors(options.ci as boolean | undefined);
  const since = (options.since as string) ?? '24h';
  const count = typeof options.count === 'number' ? options.count : (typeof options.count === 'string' ? parseInt(options.count, 10) : 100);

  let entries = readAllEntries(JSONL_FILE);
  entries = filterByTime(entries, since);

  if (options.type) entries = filterByType(entries, options.type as string);
  if (options.pr) entries = filterByPr(entries, parseInt(options.pr as string, 10));
  if (options.outcome) entries = filterByOutcome(entries, options.outcome as string);

  const limited = entries.slice(-count);

  if (options.json) {
    return { output: JSON.stringify(limited, null, 2) + '\n', exitCode: 0 };
  }

  return { output: formatStatus(limited, colors), exitCode: 0 };
}

async function stats(
  _args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const colors = getColors(options.ci as boolean | undefined);
  const since = (options.since as string) ?? '7d';

  let entries = readAllEntries(JSONL_FILE);
  entries = filterByTime(entries, since);

  const aggregated = computeStats(entries);

  if (options.json) {
    // Convert Map to plain object for JSON serialization
    const jsonStats = {
      ...aggregated,
      prTouched: Object.fromEntries(aggregated.prTouched),
    };
    return { output: JSON.stringify(jsonStats, null, 2) + '\n', exitCode: 0 };
  }

  return { output: formatStats(aggregated, since, colors), exitCode: 0 };
}

async function explain(
  _args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const colors = getColors(options.ci as boolean | undefined);
  return { output: formatExplain(colors), exitCode: 0 };
}

async function branchAgent(
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const prArg = args[0];
  const prNumber = parseRequiredInt(prArg);
  if (!prNumber) {
    return {
      output: 'Error: branch-agent requires a PR number\n  Usage: crux gh pr-patrol branch-agent <PR#>\n',
      exitCode: 1,
    };
  }
  const config = buildBranchAgentConfig(prNumber, options);
  await runBranchAgent(config);
  return { output: '', exitCode: 0 };
}

async function parallel(
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const config = buildParallelConfig(args, options);
  await runParallelDaemon(config);
  return { output: '', exitCode: 0 };
}

async function mergeStatus(
  _args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const config = buildConfig([], options);
  const prs = await fetchOpenPrs(config);
  const candidates = findMergeCandidates(prs);

  if (candidates.length === 0) {
    return { output: `No PRs with \`${LABELS.STAGE_APPROVED}\` label found.\n`, exitCode: 0 };
  }

  const lines: string[] = [`PRs labeled \`${LABELS.STAGE_APPROVED}\`:\n`];
  for (const c of candidates) {
    let s: string;
    if (c.blockReasons.includes('in-merge-queue')) {
      s = '\u23F3 IN QUEUE';
    } else if (c.eligible) {
      s = '\u2713 ELIGIBLE';
    } else {
      s = `\u2717 BLOCKED (${c.blockReasons.join(', ')})`;
    }
    lines.push(`  PR #${c.number}: ${s} \u2014 ${c.title}`);
  }

  return { output: lines.join('\n') + '\n', exitCode: 0 };
}

async function stop(_args: string[], _options: CommandOptions): Promise<CommandResult> {
  const c = getColors();
  const pid = getDaemonPid();
  if (!pid) {
    return { exitCode: 0, output: `${c.dim}No patrol daemon running.${c.reset}` };
  }
  const stopped = stopDaemon();
  if (stopped) {
    return { exitCode: 0, output: `${c.green}✓${c.reset} Patrol daemon stopped (PID ${pid})` };
  }
  return { exitCode: 1, output: `${c.red}✗ Failed to stop daemon (PID ${pid})${c.reset}` };
}

export const commands = {
  run,
  once,
  stop,
  parallel,
  status,
  history,
  stats,
  explain,
  'merge-status': mergeStatus,
  'branch-agent': branchAgent,
  default: run,
};

export function getHelp(): string {
  return `
PR Patrol Domain — Continuous PR maintenance daemon

Commands:
  run (default)    Run the PR patrol daemon (continuous)
  stop             Stop a running patrol daemon
  once             Single check cycle, then exit
  parallel         Parallel patrol: dispatch fixes to agent slots concurrently
  branch-agent     Per-PR persistent agent (Phase 1): dedicate full attention to one PR
  status           Show recent patrol activity (colorized, filterable)
  history          Browse full log with time ranges and filters
  stats            Aggregated metrics and success rates
  explain          Detailed explanation of what PR Patrol does
  merge-status     Show PRs labeled ${LABELS.STAGE_APPROVED} and their eligibility

Branch Agent (phase 1 persistent watchdog):
  crux gh pr-patrol branch-agent <PR#>     Watch and fix a specific PR continuously
  crux gh pr-patrol branch-agent <PR#> --max-invocations=10   Cap at 10 fix sessions
  crux gh pr-patrol branch-agent <PR#> --timeout=15           15-min per session timeout

  The branch-agent dedicates full attention to one PR, running multiple short
  fix sessions with CI waits between them. Unlike the daemon (which fixes one PR
  per cycle), it doesn't compete for priority — useful for complex PRs that need
  several iterations to get right.

Branch Agent Options:
  --max-invocations=N  Max Claude sessions to run (default: 20)
  --timeout=N          Per-session timeout in minutes (default: 15)
  --max-turns=N        Max turns per session (default: 60)
  --ci-timeout=N       Max seconds to wait for CI (default: 900 = 15 min)
  --ci-poll=N          CI poll interval in seconds (default: 30)
  --dry-run            Show what would be done, don't fix
  --skip-perms         Add --dangerously-skip-permissions to Claude CLI

Parallel Patrol (dispatch fixes concurrently via worktrees):
  crux gh pr-patrol parallel                        Continuous daemon
  crux gh pr-patrol parallel --once                 Single cycle
  crux gh pr-patrol parallel --max-concurrent=5     Limit concurrency (default: 5)
  crux gh pr-patrol parallel --dry-run              Preview dispatch plan

  Creates temporary git worktrees for each fix — no agent slots needed.
  Shares cooldowns, failure tracking, and claim labels with the serial daemon.

Parallel Options:
  --max-concurrent=N   Max concurrent fixes (default: 5)
  --once               Single cycle, then exit
  --dry-run            Preview dispatch plan without fixing
  --interval=N         Seconds between cycles (default: 300)
  --model=MODEL        Claude model (default: sonnet)
  --skip-perms         Add --dangerously-skip-permissions to Claude CLI

Status Options:
  --watch          Live-refreshing display (clears and redraws every interval)
  --interval=N     Refresh interval in seconds for --watch (default: 10)
  --count=N        Number of entries to show (default: 20 for status, 100 for history)
  --type=TYPE      Filter by type: pr, merge, cycle, main, overlap, undraft
  --pr=N           Filter to a specific PR number
  --json           Output raw JSON for scripting

History Options:
  --count=N        Number of entries to show (default: 100)
  --type=TYPE      Filter by type: pr, merge, cycle, main, overlap, undraft
  --pr=N           Filter to a specific PR number
  --outcome=X      Filter by outcome: fixed, max-turns, timeout, error, enqueued, merged
  --since=DURATION Time window for history (default: 24h). Format: 1h, 6h, 24h, 7d, 30d
  --json           Output raw JSON for scripting

Stats Options:
  --since=DURATION Time window (default: 7d). Format: 1h, 6h, 24h, 7d, 30d
  --json           Output raw JSON for scripting

Daemon Options:
  --dry-run         Show what would be done, don't fix or merge
  --interval=N      Seconds between checks (default: 300)
  --max-turns=N     Max Claude turns per fix (default: 120)
  --timeout=N       Hard timeout in minutes per fix (default: 60)
  --input-token-cap=N
                    Inline kill if cumulative input_tokens exceed N (default: 50000, 0 disables)
  --cooldown=N      Skip recently-processed PRs for N seconds (default: 1800)
  --stale-hours=N   Hours before a PR is considered stale (default: 48)
  --model=MODEL     Claude model (default: sonnet)
  --skip-perms      Add --dangerously-skip-permissions to Claude CLI
  --verbose         Detailed output

Environment:
  PR_PATROL_INTERVAL              Seconds between checks
  PR_PATROL_MAX_TURNS             Max Claude turns per fix
  PR_PATROL_TIMEOUT_MINUTES       Hard timeout per fix in minutes (default: 60)
  PR_PATROL_INPUT_TOKEN_CAP       Inline kill if cumulative input_tokens exceed N (default: 50000, 0 disables)
  PR_PATROL_COOLDOWN              Cooldown per PR (seconds)
  PR_PATROL_STALE_HOURS           Hours before a PR is stale (default: 48)
  PR_PATROL_MODEL                 Claude model
  PR_PATROL_REPO                  GitHub repo (default: quantified-uncertainty/longterm-wiki)
  PR_PATROL_SKIP_PERMS            Set to "1" to skip permissions
  PR_PATROL_REFLECTION_INTERVAL   Reflect every N cycles (default: 10)

Examples:
  crux gh pr-patrol once --dry-run                 Preview what would be fixed/merged
  crux gh pr-patrol run --interval=120             Run with 2-minute cycles
  crux gh pr-patrol branch-agent 1234              Watch PR #1234 until fixed/merged
  crux gh pr-patrol branch-agent 1234 --dry-run    Preview what branch-agent would do
  crux gh pr-patrol status                         Show recent activity
  crux gh pr-patrol status --watch                 Live-refreshing dashboard
  crux gh pr-patrol status --watch --interval=5    Faster refresh
  crux gh pr-patrol status --pr=1234               Show activity for a specific PR
  crux gh pr-patrol history --since=7d             Browse last 7 days of logs
  crux gh pr-patrol stats --since=30d              Monthly performance stats
  crux gh pr-patrol explain                        How PR Patrol works
  crux gh pr-patrol merge-status                   Show merge-eligible PRs
  crux gh pr-patrol parallel --once --dry-run        Preview parallel dispatch plan
  crux gh pr-patrol parallel --once --max-concurrent=3  Single cycle, 3 concurrent
  crux gh pr-patrol parallel                            Continuous parallel daemon
`.trim();
}
