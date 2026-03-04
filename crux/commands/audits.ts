/**
 * Audits Command Handlers
 *
 * Manage system-level behavioral audits — ongoing properties we expect
 * to hold about the system, plus one-time post-merge verification items.
 *
 * Unlike CI tests, these are higher-level expectations that require
 * periodic human or agent review (e.g., "groundskeeper produces
 * substantive messages", "agent sessions are being logged").
 *
 * Usage:
 *   crux audits list [--pending] [--category=X] [--json]
 *   crux audits check <id> [--pass|--fail] [--notes="..."]
 *   crux audits run-auto
 *   crux audits report
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { parse as parseYaml } from 'yaml';
import type { CommandResult } from '../lib/cli.ts';
import { PROJECT_ROOT } from '../lib/content-types.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AuditItem {
  id: string;
  category: string;
  description: string;
  check_type: 'manual' | 'automated' | 'hybrid';
  check_command?: string;
  how_to_verify: string;
  frequency: 'daily' | 'weekly' | 'biweekly' | 'monthly';
  added: string;
  added_by_pr?: number;
  last_checked: string | null;
  last_result: 'pass' | 'fail' | null;
}

interface PostMergeItem {
  id: string;
  pr: number;
  merged: string;
  claim: string;
  how_to_verify: string;
  status: 'pending' | 'verified' | 'failed' | 'wontfix';
  deadline?: string;
  checked_date: string | null;
  notes: string | null;
}

interface AuditsFile {
  audits: AuditItem[];
  post_merge: PostMergeItem[];
}

interface CommandOptions {
  pending?: boolean;
  category?: string;
  json?: boolean;
  ci?: boolean;
  pass?: boolean;
  fail?: boolean;
  notes?: string;
  status?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

const AUDITS_PATH = join(PROJECT_ROOT, '.claude/audits.yaml');

function loadAudits(): AuditsFile {
  const raw = readFileSync(AUDITS_PATH, 'utf-8');
  const parsed = parseYaml(raw) as { audits?: AuditItem[]; post_merge?: PostMergeItem[] };
  return {
    audits: parsed.audits ?? [],
    post_merge: parsed.post_merge ?? [],
  };
}

/**
 * Save audits by doing targeted field updates in the original YAML
 * to preserve comments and formatting.
 */
function saveAudits(data: AuditsFile): void {
  let raw = readFileSync(AUDITS_PATH, 'utf-8');

  // Update each audit item's mutable fields
  for (const item of data.audits) {
    // Update last_checked
    const checkedPattern = new RegExp(
      `(- id: ${escapeRegex(item.id)}[\\s\\S]*?last_checked:)\\s*(?:"[^"]*"|null)`,
    );
    raw = raw.replace(checkedPattern, `$1 ${item.last_checked ? `"${item.last_checked}"` : 'null'}`);

    // Update last_result
    const resultPattern = new RegExp(
      `(- id: ${escapeRegex(item.id)}[\\s\\S]*?last_result:)\\s*(?:\\w+|null)`,
    );
    raw = raw.replace(resultPattern, `$1 ${item.last_result ?? 'null'}`);
  }

  // Update each post-merge item's mutable fields
  for (const pm of data.post_merge) {
    const statusPattern = new RegExp(
      `(- id: ${escapeRegex(pm.id)}[\\s\\S]*?status:)\\s*\\w+`,
    );
    raw = raw.replace(statusPattern, `$1 ${pm.status}`);

    const datePattern = new RegExp(
      `(- id: ${escapeRegex(pm.id)}[\\s\\S]*?checked_date:)\\s*(?:"[^"]*"|null)`,
    );
    raw = raw.replace(datePattern, `$1 ${pm.checked_date ? `"${pm.checked_date}"` : 'null'}`);

    const notesPattern = new RegExp(
      `(- id: ${escapeRegex(pm.id)}[\\s\\S]*?notes:)\\s*(?:"[^"]*"|null)`,
    );
    raw = raw.replace(notesPattern, `$1 ${pm.notes ? `"${pm.notes}"` : 'null'}`);
  }

  writeFileSync(AUDITS_PATH, raw, 'utf-8');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FREQUENCY_DAYS: Record<string, number> = {
  daily: 1,
  weekly: 7,
  biweekly: 14,
  monthly: 30,
};

function isOverdue(item: AuditItem): boolean {
  if (!item.last_checked) return true;
  const lastDate = new Date(item.last_checked);
  const now = new Date();
  const daysSince = (now.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24);
  return daysSince > (FREQUENCY_DAYS[item.frequency] ?? 30);
}

function daysUntilDue(item: AuditItem): number | null {
  if (!item.last_checked) return null; // never checked = overdue
  const lastDate = new Date(item.last_checked);
  const dueDate = new Date(lastDate.getTime() + (FREQUENCY_DAYS[item.frequency] ?? 30) * 24 * 60 * 60 * 1000);
  const now = new Date();
  return Math.ceil((dueDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

function formatStatus(item: AuditItem): string {
  if (!item.last_checked) return '\x1b[33m● never checked\x1b[0m';
  if (isOverdue(item)) return '\x1b[31m● overdue\x1b[0m';
  const days = daysUntilDue(item);
  if (days !== null && days <= 3) return `\x1b[33m● due in ${days}d\x1b[0m`;
  return `\x1b[32m● checked\x1b[0m (${item.last_result ?? 'no result'})`;
}

function today(): string {
  return new Date().toISOString().split('T')[0];
}

// ---------------------------------------------------------------------------
// list command
// ---------------------------------------------------------------------------

async function listCommand(
  _args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const data = loadAudits();
  let items = data.audits;

  // Filter by category
  if (options.category) {
    items = items.filter(i => i.category === options.category);
  }

  // Filter to pending/overdue only
  if (options.pending) {
    items = items.filter(i => isOverdue(i));
  }

  if (options.json || options.ci) {
    const result = {
      audits: items.map(i => ({
        ...i,
        overdue: isOverdue(i),
        days_until_due: daysUntilDue(i),
      })),
      post_merge: data.post_merge.filter(pm => pm.status === 'pending'),
    };
    return { exitCode: 0, output: JSON.stringify(result, null, 2) };
  }

  const lines: string[] = [];

  // Ongoing audits
  const overdueItems = items.filter(i => isOverdue(i));
  const okItems = items.filter(i => !isOverdue(i));

  if (overdueItems.length > 0) {
    lines.push('\x1b[1m\x1b[31mOverdue / Never Checked:\x1b[0m');
    for (const item of overdueItems) {
      lines.push(`  ${formatStatus(item)}  ${item.id}`);
      lines.push(`    \x1b[2m${item.description}\x1b[0m`);
      lines.push(`    \x1b[2m${item.category} · ${item.frequency} · ${item.check_type}\x1b[0m`);
    }
    lines.push('');
  }

  if (okItems.length > 0 && !options.pending) {
    lines.push('\x1b[1m\x1b[32mUp to Date:\x1b[0m');
    for (const item of okItems) {
      lines.push(`  ${formatStatus(item)}  ${item.id}`);
      lines.push(`    \x1b[2m${item.description}\x1b[0m`);
    }
    lines.push('');
  }

  // Post-merge items
  const pendingPM = data.post_merge.filter(pm => pm.status === 'pending');
  if (pendingPM.length > 0) {
    lines.push('\x1b[1mPending Post-Merge Verifications:\x1b[0m');
    for (const pm of pendingPM) {
      const deadlineStr = pm.deadline ? ` (deadline: ${pm.deadline})` : '';
      lines.push(`  \x1b[33m●\x1b[0m  ${pm.id} — PR #${pm.pr}${deadlineStr}`);
      lines.push(`    \x1b[2m${pm.claim}\x1b[0m`);
    }
    lines.push('');
  }

  // Summary
  const totalAudits = items.length;
  const totalOverdue = overdueItems.length;
  const totalPendingPM = pendingPM.length;
  lines.push(`\x1b[2m${totalAudits} audits (${totalOverdue} overdue), ${totalPendingPM} pending post-merge items\x1b[0m`);

  return { exitCode: 0, output: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// check command
// ---------------------------------------------------------------------------

async function checkCommand(
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const id = args.find(a => !a.startsWith('--'));

  if (!id) {
    return {
      exitCode: 1,
      output: `Usage: crux audits check <id> [--pass|--fail] [--notes="..."]

  Record the result of checking an audit item or post-merge verification.

Examples:
  crux audits check groundskeeper-health --pass --notes="Messages look substantive"
  crux audits check vercel-ignore-command-v2 --fail --notes="Still seeing PR deploys"
  crux audits check agent-sessions-logged --pass`,
    };
  }

  const data = loadAudits();

  // Check ongoing audits
  const auditIdx = data.audits.findIndex(a => a.id === id);
  if (auditIdx >= 0) {
    const result = options.pass ? 'pass' : options.fail ? 'fail' : null;
    if (!result) {
      return {
        exitCode: 1,
        output: 'Specify --pass or --fail to record the check result.',
      };
    }
    data.audits[auditIdx].last_checked = today();
    data.audits[auditIdx].last_result = result;
    saveAudits(data);

    const symbol = result === 'pass' ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    const notesStr = options.notes ? `\n  Notes: ${options.notes}` : '';
    return {
      exitCode: 0,
      output: `${symbol} Recorded ${result} for audit: ${id}${notesStr}`,
    };
  }

  // Check post-merge items
  const pmIdx = data.post_merge.findIndex(pm => pm.id === id);
  if (pmIdx >= 0) {
    const newStatus = options.status as PostMergeItem['status'] ??
      (options.pass ? 'verified' : options.fail ? 'failed' : null);
    if (!newStatus) {
      return {
        exitCode: 1,
        output: 'Specify --pass (verified), --fail (failed), or --status=<verified|failed|wontfix>.',
      };
    }
    data.post_merge[pmIdx].status = newStatus;
    data.post_merge[pmIdx].checked_date = today();
    if (options.notes) {
      data.post_merge[pmIdx].notes = options.notes as string;
    }
    saveAudits(data);

    return {
      exitCode: 0,
      output: `✓ Post-merge item ${id} marked as: ${newStatus}`,
    };
  }

  return {
    exitCode: 1,
    output: `No audit or post-merge item found with id: ${id}`,
  };
}

// ---------------------------------------------------------------------------
// run-auto command
// ---------------------------------------------------------------------------

async function runAutoCommand(
  _args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const data = loadAudits();
  const autoItems = data.audits.filter(
    a => (a.check_type === 'automated' || a.check_type === 'hybrid') && a.check_command,
  );

  if (autoItems.length === 0) {
    return { exitCode: 0, output: 'No automated audit items found.' };
  }

  const lines: string[] = ['\x1b[1mRunning automated audit checks:\x1b[0m', ''];

  for (const item of autoItems) {
    lines.push(`\x1b[1m${item.id}\x1b[0m (${item.check_type})`);
    lines.push(`  ${item.description}`);
    lines.push('');

    try {
      const output = execSync(item.check_command!, {
        cwd: PROJECT_ROOT,
        timeout: 30_000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      lines.push('  \x1b[2mOutput:\x1b[0m');
      for (const ol of output.split('\n')) {
        lines.push(`    ${ol}`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      lines.push(`  \x1b[31mCommand failed:\x1b[0m ${message.split('\n')[0]}`);
    }

    lines.push('');
    if (item.check_type === 'hybrid') {
      lines.push('  \x1b[33m→ Requires interpretation. Use `crux audits check` to record result.\x1b[0m');
    } else {
      lines.push(`  \x1b[2m→ Use \`crux audits check ${item.id} --pass\` or \`--fail\` to record.\x1b[0m`);
    }
    lines.push('');
  }

  return { exitCode: 0, output: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// report command
// ---------------------------------------------------------------------------

async function reportCommand(
  _args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const data = loadAudits();

  const overdueAudits = data.audits.filter(isOverdue);
  const pendingPM = data.post_merge.filter(pm => pm.status === 'pending');
  const failedAudits = data.audits.filter(a => a.last_result === 'fail');

  if (options.json || options.ci) {
    return {
      exitCode: 0,
      output: JSON.stringify({
        total_audits: data.audits.length,
        overdue: overdueAudits.length,
        failed: failedAudits.length,
        pending_post_merge: pendingPM.length,
        overdue_items: overdueAudits.map(a => a.id),
        failed_items: failedAudits.map(a => a.id),
        pending_pm_items: pendingPM.map(pm => ({ id: pm.id, pr: pm.pr, claim: pm.claim })),
      }, null, 2),
    };
  }

  const lines: string[] = ['\x1b[1mAudits Report\x1b[0m', ''];

  // Summary
  lines.push(`  Total audits: ${data.audits.length}`);
  lines.push(`  Overdue:      ${overdueAudits.length}`);
  lines.push(`  Failed:       ${failedAudits.length}`);
  lines.push(`  Post-merge:   ${pendingPM.length} pending`);
  lines.push('');

  // Failed audits (highest priority)
  if (failedAudits.length > 0) {
    lines.push('\x1b[31m\x1b[1mFailed Audits (P0):\x1b[0m');
    for (const item of failedAudits) {
      lines.push(`  ✗ ${item.id} — last checked ${item.last_checked}`);
      lines.push(`    ${item.description}`);
    }
    lines.push('');
  }

  // Overdue audits
  if (overdueAudits.length > 0) {
    lines.push('\x1b[33m\x1b[1mOverdue Audits (P1):\x1b[0m');
    for (const item of overdueAudits) {
      const since = item.last_checked ? `last checked ${item.last_checked}` : 'never checked';
      lines.push(`  ● ${item.id} — ${since} (${item.frequency})`);
    }
    lines.push('');
  }

  // Pending post-merge
  if (pendingPM.length > 0) {
    lines.push('\x1b[1mPending Post-Merge Verifications (P1):\x1b[0m');
    for (const pm of pendingPM) {
      const deadlineStr = pm.deadline ? ` — deadline ${pm.deadline}` : '';
      lines.push(`  ● ${pm.id} (PR #${pm.pr})${deadlineStr}`);
      lines.push(`    ${pm.claim}`);
    }
    lines.push('');
  }

  if (overdueAudits.length === 0 && failedAudits.length === 0 && pendingPM.length === 0) {
    lines.push('\x1b[32mAll audits are up to date.\x1b[0m');
  }

  return { exitCode: 0, output: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const commands = {
  list: listCommand,
  check: checkCommand,
  'run-auto': runAutoCommand,
  report: reportCommand,
  default: listCommand,
};

export function getHelp(): string {
  return `
Audits Domain — System-level behavioral verification

Track ongoing properties we expect to be true about the system,
plus one-time post-merge verification items tied to specific PRs.

Commands:
  list              Show all audit items (default), highlight overdue
  check <id>        Record a check result for an audit item
  run-auto          Run automated/hybrid checks, show output
  report            Full report for maintenance sweep

Options (list):
  --pending         Only show overdue / never-checked items
  --category=X      Filter by category (infrastructure, process, feature-health, data-pipeline)
  --json            JSON output

Options (check):
  --pass            Mark the check as passing
  --fail            Mark the check as failing
  --notes="..."     Add notes about the check result
  --status=X        For post-merge items: verified, failed, wontfix

Registry file: .claude/audits.yaml (checked into git)

Examples:
  crux audits                                     # List all, highlight overdue
  crux audits list --pending                      # Only overdue items
  crux audits check groundskeeper-health --pass   # Record a passing check
  crux audits run-auto                            # Run automated checks
  crux audits report                              # Summary for maintenance
`;
}
