/**
 * PR Patrol Command Handlers
 *
 * Continuous PR maintenance daemon — scans open PRs for issues,
 * scores them by priority, spawns Claude CLI to fix the top one,
 * and auto-merges PRs labeled `ready-to-merge` when clean.
 *
 * Usage:
 *   crux pr-patrol run              Run the daemon (continuous)
 *   crux pr-patrol once             Single check cycle
 *   crux pr-patrol once --dry-run   Show what would be done
 *   crux pr-patrol status           Show recent patrol activity
 *   crux pr-patrol merge-status     Show merge-eligible PRs
 */

import type { CommandOptions, CommandResult } from '../lib/command-types.ts';
import {
  buildConfig,
  runDaemon,
  readRecentLogs,
  fetchOpenPrs,
  findMergeCandidates,
} from '../pr-patrol/index.ts';

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
  _options: CommandOptions,
): Promise<CommandResult> {
  return { output: readRecentLogs(20), exitCode: 0 };
}

async function mergeStatus(
  _args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const config = buildConfig([], options);
  const prs = await fetchOpenPrs(config);
  const candidates = findMergeCandidates(prs);

  if (candidates.length === 0) {
    return { output: 'No PRs with `ready-to-merge` label found.\n', exitCode: 0 };
  }

  const lines: string[] = ['PRs labeled `ready-to-merge`:\n'];
  for (const c of candidates) {
    const status = c.eligible
      ? '✓ ELIGIBLE'
      : `✗ BLOCKED (${c.blockReasons.join(', ')})`;
    lines.push(`  PR #${c.number}: ${status} — ${c.title}`);
  }

  return { output: lines.join('\n') + '\n', exitCode: 0 };
}

export const commands = {
  run,
  once,
  status,
  'merge-status': mergeStatus,
  default: run,
};

export function getHelp(): string {
  return `
PR Patrol Domain — Continuous PR maintenance daemon

Commands:
  run (default)    Run the PR patrol daemon (continuous)
  once             Single check cycle, then exit
  status           Show recent patrol activity
  merge-status     Show PRs labeled ready-to-merge and their eligibility

Auto-Merge:
  PRs labeled \`ready-to-merge\` are automatically squash-merged when clean.
  Eligibility: CI green, no conflicts, no unresolved threads, no unchecked items.
  At most 1 PR is merged per cycle to allow CI to re-run on the updated main.

Options:
  --dry-run         Show what would be done, don't fix or merge
  --interval=N      Seconds between checks (default: 300)
  --max-turns=N     Max Claude turns per fix (default: 40)
  --timeout=N       Hard timeout in minutes per fix (default: 30)
  --cooldown=N      Skip recently-processed PRs for N seconds (default: 1800)
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
  crux pr-patrol merge-status            Show merge-eligible PRs
`.trim();
}
