/**
 * PR Patrol Command Handlers
 *
 * Continuous PR maintenance daemon — scans open PRs for issues,
 * scores them by priority, and spawns Claude CLI to fix the top one.
 *
 * Usage:
 *   crux pr-patrol run              Run the daemon (continuous)
 *   crux pr-patrol once             Single check cycle
 *   crux pr-patrol once --dry-run   Show what would be done
 *   crux pr-patrol status           Show recent patrol activity
 */

import type { CommandResult } from '../lib/cli.ts';
import { buildConfig, runDaemon, readRecentLogs } from '../pr-patrol/index.ts';

type CommandOptions = Record<string, unknown>;

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

export const commands = {
  run,
  once,
  status,
  default: run,
};

export function getHelp(): string {
  return `
PR Patrol Domain — Continuous PR maintenance daemon

Commands:
  run (default)    Run the PR patrol daemon (continuous)
  once             Single check cycle, then exit
  status           Show recent patrol activity

Options:
  --dry-run         Show what would be done, don't fix
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
  crux pr-patrol once --dry-run          Preview what would be fixed
  crux pr-patrol run --interval=120      Run with 2-minute cycles
  crux pr-patrol status                  Show recent activity
`.trim();
}
