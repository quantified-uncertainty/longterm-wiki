/**
 * Enrichment Command Handlers — QUA-643 Phase 4
 *
 * Sub-commands:
 *   crux enrichment sync-targets [--file=path] [--dry-run]
 *     Parses the QUA-634 denominator-estimates doc (or a --file path) and
 *     upserts rows into PG enrichment_targets via /api/enrichment/targets.
 *
 *   crux enrichment acceptance-report [--record-type=X] [--entity=slug]
 *                                     [--file-issues] [--threshold=0.30]
 *     Fetches /api/enrichment/coverage. Prints a per-(entity, record_type)
 *     gap table. With --file-issues, auto-files a Linear ticket for every
 *     (entity, record_type) whose gapPct >= --threshold so the burst can
 *     re-target those pairs in a later phase.
 *
 *   crux enrichment watchdog --run-id=X [--max-spend-per-hour=20]
 *                            [--window-minutes=30] [--discord-webhook=URL]
 *                            [--poll-seconds=30] [--oneshot]
 *     Polls /api/enrichment/runs for the given run-id. Computes the most
 *     recent $/hour spend rate over --window-minutes. If it exceeds the cap,
 *     writes a kill marker at ~/.cache/enrichment/kill-<runId> and fires a
 *     Discord alert (if webhook provided). Exits 0 on healthy, 2 on kill.
 *     With --oneshot, runs the check once and returns; otherwise loops until
 *     killed.
 *
 * The commands are thin CLIs around the /api/enrichment/{targets,coverage,runs}
 * endpoints — all orchestration logic is in `crux/lib/enrichment/*`.
 */

import type {
  CommandOptions as BaseOptions,
  CommandResult,
} from '../lib/command-types.ts';

interface CommandOptions extends BaseOptions {
  file?: string;
  recordType?: string;
  entity?: string;
  fileIssues?: boolean;
  threshold?: string;
  runId?: string;
  maxSpendPerHour?: string;
  windowMinutes?: string;
  discordWebhook?: string;
  pollSeconds?: string;
  oneshot?: boolean;
  project?: string;
  dryRun?: boolean;
  ci?: boolean;
}

async function syncTargetsCommand(
  _args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const { parseDenominatorDoc } = await import(
    '../lib/enrichment/parse-denominators.ts'
  );
  const { readFileSync, existsSync } = await import('fs');
  const { join } = await import('path');
  const { PROJECT_ROOT } = await import('../lib/content-types.ts');
  const { apiRequest } = await import('../lib/wiki-server/client.ts');

  const file =
    (options.file as string) ||
    join(PROJECT_ROOT, 'docs/audits/qua-634-denominator-estimates.md');
  if (!existsSync(file)) {
    return { exitCode: 1, output: `File not found: ${file}` };
  }

  const content = readFileSync(file, 'utf-8');
  const targets = parseDenominatorDoc(content);
  if (targets.length === 0) {
    return {
      exitCode: 1,
      output: `No rows parsed from ${file}. Is this the expected denominator-doc format?`,
    };
  }

  if (options.dryRun) {
    return {
      exitCode: 0,
      output: `[dry-run] Would upsert ${targets.length} targets from ${file}:\n${JSON.stringify(
        targets.slice(0, 3),
        null,
        2,
      )}\n... (${targets.length - 3} more)`,
    };
  }

  // Chunk — server max is 500 per request; we stay at 200 to keep each call
  // well under the wiki-server body-size limit.
  const chunks: typeof targets[] = [];
  for (let i = 0; i < targets.length; i += 200) {
    chunks.push(targets.slice(i, i + 200));
  }

  let total = 0;
  for (const chunk of chunks) {
    const res = await apiRequest<{ upserted: number }>(
      'POST',
      '/api/enrichment/targets',
      { targets: chunk },
    );
    if (!res.ok) {
      return {
        exitCode: 1,
        output: `POST /api/enrichment/targets failed: ${res.error}: ${res.message}`,
      };
    }
    total += res.data.upserted;
  }

  return {
    exitCode: 0,
    output: options.ci
      ? JSON.stringify({ upserted: total, source: file })
      : `✓ Upserted ${total} enrichment_targets rows from ${file}`,
  };
}

interface CoverageRow {
  entityId: string;
  recordType: string;
  estimatedTotal: number;
  targetPct: number;
  targetAcceptedCount: number;
  actualAcceptedCount: number;
  gapCount: number;
  gapPct: number;
  meetsTarget: boolean;
}

async function acceptanceReportCommand(
  _args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const { apiRequest } = await import('../lib/wiki-server/client.ts');

  const params = new URLSearchParams();
  if (options.recordType) params.set('recordType', options.recordType);
  if (options.entity) params.set('entityId', options.entity);
  const qs = params.toString();
  const path = `/api/enrichment/coverage${qs ? `?${qs}` : ''}`;

  const res = await apiRequest<{ coverage: CoverageRow[] }>('GET', path);
  if (!res.ok) {
    return {
      exitCode: 1,
      output: `GET ${path} failed: ${res.error}: ${res.message}`,
    };
  }
  const coverage = res.data.coverage;
  if (coverage.length === 0) {
    return {
      exitCode: 0,
      output:
        'No enrichment_targets populated. Run `crux enrichment sync-targets` first.',
    };
  }

  const threshold = options.threshold ? parseFloat(options.threshold) : 0.3;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    return {
      exitCode: 1,
      output: `--threshold must be between 0 and 1, got "${options.threshold}"`,
    };
  }

  const belowThreshold = coverage.filter((r) => r.gapPct >= threshold);

  if (options.ci) {
    return {
      exitCode: 0,
      output: JSON.stringify({
        total: coverage.length,
        meetingTarget: coverage.filter((r) => r.meetsTarget).length,
        belowThreshold: belowThreshold.length,
        threshold,
        rows: coverage,
      }),
    };
  }

  const lines: string[] = [];
  lines.push(`\n## Acceptance Report`);
  lines.push(`Targets: ${coverage.length}`);
  lines.push(
    `Meeting target: ${coverage.filter((r) => r.meetsTarget).length}`,
  );
  lines.push(
    `Below threshold (gapPct ≥ ${(threshold * 100).toFixed(0)}%): ${belowThreshold.length}`,
  );
  lines.push('');
  lines.push(
    '  entity                     record_type          actual/target  gap%',
  );
  lines.push(
    '  ' + '─'.repeat(76),
  );
  for (const r of coverage.slice(0, 50)) {
    const marker = r.meetsTarget ? '✓' : r.gapPct >= threshold ? '✗' : ' ';
    const ratio = `${r.actualAcceptedCount}/${r.targetAcceptedCount}`;
    const gap = `${(r.gapPct * 100).toFixed(0)}%`;
    lines.push(
      `${marker} ${r.entityId.padEnd(26)} ${r.recordType.padEnd(20)} ${ratio.padStart(13)}  ${gap.padStart(4)}`,
    );
  }
  if (coverage.length > 50) {
    lines.push(`  ... (${coverage.length - 50} more, use --ci for full JSON)`);
  }

  if (options.fileIssues && belowThreshold.length > 0) {
    const { fileAcceptanceIssues } = await import(
      '../lib/enrichment/acceptance-reopener.ts'
    );
    const project = options.project ?? 'Source-Check & Verification';
    const result = await fileAcceptanceIssues(belowThreshold, { project });
    lines.push('');
    lines.push(`Linear tickets filed: ${result.created}`);
    if (result.skipped > 0) {
      lines.push(
        `  skipped ${result.skipped} (existing ticket for same gap; rerun later to refile)`,
      );
    }
    if (result.errors.length > 0) {
      lines.push(`  errors: ${result.errors.length}`);
      for (const e of result.errors.slice(0, 3)) {
        lines.push(`    - ${e.entityId}/${e.recordType}: ${e.message}`);
      }
    }
  }

  return { exitCode: 0, output: lines.join('\n') };
}

async function watchdogCommand(
  _args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  if (!options.runId) {
    return {
      exitCode: 1,
      output: 'Usage: crux enrichment watchdog --run-id=<id> [--oneshot]',
    };
  }
  const { runWatchdog } = await import('../lib/enrichment/watchdog.ts');
  const cap = options.maxSpendPerHour
    ? parseFloat(options.maxSpendPerHour)
    : 20;
  const window = options.windowMinutes ? parseInt(options.windowMinutes, 10) : 30;
  const poll = options.pollSeconds ? parseInt(options.pollSeconds, 10) : 30;

  if (!Number.isFinite(cap) || cap <= 0) {
    return { exitCode: 1, output: `--max-spend-per-hour must be > 0, got "${options.maxSpendPerHour}"` };
  }
  if (!Number.isInteger(window) || window <= 0) {
    return { exitCode: 1, output: `--window-minutes must be a positive integer, got "${options.windowMinutes}"` };
  }
  if (!Number.isInteger(poll) || poll < 5) {
    return { exitCode: 1, output: `--poll-seconds must be ≥ 5, got "${options.pollSeconds}"` };
  }

  const result = await runWatchdog({
    runId: options.runId,
    maxSpendPerHour: cap,
    windowMinutes: window,
    pollSeconds: poll,
    discordWebhook: options.discordWebhook,
    oneshot: !!options.oneshot,
  });

  return {
    exitCode: result.killed ? 2 : 0,
    output: options.ci ? JSON.stringify(result) : result.summary,
  };
}

async function defaultCommand(): Promise<CommandResult> {
  return { exitCode: 0, output: getHelp() };
}

export const commands = {
  default: defaultCommand,
  'sync-targets': syncTargetsCommand,
  'acceptance-report': acceptanceReportCommand,
  watchdog: watchdogCommand,
};

export function getHelp(): string {
  return `
Enrichment Domain — QUA-637 defensive enrichment gate tooling

Commands:
  sync-targets          Seed enrichment_targets from QUA-634 denominator doc
  acceptance-report     Per-(entity, record_type) gap report; --file-issues to reopen
  watchdog              Spend-rate monitor; kills a run if it exceeds --max-spend-per-hour

Usage:
  crux enrichment sync-targets [--file=path] [--dry-run]
  crux enrichment acceptance-report [--record-type=X] [--entity=slug]
                                    [--file-issues] [--threshold=0.30]
                                    [--project="Source-Check & Verification"]
  crux enrichment watchdog --run-id=X
                           [--max-spend-per-hour=20] [--window-minutes=30]
                           [--poll-seconds=30] [--oneshot]
                           [--discord-webhook=URL]

Globals:
  --ci         JSON output for CI pipelines
`;
}
