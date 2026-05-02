/**
 * Health Monitor Command Handlers
 *
 * Coordinator-session degradation alarms (QUA-1048). Polls /health and
 * GitHub main-branch CI for two MVP signals:
 *   - ci-stale: last green main CI > threshold (default 2h)
 *   - jobs-stuck: pendingJobs queue not draining (default 15min trend)
 *
 * Usage:
 *   crux sys health-monitor run        Run the daemon (continuous)
 *   crux sys health-monitor once       Single check cycle
 *   crux sys health-monitor status     Show daemon state + active alerts
 *   crux sys health-monitor explain    Long-form explanation
 */

import type { CommandOptions, CommandResult } from '../lib/command-types.ts';
import { getColors } from '../lib/output.ts';
import {
  buildConfig,
  getDaemonStatus,
  runDaemon,
} from '../health-monitor/daemon.ts';
import type { DaemonConfig } from '../health-monitor/types.ts';

function parseSeconds(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string') {
    const n = parseInt(value, 10);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  return fallback;
}

function configFromOptions(options: CommandOptions, once = false): DaemonConfig {
  return buildConfig({
    pollIntervalSeconds: parseSeconds(options.interval, 60),
    ciCheckEveryNCycles: parseSeconds(options['ci-every'], 5),
    ciStaleThresholdSeconds: parseSeconds(options['ci-stale-seconds'], 2 * 60 * 60),
    jobsTrendWindowSeconds: parseSeconds(options['jobs-window-seconds'], 15 * 60),
    jobsTrendMinGrowthSeconds: parseSeconds(options['jobs-min-growth-seconds'], 12 * 60),
    once,
  });
}

async function run(_args: string[], options: CommandOptions): Promise<CommandResult> {
  await runDaemon(configFromOptions(options));
  return { output: '', exitCode: 0 };
}

async function once(_args: string[], options: CommandOptions): Promise<CommandResult> {
  await runDaemon(configFromOptions(options, true));
  return { output: '', exitCode: 0 };
}

async function status(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const c = getColors(Boolean(options.ci));
  const s = getDaemonStatus();

  if (options.json) {
    return { output: JSON.stringify(s, null, 2) + '\n', exitCode: 0 };
  }

  const lines: string[] = [];
  if (s.running && s.pid) {
    lines.push(`${c.green}✓${c.reset} health-monitor running (pid ${s.pid})`);
  } else {
    lines.push(`${c.red}✗${c.reset} health-monitor not running`);
  }
  lines.push(`  cache:           ${s.cacheDir}`);
  lines.push(`  recent samples:  ${s.recentSampleCount} (last 30 min)`);
  if (s.alerts.length === 0) {
    lines.push(`  alerts:          ${c.green}none${c.reset}`);
  } else {
    lines.push(`  alerts:          ${c.red}${s.alerts.length} active${c.reset}`);
    for (const a of s.alerts) {
      lines.push(`    ${c.red}⚠${c.reset} ${a.signal} — first seen ${formatSince(a.since)}`);
      for (const [k, v] of Object.entries(a.context)) {
        lines.push(`        ${k}: ${formatValue(v)}`);
      }
    }
  }
  return { output: lines.join('\n') + '\n', exitCode: 0 };
}

async function explain(_args: string[], _options: CommandOptions): Promise<CommandResult> {
  const out = `\
Health Monitor — Coordinator-session degradation alarms (QUA-1048)

Polls the wiki-server /health endpoint every minute and the GitHub
main-branch CI every five minutes. Two MVP signals:

  ci-stale     Last green CI on main > 2h ago.
               Threshold: --ci-stale-seconds (default 7200)

  jobs-stuck   pendingJobs > 0 with oldestPendingJobAgeSeconds growing
               for the trend window — likely DB / worker-loop issue.
               Window:  --jobs-window-seconds      (default 900)
               Growth:  --jobs-min-growth-seconds  (default 720)

When a signal is breached, the daemon writes
  ~/.cache/health-monitor/state/alert-<signal>
which scripts/inject-health-status.sh reads on every coord turn and
surfaces as a <system-reminder>. The alert file is removed when the
signal recovers.

Lifecycle is owned by launchd via com.qu.health-monitor.plist —
install with scripts/launchd/health-monitor.sh (sibling of the
pr-patrol installer).
`;
  return { output: out, exitCode: 0 };
}

function formatSince(iso: string): string {
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return iso;
  const ageS = Math.floor((Date.now() - ts) / 1000);
  if (ageS < 60) return `${ageS}s ago`;
  if (ageS < 3600) return `${Math.floor(ageS / 60)}m ago`;
  return `${(ageS / 3600).toFixed(1)}h ago`;
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return String(v);
  }
  return JSON.stringify(v);
}

export const commands = {
  run,
  once,
  status,
  explain,
  default: status,
};

export function getHelp(): string {
  return `\
Health Monitor — Coordinator-session degradation daemon (QUA-1048)

Commands:
  run                              Run the daemon continuously
  once                             Single check cycle then exit
  status (default)                 Show daemon state + active alerts
  explain                          Long-form explanation

Options for run/once:
  --interval=N                     Seconds between /health polls (default 60)
  --ci-every=N                     Check CI every N cycles (default 5)
  --ci-stale-seconds=N             ci-stale threshold (default 7200)
  --jobs-window-seconds=N          jobs-stuck trend window (default 900)
  --jobs-min-growth-seconds=N      jobs-stuck minimum age growth (default 720)

Status options:
  --json                           Machine-readable output

Examples:
  crux sys health-monitor run                     Continuous daemon
  crux sys health-monitor once                    One cycle then exit
  crux sys health-monitor status                  Current state
  crux sys health-monitor status --json           Machine-readable
  crux sys health-monitor explain                 How it works
`;
}
