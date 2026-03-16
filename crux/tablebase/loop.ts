/**
 * TableBase Loop Orchestrator
 *
 * Autonomous multi-task enrichment loop with budget control.
 * Scans → ranks → runs agents → marks done → reports.
 */

import type { LoopOptions, TaskResult, EnrichmentTask } from './types.ts';
import { runFullScan } from './scanner.ts';
import { rankTasks, loadExclusionList, markTaskDone } from './task-ranker.ts';
import { runEnrichmentAgent } from './agent.ts';
import { formatScanSummary, formatGaps } from './reporter.ts';

interface LoopResult {
  tasksAttempted: number;
  tasksSucceeded: number;
  totalRecordsCreated: number;
  totalCost: number;
  totalDurationMs: number;
  results: TaskResult[];
  stoppedReason: 'completed' | 'budget_exceeded' | 'max_tasks_reached' | 'no_tasks';
}

/**
 * Run the autonomous enrichment loop.
 */
export async function runLoop(options: LoopOptions): Promise<LoopResult> {
  const startTime = Date.now();
  const results: TaskResult[] = [];
  let totalCost = 0;

  // Step 1: Scan
  console.log('[tablebase] Scanning table completeness...');
  const scan = await runFullScan();
  console.log(formatScanSummary(scan));
  console.log('');

  // Step 2: Rank tasks
  const excludeIds = loadExclusionList();
  const tasks = rankTasks(scan, {
    excludeIds,
    taskTypes: options.taskTypes,
    entityTypes: options.entityTypes,
  });

  if (tasks.length === 0) {
    console.log('[tablebase] No enrichment tasks found.');
    return {
      tasksAttempted: 0,
      tasksSucceeded: 0,
      totalRecordsCreated: 0,
      totalCost: 0,
      totalDurationMs: Date.now() - startTime,
      results: [],
      stoppedReason: 'no_tasks',
    };
  }

  console.log(formatGaps(tasks, { limit: Math.min(options.maxTasks, 10) }));
  console.log('');

  // Step 3: Run agents
  const maxTasks = Math.min(options.maxTasks, tasks.length);
  let stoppedReason: LoopResult['stoppedReason'] = 'completed';

  for (let i = 0; i < maxTasks; i++) {
    const task = tasks[i];

    // Budget check
    if (totalCost >= options.budgetDollars) {
      console.log(`[tablebase] Budget limit reached ($${totalCost.toFixed(2)} >= $${options.budgetDollars})`);
      stoppedReason = 'budget_exceeded';
      break;
    }

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`[tablebase] Task ${i + 1}/${maxTasks}: ${task.taskType} — ${task.entityName}`);
    console.log(`${'═'.repeat(60)}`);

    try {
      const result = await runEnrichmentAgent(task, { dryRun: options.dryRun });
      results.push(result);
      totalCost += result.cost;

      if (!options.dryRun) {
        markTaskDone(task.id);
      }

      console.log(`[tablebase] Task ${task.id}: ${result.recordsCreated} records, $${result.cost.toFixed(4)}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[tablebase] Task ${task.id} failed: ${message}`);
      results.push({
        taskId: task.id,
        recordsCreated: 0,
        recordsUpdated: 0,
        durationMs: 0,
        cost: 0,
        sources: [],
      });
    }

    if (i + 1 >= maxTasks) {
      stoppedReason = 'max_tasks_reached';
    }
  }

  // Step 4: Summary report
  const totalRecordsCreated = results.reduce((s, r) => s + r.recordsCreated, 0);
  const totalDurationMs = Date.now() - startTime;
  const succeeded = results.filter(r => r.recordsCreated > 0).length;

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`[tablebase] Loop complete`);
  console.log(`  Tasks: ${results.length} attempted, ${succeeded} succeeded`);
  console.log(`  Records: ${totalRecordsCreated} created`);
  console.log(`  Cost: $${totalCost.toFixed(4)}`);
  console.log(`  Duration: ${Math.round(totalDurationMs / 1000)}s`);
  console.log(`  Stopped: ${stoppedReason}`);
  console.log(`${'═'.repeat(60)}`);

  return {
    tasksAttempted: results.length,
    tasksSucceeded: succeeded,
    totalRecordsCreated,
    totalCost,
    totalDurationMs,
    results,
    stoppedReason,
  };
}

/**
 * Find a task by ID from a fresh scan.
 */
export async function findTaskById(taskId: string): Promise<EnrichmentTask | null> {
  const scan = await runFullScan();
  const tasks = rankTasks(scan);
  return tasks.find(t => t.id === taskId) || null;
}
