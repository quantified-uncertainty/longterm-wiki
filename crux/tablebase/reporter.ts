/**
 * TableBase Reporter
 *
 * Console table formatting for scan and gaps output.
 */

import type { ScanSummary, EnrichmentTask } from './types.ts';

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const RESET = '\x1b[0m';

function colorPct(pct: number): string {
  const color = pct < 30 ? RED : pct < 60 ? YELLOW : GREEN;
  return `${color}${pct}%${RESET}`;
}

/** Format scan summary as a console table */
export function formatScanSummary(scan: ScanSummary): string {
  const lines: string[] = [
    `${BOLD}TableBase Scan Results${RESET}`,
    `${DIM}${scan.timestamp}${RESET}`,
    '',
    `${'Table'.padEnd(20)} ${'Entities'.padStart(9)} ${'With Data'.padStart(10)} ${'Records'.padStart(8)} ${'Avg Compl'.padStart(10)}`,
    `${'─'.repeat(20)} ${'─'.repeat(9)} ${'─'.repeat(10)} ${'─'.repeat(8)} ${'─'.repeat(10)}`,
  ];

  for (const table of scan.tables) {
    lines.push(
      `${table.table.padEnd(20)} ${String(table.totalEntities).padStart(9)} ${String(table.entitiesWithRecords).padStart(10)} ${String(table.totalRecords).padStart(8)} ${colorPct(table.avgCompleteness).padStart(10 + 9)}`, // +9 for ANSI codes
    );
  }

  const totalRecords = scan.tables.reduce((s, t) => s + t.totalRecords, 0);
  const avgCompl = scan.tables.length > 0
    ? Math.round(scan.tables.reduce((s, t) => s + t.avgCompleteness, 0) / scan.tables.length)
    : 0;

  lines.push(
    '',
    `${BOLD}Total records: ${totalRecords} | Average completeness: ${avgCompl}%${RESET}`,
  );

  return lines.join('\n');
}

/** Format ranked gaps as a console table */
export function formatGaps(tasks: EnrichmentTask[], options?: { limit?: number }): string {
  const limited = options?.limit ? tasks.slice(0, options.limit) : tasks;

  const lines: string[] = [
    `${BOLD}TableBase Enrichment Gaps (${limited.length}${tasks.length > limited.length ? ` of ${tasks.length}` : ''})${RESET}`,
    '',
    `${'#'.padStart(3)} ${'Task ID'.padEnd(14)} ${'Type'.padEnd(26)} ${'Entity'.padEnd(32)} ${'Records'.padStart(8)} ${'Impact'.padStart(7)} ${'Reasons'}`,
    `${'─'.repeat(3)} ${'─'.repeat(14)} ${'─'.repeat(26)} ${'─'.repeat(32)} ${'─'.repeat(8)} ${'─'.repeat(7)} ${'─'.repeat(30)}`,
  ];

  limited.forEach((task, i) => {
    const name = task.entityName.length > 31
      ? task.entityName.slice(0, 28) + '...'
      : task.entityName;
    const impactColor = task.impactScore >= 100 ? RED : task.impactScore >= 50 ? YELLOW : GREEN;

    lines.push(
      `${String(i + 1).padStart(3)} ${task.id.padEnd(14)} ${task.taskType.padEnd(26)} ${name.padEnd(32)} ${String(task.existingRecordCount).padStart(8)} ${impactColor}${String(task.impactScore).padStart(7)}${RESET} ${task.reasons.join(', ')}`,
    );
  });

  lines.push('', `${DIM}Use: crux tablebase improve <task-id> [--dry-run]${RESET}`);

  return lines.join('\n');
}

/** Format a single task as human-readable prompt */
export function formatTask(task: EnrichmentTask): string {
  return `## Enrichment Task: ${task.taskType}

**Entity**: ${task.entityName} (${task.entityId})
**Entity type**: ${task.entityType}
**Table**: ${task.table}
**Existing records**: ${task.existingRecordCount}
**Impact score**: ${task.impactScore}
**Issues**: ${task.reasons.join(', ')}
**Task ID**: ${task.id}

### Command
\`pnpm crux tablebase improve ${task.id}\``;
}
