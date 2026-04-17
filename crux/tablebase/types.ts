/**
 * Core types for the TableBase enrichment system.
 */

/** Convert a display name to a URL-safe slug. Transliterates Unicode (e.g. ü→u). */
export function toSlug(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining diacritical marks (ü→u, ñ→n, etc.)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

export const TASK_TYPES = [
  "grant-grantee-backfill",
  "personnel-enrichment",
  "funding-round-research",
  "investment-linking",
  "benchmark-result-fill",
  "source-discovery",
  "division-lead-fill",
  "division-personnel-dates",
  "funding-program-enrichment",
  "benchmark-source-fill",
] as const;

export type TaskType = (typeof TASK_TYPES)[number];

/** Weight multipliers for task type impact scoring */
export const TASK_TYPE_WEIGHTS: Record<TaskType, number> = {
  "personnel-enrichment": 1.5,
  "source-discovery": 1.3,
  "division-lead-fill": 1.3,
  "grant-grantee-backfill": 1.2,
  "funding-round-research": 1.0,
  "benchmark-result-fill": 1.0,
  "funding-program-enrichment": 1.0,
  "division-personnel-dates": 0.9,
  "benchmark-source-fill": 0.9,
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
  /** Entity website URL (for team page scraping) */
  website?: string;
  /** Reader importance score 0-100 from page rankings */
  entityImportance?: number;
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
  /** Entity website URL (for team page scraping) */
  website?: string;
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

export type FieldColumnType = 'string' | 'number' | 'date' | 'url' | 'enum' | 'boolean' | 'id' | 'list';

/** Per-field NULL/empty/"n/a" statistics for a single column */
export interface FieldGapStat {
  field: string;
  columnType: FieldColumnType;
  total: number;
  nullCount: number;
  emptyCount: number;
  naCount: number;
  nullPct: number;
  emptyPct: number;
  naPct: number;
  /** Combined nullPct + emptyPct + naPct (clamped to 100). */
  gapPct: number;
  /** Up to 3 row IDs where the field is missing — useful for enrichment triage */
  sampleMissingRows: string[];
}

/** Field-gap report for a single table */
export interface FieldGapReport {
  table: string;
  totalRows: number;
  /** Sorted by gapPct descending (biggest gaps first) */
  fields: FieldGapStat[];
}

/** Summary of a full scan across all tables */
export interface ScanSummary {
  tables: TableScanResult[];
  /** Populated only when the scan was invoked with --fields */
  fieldReports?: FieldGapReport[];
  timestamp: string;
}

/** Options for the loop orchestrator */
export interface LoopOptions {
  maxTasks: number;
  budgetDollars: number;
  dryRun: boolean;
  taskTypes?: TaskType[];
  entityTypes?: string[];
  /** Override the LLM model (e.g., "haiku", "sonnet", "opus"). Default: sonnet. */
  model?: string;
  /** Skip sourcing before submitting records */
  skipSourcing?: boolean;
}

/**
 * Recommended model per task type, optimized for cost vs quality.
 * Simple structured lookups → haiku; complex research → sonnet.
 */
export const TASK_TYPE_RECOMMENDED_MODEL: Record<TaskType, string> = {
  "benchmark-result-fill": "haiku",
  "investment-linking": "haiku",
  "funding-round-research": "haiku",
  "grant-grantee-backfill": "sonnet",
  "personnel-enrichment": "sonnet",
  "source-discovery": "sonnet",
  "division-lead-fill": "sonnet",
  "division-personnel-dates": "haiku",
  "funding-program-enrichment": "haiku",
  "benchmark-source-fill": "haiku",
};
