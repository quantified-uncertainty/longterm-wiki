/**
 * Core types for the TableBase enrichment system.
 */

export const TASK_TYPES = [
  "grant-grantee-backfill",
  "personnel-enrichment",
  "funding-round-research",
  "investment-linking",
  "benchmark-result-fill",
] as const;

export type TaskType = (typeof TASK_TYPES)[number];

/** Weight multipliers for task type impact scoring */
export const TASK_TYPE_WEIGHTS: Record<TaskType, number> = {
  "personnel-enrichment": 1.5,
  "grant-grantee-backfill": 1.2,
  "funding-round-research": 1.0,
  "benchmark-result-fill": 1.0,
  "investment-linking": 0.8,
};

/** Per-entity completeness metrics for a single table */
export interface TableProfile {
  entityId: string;
  entityName: string;
  entityType: string;
  table: string;
  totalRecords: number;
  completenessPercent: number;
  /** Specific fields that are missing or incomplete */
  missingFields: string[];
}

/** A ranked enrichment task to be executed by an LLM agent */
export interface EnrichmentTask {
  /** Deterministic ID based on taskType + entityId */
  id: string;
  taskType: TaskType;
  entityId: string;
  entityName: string;
  entityType: string;
  table: string;
  impactScore: number;
  reasons: string[];
  existingRecordCount: number;
}

/** Result of running an LLM agent on a single enrichment task */
export interface TaskResult {
  taskId: string;
  recordsCreated: number;
  recordsUpdated: number;
  durationMs: number;
  cost: number;
  sources: string[];
}

/** Aggregate scan results for a table across all entities */
export interface TableScanResult {
  table: string;
  totalEntities: number;
  entitiesWithRecords: number;
  totalRecords: number;
  avgCompleteness: number;
  profiles: TableProfile[];
}

/** Summary of a full scan across all tables */
export interface ScanSummary {
  tables: TableScanResult[];
  timestamp: string;
}

/** Options for the loop orchestrator */
export interface LoopOptions {
  maxTasks: number;
  budgetDollars: number;
  dryRun: boolean;
  taskTypes?: TaskType[];
  entityTypes?: string[];
}
