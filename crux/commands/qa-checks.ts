/**
 * QA Checks Command Handlers
 *
 * View and manage QA sweep coverage tracking data.
 *
 * Usage:
 *   crux qa-checks queue [--directory=X] [--limit=N]
 *   crux qa-checks coverage
 *   crux qa-checks record --url=... --result=... [--thing-id=...] [--sweep-id=...]
 *   crux qa-checks list [--directory=X] [--sweep-id=X]
 */

import type { CommandResult } from '../lib/command-types.ts';
import {
  getQaQueue,
  getQaCoverage,
  recordQaCheck,
  listQaChecks,
} from '../lib/wiki-server/qa-checks.ts';

interface CommandOptions {
  directory?: string;
  limit?: number;
  url?: string;
  result?: string;
  thingId?: string;
  sweepId?: string;
  checkType?: string;
  depth?: string;
  json?: boolean;
  offset?: number;
}

// ---------------------------------------------------------------------------
// queue — show staleness-ordered page queue
// ---------------------------------------------------------------------------

async function queue(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const res = await getQaQueue(options.directory, options.limit);
  if (!res.ok) {
    console.error(`Failed to fetch queue: ${res.message}`);
    return { success: false, message: res.message };
  }

  if (options.json) {
    console.log(JSON.stringify(res.data, null, 2));
    return { success: true };
  }

  const { pages } = res.data;
  if (pages.length === 0) {
    console.log('No pages in queue.');
    return { success: true };
  }

  console.log(`\n  QA Check Queue — ${pages.length} pages (least-recently-checked first)\n`);
  console.log('  %-40s %-15s %-20s %s', 'Page URL', 'Entity Type', 'Last Checked', 'Checks');
  console.log('  ' + '-'.repeat(90));

  for (const p of pages) {
    const lastChecked = p.lastChecked
      ? new Date(p.lastChecked).toISOString().slice(0, 10)
      : '\x1b[33mnever\x1b[0m';
    console.log(
      '  %-40s %-15s %-20s %d',
      p.pageUrl.slice(0, 40),
      p.entityType ?? '(index)',
      lastChecked,
      p.checkCount,
    );
  }
  console.log();

  return { success: true };
}

// ---------------------------------------------------------------------------
// coverage — per-directory coverage stats
// ---------------------------------------------------------------------------

async function coverage(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const res = await getQaCoverage();
  if (!res.ok) {
    console.error(`Failed to fetch coverage: ${res.message}`);
    return { success: false, message: res.message };
  }

  if (options.json) {
    console.log(JSON.stringify(res.data, null, 2));
    return { success: true };
  }

  const { directories } = res.data;
  if (directories.length === 0) {
    console.log('No coverage data yet. Run a QA sweep to start tracking.');
    return { success: true };
  }

  console.log('\n  QA Coverage by Directory\n');
  console.log('  %-20s %8s %8s %10s %s', 'Directory', 'Total', 'Checked', 'Coverage', 'Last Checked');
  console.log('  ' + '-'.repeat(75));

  for (const d of directories) {
    const bar = d.coveragePercent >= 80
      ? `\x1b[32m${d.coveragePercent}%\x1b[0m`
      : d.coveragePercent >= 40
        ? `\x1b[33m${d.coveragePercent}%\x1b[0m`
        : `\x1b[31m${d.coveragePercent}%\x1b[0m`;
    const lastChecked = d.lastChecked
      ? new Date(d.lastChecked).toISOString().slice(0, 10)
      : 'never';
    console.log(
      '  %-20s %8d %8d %10s %s',
      d.name,
      d.totalPages,
      d.checkedPages,
      bar,
      lastChecked,
    );
  }
  console.log();

  return { success: true };
}

// ---------------------------------------------------------------------------
// record — record a single check
// ---------------------------------------------------------------------------

async function record(_args: string[], options: CommandOptions): Promise<CommandResult> {
  if (!options.url) {
    console.error('--url is required');
    return { success: false, message: '--url is required' };
  }
  if (!options.result) {
    console.error('--result is required (clean | issues_found | error | 404)');
    return { success: false, message: '--result is required' };
  }

  const validResults = ['clean', 'issues_found', 'error', '404'] as const;
  if (!validResults.includes(options.result as typeof validResults[number])) {
    console.error(`Invalid --result: ${options.result}. Must be one of: ${validResults.join(', ')}`);
    return { success: false, message: `Invalid result: ${options.result}` };
  }

  const res = await recordQaCheck({
    pageUrl: options.url,
    result: options.result as 'clean' | 'issues_found' | 'error' | '404',
    thingId: options.thingId ?? null,
    sweepId: options.sweepId ?? null,
    checkType: (options.checkType as 'index' | 'detail' | 'cross-consistency') ?? 'detail',
    depth: (options.depth as 'quick' | 'standard' | 'deep' | 'exhaustive') ?? null,
    directory: options.directory ?? null,
  });

  if (!res.ok) {
    console.error(`Failed to record check: ${res.message}`);
    return { success: false, message: res.message };
  }

  console.log(`Recorded QA check for ${options.url} → ${options.result}`);
  return { success: true };
}

// ---------------------------------------------------------------------------
// list — list recent checks
// ---------------------------------------------------------------------------

async function list(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const res = await listQaChecks({
    directory: options.directory,
    sweepId: options.sweepId,
    limit: options.limit,
    offset: options.offset,
  });

  if (!res.ok) {
    console.error(`Failed to list checks: ${res.message}`);
    return { success: false, message: res.message };
  }

  if (options.json) {
    console.log(JSON.stringify(res.data, null, 2));
    return { success: true };
  }

  const { checks } = res.data;
  if (checks.length === 0) {
    console.log('No QA checks recorded yet.');
    return { success: true };
  }

  console.log(`\n  Recent QA Checks — ${checks.length} records\n`);
  console.log('  %-35s %-12s %-15s %-10s %s', 'Page URL', 'Result', 'Check Type', 'Depth', 'Checked At');
  console.log('  ' + '-'.repeat(90));

  for (const ch of checks) {
    const resultColor = ch.result === 'clean' ? '\x1b[32m' : ch.result === 'issues_found' ? '\x1b[33m' : '\x1b[31m';
    console.log(
      '  %-35s %s%-12s\x1b[0m %-15s %-10s %s',
      ch.pageUrl.slice(0, 35),
      resultColor,
      ch.result,
      ch.checkType,
      ch.depth ?? '-',
      new Date(ch.checkedAt).toISOString().slice(0, 16),
    );
  }
  console.log();

  return { success: true };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const commands = {
  queue,
  coverage,
  record,
  list,
  default: queue,
};

export function getHelp() {
  return `
QA Checks — Coverage tracking for QA sweeps

Commands:
  queue              Show staleness-ordered page queue (default)
  coverage           Per-directory coverage stats
  record             Record a single check result
  list               List recent checks

Options:
  --directory=X      Filter by directory name
  --limit=N          Max results (default: 20 for queue, 50 for list)
  --url=URL          Page URL to record (for record command)
  --result=RESULT    Check result: clean | issues_found | error | 404
  --thing-id=ID      Thing ID to associate (optional)
  --sweep-id=ID      Sweep ID to group checks (optional)
  --check-type=TYPE  Check type: index | detail | cross-consistency
  --depth=DEPTH      Sweep depth: quick | standard | deep | exhaustive
  --json             JSON output for scripting

Examples:
  crux qa-checks queue                          Show next pages to check
  crux qa-checks queue --directory=organizations --limit=10
  crux qa-checks coverage                       Coverage stats per directory
  crux qa-checks record --url=/organizations/anthropic --result=clean
  crux qa-checks list --sweep-id=sweep-2026-03-19-abc
`;
}
