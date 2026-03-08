/**
 * PR Patrol Command Handlers
 *
 * Continuous PR maintenance daemon — scans open PRs for issues,
 * scores them by priority, spawns Claude CLI to fix the top one,
 * and auto-merges PRs labeled `stage:approved` when clean.
 *
 * Usage:
 *   crux pr-patrol run              Run the daemon (continuous)
 *   crux pr-patrol once             Single check cycle
 *   crux pr-patrol once --dry-run   Show what would be done
 *   crux pr-patrol status           Show recent patrol activity
 *   crux pr-patrol history          Browse full log with filters
 *   crux pr-patrol stats            Aggregated metrics
 *   crux pr-patrol merge-status     Show merge-eligible PRs
 *   crux pr-patrol explain          What PR Patrol does
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
  const colors = getColors(options.ci as boolean | undefined);
  const count = typeof options.count === 'number' ? options.count : (typeof options.count === 'string' ? parseInt(options.count, 10) : 20);

  let entries = readAllEntries(JSONL_FILE);

  if (options.type) entries = filterByType(entries, options.type as string);
  if (options.pr) entries = filterByPr(entries, parseInt(options.pr as string, 10));

  const recent = entries.slice(-count);

  if (options.json) {
    return { output: JSON.stringify(recent, null, 2) + '\n', exitCode: 0 };
  }

  return { output: formatStatus(recent, colors), exitCode: 0 };
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

export const commands = {
  run,
  once,
  status,
  history,
  stats,
  explain,
  'merge-status': mergeStatus,
  default: run,
};

export function getHelp(): string {
  return `
PR Patrol Domain — Continuous PR maintenance daemon

Commands:
  run (default)    Run the PR patrol daemon (continuous)
  once             Single check cycle, then exit
  status           Show recent patrol activity (colorized, filterable)
  history          Browse full log with time ranges and filters
  stats            Aggregated metrics and success rates
  explain          Detailed explanation of what PR Patrol does
  merge-status     Show PRs labeled ${LABELS.STAGE_APPROVED} and their eligibility

Status/History Options:
  --count=N        Number of entries to show (default: 20 for status, 100 for history)
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
  --max-turns=N     Max Claude turns per fix (default: 40)
  --timeout=N       Hard timeout in minutes per fix (default: 30)
  --cooldown=N      Skip recently-processed PRs for N seconds (default: 1800)
  --stale-hours=N   Hours before a PR is considered stale (default: 48)
  --model=MODEL     Claude model (default: sonnet)
  --skip-perms      Add --dangerously-skip-permissions to Claude CLI
  --verbose         Detailed output

Environment:
  PR_PATROL_INTERVAL              Seconds between checks
  PR_PATROL_MAX_TURNS             Max Claude turns per fix
  PR_PATROL_TIMEOUT_MINUTES       Hard timeout per fix in minutes (default: 30)
  PR_PATROL_COOLDOWN              Cooldown per PR (seconds)
  PR_PATROL_STALE_HOURS           Hours before a PR is stale (default: 48)
  PR_PATROL_MODEL                 Claude model
  PR_PATROL_REPO                  GitHub repo (default: quantified-uncertainty/longterm-wiki)
  PR_PATROL_SKIP_PERMS            Set to "1" to skip permissions
  PR_PATROL_REFLECTION_INTERVAL   Reflect every N cycles (default: 10)

Examples:
  crux pr-patrol once --dry-run          Preview what would be fixed/merged
  crux pr-patrol run --interval=120      Run with 2-minute cycles
  crux pr-patrol status                  Show recent activity
  crux pr-patrol status --pr=1234        Show activity for a specific PR
  crux pr-patrol history --since=7d      Browse last 7 days of logs
  crux pr-patrol stats --since=30d       Monthly performance stats
  crux pr-patrol explain                 How PR Patrol works
  crux pr-patrol merge-status            Show merge-eligible PRs
`.trim();
}
