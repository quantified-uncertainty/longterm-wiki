/**
 * TableBase Command Handlers
 *
 * Scan PG table completeness, rank enrichment tasks by impact,
 * and run LLM agents with web search to fill gaps.
 *
 * Usage:
 *   crux tablebase scan       Show per-table completeness scores
 *   crux tablebase gaps       Ranked list of missing data
 *   crux tablebase next-task  Single highest-impact task (JSON)
 *   crux tablebase improve    Run LLM agent for one task
 *   crux tablebase mark-done  Exclude from future picks
 *   crux tablebase loop       Autonomous multi-task loop
 */

import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';
import type { TaskType } from '../tablebase/types.ts';
import { TASK_TYPES } from '../tablebase/types.ts';

interface CommandOptions extends BaseOptions {
  top?: string;
  limit?: string;
  format?: string;
  ci?: boolean;
  dryRun?: boolean;
  max?: string;
  budget?: string;
  taskType?: string;
  entityType?: string;
  table?: string;
}

async function scanCommand(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const { runFullScan, runTableScan } = await import('../tablebase/scanner.ts');
  const { formatScanSummary } = await import('../tablebase/reporter.ts');

  if (options.table) {
    const result = await runTableScan(options.table as string);
    if (!result) {
      return { exitCode: 1, output: `Unknown table: ${options.table}` };
    }
    if (options.ci) {
      return { exitCode: 0, output: JSON.stringify(result, null, 2) };
    }
    return { exitCode: 0, output: formatScanSummary({ tables: [result], timestamp: new Date().toISOString() }) };
  }

  const scan = await runFullScan();
  if (options.ci) {
    return { exitCode: 0, output: JSON.stringify(scan, null, 2) };
  }
  return { exitCode: 0, output: formatScanSummary(scan) };
}

async function gapsCommand(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const { runFullScan } = await import('../tablebase/scanner.ts');
  const { rankTasks } = await import('../tablebase/task-ranker.ts');
  const { formatGaps } = await import('../tablebase/reporter.ts');

  const scan = await runFullScan();
  const limit = options.top ? parseInt(options.top as string, 10) : options.limit ? parseInt(options.limit as string, 10) : 20;

  const taskTypes = options.taskType
    ? [options.taskType as TaskType].filter(t => TASK_TYPES.includes(t as TaskType))
    : undefined;
  const entityTypes = options.entityType ? [options.entityType as string] : undefined;

  const tasks = rankTasks(scan, { taskTypes, entityTypes, limit });

  if (options.ci) {
    return { exitCode: 0, output: JSON.stringify(tasks, null, 2) };
  }
  return { exitCode: 0, output: formatGaps(tasks, { limit }) };
}

async function nextTaskCommand(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const { runFullScan } = await import('../tablebase/scanner.ts');
  const { rankTasks } = await import('../tablebase/task-ranker.ts');
  const { formatTask } = await import('../tablebase/reporter.ts');

  const scan = await runFullScan();
  const format = (options.format as string) || 'prompt';

  const taskTypes = options.taskType
    ? [options.taskType as TaskType].filter(t => TASK_TYPES.includes(t as TaskType))
    : undefined;

  const tasks = rankTasks(scan, { taskTypes, limit: 1 });

  if (tasks.length === 0) {
    return format === 'json'
      ? { exitCode: 0, output: JSON.stringify({ task: null, message: 'NO_TASKS' }) }
      : { exitCode: 0, output: 'NO_TASKS — all enrichment targets are complete or excluded.' };
  }

  if (format === 'json') {
    return { exitCode: 0, output: JSON.stringify(tasks[0], null, 2) };
  }
  return { exitCode: 0, output: formatTask(tasks[0]) };
}

async function improveCommand(args: string[], options: CommandOptions): Promise<CommandResult> {
  const taskId = args.find(a => !a.startsWith('--'));
  if (!taskId) {
    return { exitCode: 1, output: 'Usage: crux tablebase improve <task-id> [--dry-run]' };
  }

  const { findTaskById } = await import('../tablebase/loop.ts');
  const { runEnrichmentAgent } = await import('../tablebase/agent.ts');

  const task = await findTaskById(taskId);
  if (!task) {
    return { exitCode: 1, output: `Task not found: ${taskId}. Run 'crux tablebase gaps' to see available tasks.` };
  }

  const dryRun = !!options.dryRun;
  const result = await runEnrichmentAgent(task, { dryRun });

  if (!dryRun) {
    const { markTaskDone } = await import('../tablebase/task-ranker.ts');
    markTaskDone(task.id);
  }

  if (options.ci) {
    return { exitCode: 0, output: JSON.stringify(result, null, 2) };
  }

  return {
    exitCode: 0,
    output: `\x1b[32m✓\x1b[0m Task ${task.id} complete: ${result.recordsCreated} records created, $${result.cost.toFixed(4)}, ${Math.round(result.durationMs / 1000)}s`,
  };
}

async function markDoneCommand(args: string[], options: CommandOptions): Promise<CommandResult> {
  const taskId = args.find(a => !a.startsWith('--'));
  if (!taskId) {
    return { exitCode: 1, output: 'Usage: crux tablebase mark-done <task-id>' };
  }

  const { markTaskDone } = await import('../tablebase/task-ranker.ts');
  markTaskDone(taskId);

  if (options.ci) {
    return { exitCode: 0, output: JSON.stringify({ marked: taskId }) };
  }
  return { exitCode: 0, output: `\x1b[32m✓\x1b[0m Marked ${taskId} as done` };
}

async function loopCommand(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const { runLoop } = await import('../tablebase/loop.ts');

  const maxTasks = options.max ? parseInt(options.max as string, 10) : 5;
  const budgetDollars = options.budget ? parseFloat(options.budget as string) : 30;
  const dryRun = !!options.dryRun;

  const taskTypes = options.taskType
    ? [options.taskType as TaskType].filter(t => TASK_TYPES.includes(t as TaskType))
    : undefined;
  const entityTypes = options.entityType ? [options.entityType as string] : undefined;

  const result = await runLoop({
    maxTasks,
    budgetDollars,
    dryRun,
    taskTypes,
    entityTypes,
  });

  if (options.ci) {
    return { exitCode: 0, output: JSON.stringify(result, null, 2) };
  }

  return {
    exitCode: 0,
    output: `Loop finished: ${result.tasksSucceeded}/${result.tasksAttempted} tasks, ${result.totalRecordsCreated} records, $${result.totalCost.toFixed(4)}, ${Math.round(result.totalDurationMs / 1000)}s (${result.stoppedReason})`,
  };
}

export const commands = {
  scan: scanCommand,
  gaps: gapsCommand,
  'next-task': nextTaskCommand,
  improve: improveCommand,
  'mark-done': markDoneCommand,
  loop: loopCommand,
  default: scanCommand,
};

export function getHelp(): string {
  return `
TableBase Domain — Structured data enrichment via LLM agents

Commands:
  scan        Show per-table completeness scores
  gaps        Ranked list of missing data (enrichment targets)
  next-task   Output the single highest-impact task
  improve     Run LLM agent to enrich data for one task
  mark-done   Mark a task as completed (excluded from future picks)
  loop        Autonomous multi-task enrichment loop

Options:
  --table=<name>        Filter scan to specific table
  --top=N, --limit=N    Number of gaps to show (default: 20)
  --task-type=<type>    Filter by task type (personnel-enrichment, grant-grantee-backfill, etc.)
  --entity-type=<type>  Filter by entity type (organization, ai-model)
  --format=prompt|json  Output format for next-task
  --dry-run             Run agent without writing to database
  --max=N               Max tasks for loop (default: 5)
  --budget=N            Budget limit in USD for loop (default: 30)
  --ci                  JSON output

Task Types:
  grant-grantee-backfill     Link grants to grantee entities
  personnel-enrichment       Add key personnel for organizations
  funding-round-research     Add funding round data for companies
  investment-linking         Add investment records
  benchmark-result-fill      Add benchmark scores for AI models

Examples:
  crux tablebase scan                                 # Overview of all tables
  crux tablebase gaps --top=10                        # Top 10 enrichment targets
  crux tablebase gaps --task-type=personnel-enrichment  # Personnel gaps only
  crux tablebase next-task --format=json              # JSON for scripting
  crux tablebase improve abc123def --dry-run          # Test run without writing
  crux tablebase loop --max=3 --budget=10             # 3-task loop with $10 cap
  crux tablebase mark-done abc123def                  # Exclude from future runs
`;
}
