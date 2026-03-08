/**
 * PR Patrol — Watch Mode
 *
 * Live-refreshing terminal display of PR Patrol status.
 * Reads from local JSONL logs and state files + lightweight API calls
 * per cycle (deploy health, main branch CI). Does NOT re-scan GitHub PRs.
 *
 * Degrades to single-shot in non-TTY environments.
 */

import { existsSync } from 'fs';
import type { CommandOptions } from '../lib/command-types.ts';
import { getColors, type Colors } from '../lib/output.ts';
import {
  readAllEntries,
  filterByTime,
} from './log-reader.ts';
import {
  formatStatus,
  formatHealthSummary,
  type HealthSummary,
} from './format.ts';
import {
  JSONL_FILE,
  getMainRedSince,
  getMainFixAttempts,
  getPersistedClaimedPr,
} from './state.ts';
import { checkDeployHealth } from '../lib/pr-analysis/deploy-status.ts';
import { checkMainBranch as libCheckMainBranch } from '../lib/pr-analysis/index.ts';
import type { DeployHealthStatus } from '../lib/pr-analysis/deploy-status.ts';

const CLEAR_SCREEN = '\x1B[2J\x1B[H';
const DEFAULT_REPO = 'quantified-uncertainty/longterm-wiki';

export async function runWatchLoop(
  intervalSeconds: number,
  options: CommandOptions,
): Promise<void> {
  const isTTY = process.stdout.isTTY;
  const colors = getColors(options.ci as boolean | undefined);

  // If not a TTY, run once and exit (degrade gracefully)
  if (!isTTY) {
    const output = await buildWatchOutput(colors, options);
    process.stdout.write(output);
    return;
  }

  let shuttingDown = false;
  const shutdown = () => {
    shuttingDown = true;
    process.stdout.write('\n');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  while (!shuttingDown) {
    const output = await buildWatchOutput(colors, options);
    process.stdout.write(CLEAR_SCREEN);
    process.stdout.write(output);
    process.stdout.write(`\n${colors.dim}Refreshing every ${intervalSeconds}s. Press Ctrl+C to exit.${colors.reset}\n`);

    await new Promise((r) => setTimeout(r, intervalSeconds * 1000));
  }
}

async function buildWatchOutput(c: Colors, options: CommandOptions): Promise<string> {
  const parts: string[] = [];

  // Timestamp header
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  parts.push(`${c.bold}PR Patrol — Live Status${c.reset}  ${c.dim}${now}${c.reset}\n`);
  parts.push(`${c.dim}${'─'.repeat(50)}${c.reset}\n\n`);

  // Live health checks (both fail-open)
  let deployHealth: DeployHealthStatus = { healthy: true, lastDeploy: null, failingSince: null };
  let mainIsRed = false;
  try {
    deployHealth = await checkDeployHealth();
  } catch {
    // Fail-open — deploy health check is best-effort
  }
  try {
    const mainStatus = await libCheckMainBranch(DEFAULT_REPO);
    mainIsRed = mainStatus.isRed;
  } catch {
    // Fail-open — fall back to persisted state
    mainIsRed = !!getMainRedSince();
  }

  // Gather cycle info from recent JSONL
  const entries = existsSync(JSONL_FILE) ? readAllEntries(JSONL_FILE) : [];
  const recentCycles = filterByTime(entries, '1h')
    .filter((e) => e.type === 'cycle_summary');
  const lastCycle = recentCycles[recentCycles.length - 1];

  const claimedPr = getPersistedClaimedPr();
  const mainRedSince = getMainRedSince();
  const health: HealthSummary = {
    mainBranch: {
      isRed: mainIsRed,
      redSince: mainRedSince,
      fixAttempts: getMainFixAttempts(),
      culprits: [], // Would need to parse from latest JSONL entry; kept simple for now
    },
    deploy: deployHealth,
    daemon: {
      state: claimedPr ? 'fixing' : 'idle',
      currentPr: claimedPr,
      cycleCount: recentCycles.length,
      lastCycleAt: lastCycle?.timestamp ?? null,
    },
  };
  parts.push(formatHealthSummary(health, c));

  // Recent activity
  const count = typeof options.count === 'number' ? options.count : 15;
  const recent = entries.slice(-count);
  if (recent.length > 0) {
    parts.push(formatStatus(recent, c));
  } else {
    parts.push(`${c.dim}No PR Patrol logs found.${c.reset}\n`);
  }

  return parts.join('');
}
