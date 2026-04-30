/**
 * Field-targeted improve pipeline (QUA-552).
 *
 * Layers a field-level CLI on top of the existing entity/task-level improve
 * pipeline. Maps a (table, field) pair to the correct task type via
 * `fieldToTaskType()`, then invokes `runLoop()` filtered to that task type.
 *
 * Two entry points:
 *   - runFieldTargetedImprove({ target: "divisions.lead_id", budgetUsd: 5 })
 *   - runScanReportImprove({ reportPath: "report.json", budgetUsd: 20 })
 *
 * Idempotency is handled by the underlying loop's exclusion list
 * (.tablebase-completed.txt) — re-runs automatically skip already-completed
 * (taskType, entity) tasks.
 */

import { readFileSync } from 'fs';
import type { TaskType, LoopOptions } from './types.ts';
import { fieldToTaskType, parseFieldGapReport } from './field-gap-types.ts';
import type { FieldGap, FieldGapReport } from './field-gap-types.ts';

export interface FieldTargetOptions {
  /** "table.field" or "table:field" — the field gap to enrich. */
  target: string;
  /** Dollar budget cap. Loop halts when cumulative cost reaches this. */
  budgetUsd: number;
  /** Max tasks to attempt (independent of budget). Default: 10. */
  maxTasks?: number;
  /** Model override (e.g. "haiku", "sonnet", "opus", "auto"). Default: auto. */
  model?: string;
  /** Don't actually submit records — just exercise the agent. */
  dryRun?: boolean;
  /** Skip sourcing gate before submission (advisory). */
  skipSourcing?: boolean;
  /** QUA-730: required when skipSourcing is true. */
  skipSourcingReason?: string;
}

export interface ScanReportOptions {
  /** Path to a FieldGapReport JSON file from `crux tb scan --fields --json`. */
  reportPath: string;
  /** Dollar budget cap across the whole report. */
  budgetUsd: number;
  /** Max tasks to attempt across all gaps. Default: 20. */
  maxTasks?: number;
  /** Model override. Default: auto. */
  model?: string;
  /** Don't actually submit records. */
  dryRun?: boolean;
  /** Skip sourcing gate before submission. */
  skipSourcing?: boolean;
  /** QUA-730: required when skipSourcing is true. */
  skipSourcingReason?: string;
}

export interface FieldImproveResult {
  /** (table, field) pairs that were targeted. */
  targets: Array<{ table: string; field: string; taskType: TaskType }>;
  /** (table, field) pairs that had no known task-type mapping and were skipped. */
  skipped: Array<{ table: string; field: string; reason: string }>;
  /** Tasks attempted across all targets. */
  tasksAttempted: number;
  /** Tasks that produced at least one record. */
  tasksSucceeded: number;
  /** Total records created across all tasks. */
  totalRecordsCreated: number;
  /** Total cost across all tasks. */
  totalCost: number;
  /** Reason the loop stopped. */
  stoppedReason: string;
}

/**
 * Parse a CLI target string like "divisions.lead_id" into (table, field).
 * Accepts `.`, `:`, or `/` as separators for convenience.
 */
export function parseTargetField(target: string): { table: string; field: string } {
  const match = target.match(/^([^.:/]+)[.:/](.+)$/);
  if (!match) {
    throw new Error(
      `Invalid --target-field format: "${target}". Expected TABLE.FIELD (e.g. divisions.lead_id).`,
    );
  }
  return { table: match[1], field: match[2] };
}

/**
 * Run improve for a single (table, field) gap. Delegates to the existing
 * runLoop() with a taskType filter derived from the field.
 */
export async function runFieldTargetedImprove(
  options: FieldTargetOptions,
): Promise<FieldImproveResult> {
  const { table, field } = parseTargetField(options.target);
  const taskType = fieldToTaskType(table, field);

  if (!taskType) {
    return {
      targets: [],
      skipped: [{ table, field, reason: 'no task-type mapping (add one to fieldToTaskType)' }],
      tasksAttempted: 0,
      tasksSucceeded: 0,
      totalRecordsCreated: 0,
      totalCost: 0,
      stoppedReason: 'no_mapping',
    };
  }

  console.log(`[field-improve] Target: ${table}.${field} → taskType: ${taskType}`);

  const { runLoop } = await import('./loop.ts');
  const loopOptions: LoopOptions = {
    maxTasks: options.maxTasks ?? 10,
    budgetDollars: options.budgetUsd,
    dryRun: !!options.dryRun,
    taskTypes: [taskType],
    model: options.model ?? 'auto',
    skipSourcing: !!options.skipSourcing,
    skipSourcingReason: options.skipSourcingReason,
  };

  const result = await runLoop(loopOptions);

  return {
    targets: [{ table, field, taskType }],
    skipped: [],
    tasksAttempted: result.tasksAttempted,
    tasksSucceeded: result.tasksSucceeded,
    totalRecordsCreated: result.totalRecordsCreated,
    totalCost: result.totalCost,
    stoppedReason: result.stoppedReason,
  };
}

/**
 * Run improve for all gaps in a FieldGapReport. Collects task-types across
 * all gaps into a single filter set, then runs one budgeted loop.
 *
 * Why one loop and not one-per-gap: the budget is global. Running N loops
 * with budgetUsd/N each would either starve high-impact gaps or leave small
 * gaps with too little budget. One loop with a union filter lets the task
 * ranker's impact score pick the highest-impact work across the whole report.
 */
export async function runScanReportImprove(
  options: ScanReportOptions,
): Promise<FieldImproveResult> {
  const json = readFileSync(options.reportPath, 'utf-8');
  const report: FieldGapReport = parseFieldGapReport(json);

  if (report.gaps.length === 0) {
    return {
      targets: [],
      skipped: [],
      tasksAttempted: 0,
      tasksSucceeded: 0,
      totalRecordsCreated: 0,
      totalCost: 0,
      stoppedReason: 'no_gaps',
    };
  }

  const targets: Array<{ table: string; field: string; taskType: TaskType }> = [];
  const skipped: Array<{ table: string; field: string; reason: string }> = [];
  const taskTypes = new Set<TaskType>();

  for (const gap of report.gaps) {
    const taskType = fieldToTaskType(gap.table, gap.field);
    if (taskType) {
      targets.push({ table: gap.table, field: gap.field, taskType });
      taskTypes.add(taskType);
    } else {
      skipped.push({
        table: gap.table,
        field: gap.field,
        reason: 'no task-type mapping',
      });
    }
  }

  console.log(
    `[field-improve] Scan report: ${report.gaps.length} gaps, ${targets.length} mapped to ${taskTypes.size} task type(s), ${skipped.length} skipped`,
  );

  if (taskTypes.size === 0) {
    return {
      targets,
      skipped,
      tasksAttempted: 0,
      tasksSucceeded: 0,
      totalRecordsCreated: 0,
      totalCost: 0,
      stoppedReason: 'no_mapped_gaps',
    };
  }

  const { runLoop } = await import('./loop.ts');
  const loopOptions: LoopOptions = {
    maxTasks: options.maxTasks ?? 20,
    budgetDollars: options.budgetUsd,
    dryRun: !!options.dryRun,
    taskTypes: [...taskTypes],
    model: options.model ?? 'auto',
    skipSourcing: !!options.skipSourcing,
    skipSourcingReason: options.skipSourcingReason,
  };

  const result = await runLoop(loopOptions);

  return {
    targets,
    skipped,
    tasksAttempted: result.tasksAttempted,
    tasksSucceeded: result.tasksSucceeded,
    totalRecordsCreated: result.totalRecordsCreated,
    totalCost: result.totalCost,
    stoppedReason: result.stoppedReason,
  };
}

/**
 * Format the result for human-readable terminal output.
 */
export function formatFieldImproveResult(result: FieldImproveResult): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('─'.repeat(60));
  lines.push('Field-targeted improve complete');
  lines.push('─'.repeat(60));

  if (result.targets.length > 0) {
    lines.push(`Targets (${result.targets.length}):`);
    for (const t of result.targets) {
      lines.push(`  ✓ ${t.table}.${t.field} → ${t.taskType}`);
    }
  }

  if (result.skipped.length > 0) {
    lines.push(`Skipped (${result.skipped.length}):`);
    for (const s of result.skipped) {
      lines.push(`  ✗ ${s.table}.${s.field}: ${s.reason}`);
    }
  }

  lines.push('');
  lines.push(`  Tasks:   ${result.tasksAttempted} attempted, ${result.tasksSucceeded} succeeded`);
  lines.push(`  Records: ${result.totalRecordsCreated} created`);
  lines.push(`  Cost:    $${result.totalCost.toFixed(4)}`);
  lines.push(`  Stopped: ${result.stoppedReason}`);
  lines.push('─'.repeat(60));

  return lines.join('\n');
}

export type { FieldGap, FieldGapReport };
