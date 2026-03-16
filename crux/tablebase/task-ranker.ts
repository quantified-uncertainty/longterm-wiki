/**
 * TableBase Task Ranker
 *
 * Converts scanner output to a ranked list of enrichment tasks.
 * Impact score = (100 - completeness) * taskTypeWeight
 * Higher score = higher priority.
 */

import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import type { EnrichmentTask, TaskType, ScanSummary, TableProfile } from './types.ts';
import { TASK_TYPE_WEIGHTS } from './types.ts';

const EXCLUSION_FILE = join(PROJECT_ROOT, '.tablebase-completed.txt');

/** Generate a deterministic task ID from taskType + entityId */
function makeTaskId(taskType: TaskType, entityId: string): string {
  const hash = createHash('sha256').update(`${taskType}:${entityId}`).digest('base64url');
  return hash.substring(0, 12);
}

/** Load exclusion list of completed task IDs */
export function loadExclusionList(filePath?: string): Set<string> {
  const path = filePath || EXCLUSION_FILE;
  if (!existsSync(path)) return new Set();
  return new Set(
    readFileSync(path, 'utf-8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#')),
  );
}

/** Append a task ID to the exclusion list */
export function markTaskDone(taskId: string, filePath?: string): void {
  const path = filePath || EXCLUSION_FILE;
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(path, `${taskId}\n`);
}

/** Map table name to the task type it generates */
function tableToTaskType(table: string): TaskType | null {
  switch (table) {
    case 'grants': return 'grant-grantee-backfill';
    case 'personnel': return 'personnel-enrichment';
    case 'funding_rounds': return 'funding-round-research';
    case 'investments': return 'investment-linking';
    case 'benchmark_results': return 'benchmark-result-fill';
    default: return null;
  }
}

/** Convert a single table profile to an enrichment task */
function profileToTask(profile: TableProfile): EnrichmentTask | null {
  const taskType = tableToTaskType(profile.table);
  if (!taskType) return null;

  const gap = 100 - profile.completenessPercent;
  if (gap <= 0) return null;

  const weight = TASK_TYPE_WEIGHTS[taskType];
  const impactScore = Math.round(gap * weight);

  return {
    id: makeTaskId(taskType, profile.entityId),
    taskType,
    entityId: profile.entityId,
    entityName: profile.entityName,
    entityType: profile.entityType,
    table: profile.table,
    impactScore,
    reasons: profile.missingFields.length > 0 ? profile.missingFields : [`${gap}% incomplete`],
    existingRecordCount: profile.totalRecords,
  };
}

/**
 * Rank all enrichment tasks from a scan summary.
 * Excludes already-completed tasks.
 */
export function rankTasks(
  scan: ScanSummary,
  options?: {
    excludeIds?: Set<string>;
    taskTypes?: TaskType[];
    entityTypes?: string[];
    limit?: number;
  },
): EnrichmentTask[] {
  const excludeIds = options?.excludeIds ?? loadExclusionList();
  const tasks: EnrichmentTask[] = [];

  for (const table of scan.tables) {
    for (const profile of table.profiles) {
      const task = profileToTask(profile);
      if (!task) continue;
      if (excludeIds.has(task.id)) continue;
      if (options?.taskTypes && !options.taskTypes.includes(task.taskType)) continue;
      if (options?.entityTypes && !options.entityTypes.includes(task.entityType)) continue;
      tasks.push(task);
    }
  }

  // Sort by impact score descending
  tasks.sort((a, b) => b.impactScore - a.impactScore);

  if (options?.limit) {
    return tasks.slice(0, options.limit);
  }

  return tasks;
}
