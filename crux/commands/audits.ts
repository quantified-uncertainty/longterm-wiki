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
 *   crux sys audits list [--pending] [--overdue] [--category=X] [--strict] [--json]
 *   crux sys audits check <id> [--pass|--fail] [--notes="..."]
 *   crux sys audits add "description" --type=ongoing|post_merge [options]
 *   crux sys audits run-auto
 *   crux sys audits report
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { parse as parseYaml } from 'yaml';
import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';
import { PROJECT_ROOT } from '../lib/content-types.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CheckHistoryEntry {
  date: string;
  result: 'pass' | 'fail';
  checked_by: string;
  notes?: string;
}

export interface AuditItem {
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
  last_result_note?: string;
  history?: CheckHistoryEntry[];
}

export interface PostMergeItem {
  id: string;
  pr: number | string;
  merged: string;
  claim: string;
  how_to_verify: string;
  status: 'pending' | 'verified' | 'failed' | 'wontfix';
  deadline?: string;
  checked_date: string | null;
  notes: string | null;
  history?: CheckHistoryEntry[];
}

export interface AuditsFile {
  audits: AuditItem[];
  post_merge: PostMergeItem[];
}

interface CommandOptions extends BaseOptions {
  pending?: boolean;
  overdue?: boolean;
  category?: string;
  json?: boolean;
  ci?: boolean;
  pass?: boolean;
  fail?: boolean;
  notes?: string;
  status?: string;
  strict?: boolean;
  // add command options
  type?: string;
  pr?: number | string;
  verify?: string;
  check?: string;
  deadline?: string;
  interval?: string;
  checkType?: string;
  howToVerify?: string;
  checkedBy?: string;
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

export const AUDITS_PATH = join(PROJECT_ROOT, '.claude/audits.yaml');

export function loadAudits(path?: string): AuditsFile {
  const filePath = path ?? AUDITS_PATH;
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = parseYaml(raw) as { audits?: AuditItem[]; post_merge?: PostMergeItem[] } | null;
  return {
    audits: parsed?.audits ?? [],
    post_merge: parsed?.post_merge ?? [],
  };
}

/**
 * Save audits by doing targeted field updates in the original YAML
 * to preserve comments and formatting.
 */
export function saveAudits(data: AuditsFile, path?: string): void {
  const filePath = path ?? AUDITS_PATH;
  let raw = readFileSync(filePath, 'utf-8');

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
    raw = raw.replace(notesPattern, `$1 ${pm.notes ? `"${escapeYamlString(pm.notes)}"` : 'null'}`);
  }

  writeFileSync(filePath, raw, 'utf-8');
}

/**
 * Append a new audit or post-merge item to the YAML file.
 *
 * The yamlBlock should be a YAML list item starting with "- id: ..."
 * with continuation lines indented by 2 spaces (matching the standard
 * YAML list item format). This function re-indents the block to match
 * the file's existing indentation (2 spaces for the `- `, 4 spaces for
 * continuation fields).
 *
 * Example input:
 *   "- id: my-item\n  category: infra\n  description: ..."
 *
 * Produces in file:
 *   "  - id: my-item\n    category: infra\n    description: ..."
 */
export function appendItem(
  section: 'audits' | 'post_merge',
  yamlBlock: string,
  path?: string,
): void {
  const filePath = path ?? AUDITS_PATH;
  let raw = readFileSync(filePath, 'utf-8');

  // Re-indent: the block uses "- key: val\n  key: val" (0+2 indent).
  // We need "  - key: val\n    key: val" (2+4 indent) to sit under a section.
  const indentedBlock = yamlBlock
    .split('\n')
    .map((line) => {
      if (line.startsWith('- ')) {
        // First line: "- id: X" -> "  - id: X"
        return `  ${line}`;
      } else {
        // Continuation lines: "  key: val" -> "    key: val"
        return `  ${line}`;
      }
    })
    .join('\n');

  if (section === 'audits') {
    // Find the post_merge section header and insert before it
    const postMergeMarker = raw.indexOf('\npost_merge:');
    if (postMergeMarker >= 0) {
      const beforePostMerge = raw.substring(0, postMergeMarker);
      const afterPostMerge = raw.substring(postMergeMarker);
      raw = beforePostMerge.trimEnd() + '\n\n' + indentedBlock + '\n' + afterPostMerge;
    } else {
      // No post_merge section — append at end of file
      raw = raw.trimEnd() + '\n\n' + indentedBlock + '\n';
    }
  } else {
    // post_merge — append at end of file
    raw = raw.trimEnd() + '\n\n' + indentedBlock + '\n';
  }

  writeFileSync(filePath, raw, 'utf-8');
}

/**
 * Append a history entry to an existing audit or post-merge item in the YAML file.
 */
export function appendHistoryEntry(
  itemId: string,
  entry: CheckHistoryEntry,
  path?: string,
): void {
  const filePath = path ?? AUDITS_PATH;
  let raw = readFileSync(filePath, 'utf-8');

  // Find the item block by id
  const idPattern = new RegExp(`(- id: ${escapeRegex(itemId)})`);
  const idMatch = raw.match(idPattern);
  if (!idMatch || idMatch.index === undefined) return;

  // Find the end of this item (next "  - id:" at same indentation, or end of section/file)
  const itemStart = idMatch.index;
  const afterItem = raw.substring(itemStart + 1);
  const nextItemMatch = afterItem.match(/\n  - id: /);
  const nextSectionMatch = afterItem.match(/\n[a-z_]+:/);
  let itemEndOffset: number;
  if (nextItemMatch?.index !== undefined && nextSectionMatch?.index !== undefined) {
    itemEndOffset = Math.min(nextItemMatch.index, nextSectionMatch.index);
  } else if (nextItemMatch?.index !== undefined) {
    itemEndOffset = nextItemMatch.index;
  } else if (nextSectionMatch?.index !== undefined) {
    itemEndOffset = nextSectionMatch.index;
  } else {
    itemEndOffset = afterItem.length;
  }
  const itemEnd = itemStart + 1 + itemEndOffset;
  const itemBlock = raw.substring(itemStart, itemEnd);

  // Build the history entry YAML
  const entryLines = [`      - date: "${entry.date}"`, `        result: ${entry.result}`, `        checked_by: "${escapeYamlString(entry.checked_by)}"`];
  if (entry.notes) {
    entryLines.push(`        notes: "${escapeYamlString(entry.notes)}"`);
  }
  const entryYaml = entryLines.join('\n');

  // Check if item already has a history array
  if (itemBlock.includes('history:')) {
    // Append to existing history array — find the end of the history section
    const historyIdx = itemBlock.indexOf('history:');
    const afterHistory = itemBlock.substring(historyIdx);
    // Find the next top-level field (4 spaces + non-space) or end of block
    const nextFieldMatch = afterHistory.match(/\n    [a-z]/);
    const insertPos = nextFieldMatch?.index !== undefined
      ? itemStart + historyIdx + nextFieldMatch.index
      : itemEnd;
    raw = raw.substring(0, insertPos) + '\n' + entryYaml + raw.substring(insertPos);
  } else {
    // Add new history array before the end of this item
    const historyBlock = `    history:\n${entryYaml}`;
    raw = raw.substring(0, itemEnd).trimEnd() + '\n' + historyBlock + '\n' + raw.substring(itemEnd);
  }

  writeFileSync(filePath, raw, 'utf-8');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeYamlString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const FREQUENCY_DAYS: Record<string, number> = {
  daily: 1,
  weekly: 7,
  biweekly: 14,
  monthly: 30,
};

const VALID_CATEGORIES = ['infrastructure', 'data-pipeline', 'feature-health', 'process'] as const;
const VALID_FREQUENCIES = ['daily', 'weekly', 'biweekly', 'monthly'] as const;
const VALID_CHECK_TYPES = ['manual', 'automated', 'hybrid'] as const;

export function isOverdue(item: AuditItem): boolean {
  if (!item.last_checked) return true;
  const lastDate = new Date(item.last_checked);
  const now = new Date();
  const daysSince = (now.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24);
  return daysSince > (FREQUENCY_DAYS[item.frequency] ?? 30);
}

export function isPostMergeOverdue(item: PostMergeItem): boolean {
  if (item.status !== 'pending') return false;
  if (!item.deadline) return false;
  const deadline = new Date(item.deadline);
  const now = new Date();
  return now > deadline;
}

export function daysUntilDue(item: AuditItem): number | null {
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

export function today(): string {
  return new Date().toISOString().split('T')[0];
}

/**
 * Generate a slug-style id from a description string.
 * e.g., "Verify stableId migration applied" -> "verify-stableid-migration-applied"
 */
export function descriptionToId(description: string): string {
  return description
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 60);
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

  // Filter to pending/overdue only (--pending and --overdue are synonyms)
  const filterOverdue = options.pending || options.overdue;
  if (filterOverdue) {
    items = items.filter(i => isOverdue(i));
  }

  const overdueItems = items.filter(i => isOverdue(i));
  const overduePM = data.post_merge.filter(pm => isPostMergeOverdue(pm));
  const totalOverdueCount = overdueItems.length + overduePM.length;

  if (options.json || options.ci) {
    const result = {
      audits: items.map(i => ({
        ...i,
        overdue: isOverdue(i),
        days_until_due: daysUntilDue(i),
      })),
      post_merge: data.post_merge.filter(pm => pm.status === 'pending').map(pm => ({
        ...pm,
        overdue: isPostMergeOverdue(pm),
      })),
    };
    const exitCode = options.strict && totalOverdueCount > 0 ? 1 : 0;
    return { exitCode, output: JSON.stringify(result, null, 2) };
  }

  const lines: string[] = [];

  // Ongoing audits
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

  if (okItems.length > 0 && !filterOverdue) {
    lines.push('\x1b[1m\x1b[32mUp to Date:\x1b[0m');
    for (const item of okItems) {
      lines.push(`  ${formatStatus(item)}  ${item.id}`);
      lines.push(`    \x1b[2m${item.description}\x1b[0m`);
    }
    lines.push('');
  }

  // Post-merge items — show overdue ones prominently first
  const pendingPM = data.post_merge.filter(pm => pm.status === 'pending');

  if (overduePM.length > 0) {
    lines.push('\x1b[1m\x1b[31mOverdue Post-Merge Verifications:\x1b[0m');
    for (const pm of overduePM) {
      lines.push(`  \x1b[31m●\x1b[0m  ${pm.id} — PR #${pm.pr} \x1b[31m(deadline: ${pm.deadline} OVERDUE)\x1b[0m`);
      lines.push(`    \x1b[2m${pm.claim}\x1b[0m`);
    }
    lines.push('');
  }

  const nonOverduePendingPM = pendingPM.filter(pm => !isPostMergeOverdue(pm));
  if (nonOverduePendingPM.length > 0 && !filterOverdue) {
    lines.push('\x1b[1mPending Post-Merge Verifications:\x1b[0m');
    for (const pm of nonOverduePendingPM) {
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
  lines.push(`\x1b[2m${totalAudits} audits (${totalOverdue} overdue), ${totalPendingPM} pending post-merge items (${overduePM.length} overdue)\x1b[0m`);

  // --strict: exit non-zero if anything is overdue
  const exitCode = options.strict && totalOverdueCount > 0 ? 1 : 0;

  return { exitCode, output: lines.join('\n') };
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
      output: `Usage: crux sys audits check <id> [--pass|--fail] [--notes="..."]

  Record the result of checking an audit item or post-merge verification.
  Results are auto-recorded to the item's history array in audits.yaml.

Examples:
  crux sys audits check groundskeeper-health --pass --notes="Messages look substantive"
  crux sys audits check vercel-ignore-command-v2 --fail --notes="Still seeing PR deploys"
  crux sys audits check agent-sessions-logged --pass --checked-by="agent:a1"`,
    };
  }

  const data = loadAudits();
  const checkedBy = typeof options.checkedBy === 'string' ? options.checkedBy : 'manual';

  // Check ongoing audits
  const auditIdx = data.audits.findIndex(a => a.id === id);
  if (auditIdx >= 0) {
    const result = options.pass ? 'pass' as const : options.fail ? 'fail' as const : null;
    if (!result) {
      return {
        exitCode: 1,
        output: 'Specify --pass or --fail to record the check result.',
      };
    }
    const dateStr = today();
    data.audits[auditIdx].last_checked = dateStr;
    data.audits[auditIdx].last_result = result;
    saveAudits(data);

    // Record history entry
    const historyEntry: CheckHistoryEntry = {
      date: dateStr,
      result,
      checked_by: checkedBy,
    };
    if (options.notes) {
      historyEntry.notes = options.notes as string;
    }
    appendHistoryEntry(id, historyEntry);

    const symbol = result === 'pass' ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    const notesStr = options.notes ? `\n  Notes: ${options.notes}` : '';
    const byStr = `\n  Checked by: ${checkedBy}`;
    return {
      exitCode: 0,
      output: `${symbol} Recorded ${result} for audit: ${id}${byStr}${notesStr}`,
    };
  }

  // Check post-merge items
  const pmIdx = data.post_merge.findIndex(pm => pm.id === id);
  if (pmIdx >= 0) {
    const VALID_PM_STATUSES = ['pending', 'verified', 'failed', 'wontfix'] as const;
    const rawStatus = options.status ?? (options.pass ? 'verified' : options.fail ? 'failed' : null);
    if (rawStatus && !VALID_PM_STATUSES.includes(rawStatus as typeof VALID_PM_STATUSES[number])) {
      return {
        exitCode: 1,
        output: `Invalid status: ${rawStatus}. Valid values: ${VALID_PM_STATUSES.join(', ')}`,
      };
    }
    const newStatus = rawStatus as PostMergeItem['status'] | null;
    if (!newStatus) {
      return {
        exitCode: 1,
        output: 'Specify --pass (verified), --fail (failed), or --status=<verified|failed|wontfix>.',
      };
    }
    const dateStr = today();
    data.post_merge[pmIdx].status = newStatus;
    data.post_merge[pmIdx].checked_date = dateStr;
    if (options.notes) {
      data.post_merge[pmIdx].notes = options.notes as string;
    }
    saveAudits(data);

    // Record history entry
    const result = (newStatus === 'verified' ? 'pass' : 'fail') as 'pass' | 'fail';
    const historyEntry: CheckHistoryEntry = {
      date: dateStr,
      result,
      checked_by: checkedBy,
    };
    if (options.notes) {
      historyEntry.notes = options.notes as string;
    }
    appendHistoryEntry(id, historyEntry);

    return {
      exitCode: 0,
      output: `✓ Post-merge item ${id} marked as: ${newStatus}\n  Checked by: ${checkedBy}`,
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
      // Note: check_command is from version-controlled audits.yaml.
      // Commands require shell features (pipes, loops, gh api) so
      // they run through execSync. YAML changes are reviewed via PR.
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
      lines.push('  \x1b[33m→ Requires interpretation. Use `crux sys audits check` to record result.\x1b[0m');
    } else {
      lines.push(`  \x1b[2m→ Use \`crux sys audits check ${item.id} --pass\` or \`--fail\` to record.\x1b[0m`);
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
// add command
// ---------------------------------------------------------------------------

async function addCommand(
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const description = args.find(a => !a.startsWith('--'));

  if (!description) {
    return {
      exitCode: 1,
      output: `Usage: crux sys audits add "description" --type=ongoing|post_merge [options]

  Add a new audit entry without manually editing YAML.

Options:
  --type=ongoing|post_merge   Type of audit item (required)

  Ongoing audit options:
    --category=X              Category (${VALID_CATEGORIES.join(', ')}) [default: infrastructure]
    --check-type=X            Check type (${VALID_CHECK_TYPES.join(', ')}) [default: manual]
    --check="command"         check_command for automated/hybrid checks
    --how-to-verify="..."     How to verify (defaults to description if not set)
    --interval=X              Check frequency (${VALID_FREQUENCIES.join(', ')}) [default: weekly]
    --pr=N                    PR that added this audit

  Post-merge options:
    --pr=N                    PR number (required for post_merge)
    --verify="how to verify"  How to verify the claim
    --deadline=YYYY-MM-DD     Verification deadline [default: 14 days from now]

Examples:
  crux sys audits add "Verify stableId migration applied" \\
    --type=post_merge --pr=3257 \\
    --verify="SELECT stable_id FROM entities WHERE stable_id ~ '[-_]'" \\
    --deadline=2026-04-09

  crux sys audits add "Scheduled workflows running" \\
    --type=ongoing --check="gh workflow list --all" --interval=weekly`,
    };
  }

  const itemType = options.type as string | undefined;
  if (!itemType || !['ongoing', 'post_merge'].includes(itemType)) {
    return {
      exitCode: 1,
      output: 'Required: --type=ongoing or --type=post_merge',
    };
  }

  const data = loadAudits();
  const id = descriptionToId(description);

  // Check for duplicate IDs
  const existingAudit = data.audits.find(a => a.id === id);
  const existingPM = data.post_merge.find(pm => pm.id === id);
  if (existingAudit || existingPM) {
    return {
      exitCode: 1,
      output: `An item with id "${id}" already exists. Choose a different description or manually edit audits.yaml.`,
    };
  }

  if (itemType === 'ongoing') {
    const category = (options.category as string) || 'infrastructure';
    if (!VALID_CATEGORIES.includes(category as typeof VALID_CATEGORIES[number])) {
      return {
        exitCode: 1,
        output: `Invalid category: ${category}. Valid values: ${VALID_CATEGORIES.join(', ')}`,
      };
    }

    const frequency = (options.interval as string) || 'weekly';
    if (!VALID_FREQUENCIES.includes(frequency as typeof VALID_FREQUENCIES[number])) {
      return {
        exitCode: 1,
        output: `Invalid interval: ${frequency}. Valid values: ${VALID_FREQUENCIES.join(', ')}`,
      };
    }

    const checkType = (options.checkType as string) || (options.check ? 'hybrid' : 'manual');
    if (!VALID_CHECK_TYPES.includes(checkType as typeof VALID_CHECK_TYPES[number])) {
      return {
        exitCode: 1,
        output: `Invalid check-type: ${checkType}. Valid values: ${VALID_CHECK_TYPES.join(', ')}`,
      };
    }

    const howToVerify = (options.howToVerify as string) || (options.verify as string) || description;

    // Build YAML block for the new audit item
    const yamlLines = [
      `id: ${id}`,
      `category: ${category}`,
      `description: "${escapeYamlString(description)}"`,
      `check_type: ${checkType}`,
    ];
    if (options.check) {
      yamlLines.push(`check_command: |`);
      yamlLines.push(`  ${options.check}`);
    }
    yamlLines.push(`how_to_verify: "${escapeYamlString(howToVerify)}"`);
    yamlLines.push(`frequency: ${frequency}`);
    yamlLines.push(`added: "${today()}"`);
    if (options.pr) {
      yamlLines.push(`added_by_pr: ${options.pr}`);
    }
    yamlLines.push(`last_checked: null`);
    yamlLines.push(`last_result: null`);

    const yamlBlock = yamlLines.map((l, i) => i === 0 ? `- ${l}` : `  ${l}`).join('\n');
    appendItem('audits', yamlBlock);

    return {
      exitCode: 0,
      output: `\x1b[32m✓\x1b[0m Added ongoing audit: ${id}\n  Category: ${category}\n  Frequency: ${frequency}\n  Check type: ${checkType}`,
    };
  } else {
    // post_merge
    const pr = options.pr;
    if (!pr) {
      return {
        exitCode: 1,
        output: 'Required for post_merge: --pr=N (the PR number)',
      };
    }

    const verify = (options.verify as string) || (options.howToVerify as string) || description;

    // Default deadline: 14 days from now
    let deadline = options.deadline as string | undefined;
    if (!deadline) {
      const d = new Date();
      d.setDate(d.getDate() + 14);
      deadline = d.toISOString().split('T')[0];
    }

    const yamlLines = [
      `id: ${id}`,
      `pr: ${pr}`,
      `merged: "${today()}"`,
      `claim: "${escapeYamlString(description)}"`,
      `how_to_verify: "${escapeYamlString(verify)}"`,
      `status: pending`,
      `deadline: "${deadline}"`,
      `checked_date: null`,
      `notes: null`,
    ];

    const yamlBlock = yamlLines.map((l, i) => i === 0 ? `- ${l}` : `  ${l}`).join('\n');
    appendItem('post_merge', yamlBlock);

    return {
      exitCode: 0,
      output: `\x1b[32m✓\x1b[0m Added post-merge verification: ${id}\n  PR: #${pr}\n  Deadline: ${deadline}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const commands = {
  list: listCommand,
  check: checkCommand,
  add: addCommand,
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
  check <id>        Record a check result (with auto-recorded history)
  add "desc"        Add a new audit item via CLI (no manual YAML editing)
  run-auto          Run automated/hybrid checks, show output
  report            Full report for maintenance sweep

Options (list):
  --pending         Only show overdue / never-checked items
  --overdue         Same as --pending
  --category=X      Filter by category (infrastructure, process, feature-health, data-pipeline)
  --strict          Exit non-zero if any items are overdue
  --json            JSON output

Options (check):
  --pass            Mark the check as passing
  --fail            Mark the check as failing
  --notes="..."     Add notes about the check result
  --checked-by="X"  Who checked (agent session ID or "manual") [default: manual]
  --status=X        For post-merge items: verified, failed, wontfix

Options (add):
  --type=X          ongoing or post_merge (required)
  --pr=N            PR number
  --verify="..."    How to verify
  --check="cmd"     check_command for automated checks
  --interval=X      Frequency: daily, weekly, biweekly, monthly [default: weekly]
  --category=X      Category [default: infrastructure]
  --deadline=DATE   Deadline for post_merge [default: 14 days from now]

Registry file: .claude/audits.yaml (checked into git)

Examples:
  crux sys audits                                     # List all, highlight overdue
  crux sys audits list --overdue                      # Only overdue items
  crux sys audits list --strict                       # Exit 1 if overdue items exist
  crux sys audits check groundskeeper-health --pass   # Record a passing check
  crux sys audits add "Verify X works" --type=post_merge --pr=3257
  crux sys audits add "Check Y weekly" --type=ongoing --interval=weekly
  crux sys audits run-auto                            # Run automated checks
  crux sys audits report                              # Summary for maintenance
`;
}
