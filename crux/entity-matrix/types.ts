/**
 * Entity Completeness Matrix — Type Definitions
 *
 * Defines the structure for tracking infrastructure completeness
 * across all entity and sub-entity types in the wiki.
 */

// ============================================================================
// DIMENSION TYPES
// ============================================================================

export type DetectionMethod = "filesystem" | "build-data" | "api" | "manual";
export type ValueType = "boolean" | "count" | "percentage" | "enum";

export type DimensionGroup =
  | "data-foundation"
  | "data-pipeline"
  | "api"
  | "ui-discovery"
  | "ui-detail"
  | "content"
  | "quality"
  | "testing";

export interface DimensionGroupMeta {
  id: DimensionGroup;
  label: string;
  shortLabel: string;
}

export interface DimensionDef {
  id: string;
  label: string;
  group: DimensionGroup;
  description: string;
  detection: DetectionMethod;
  valueType: ValueType;
  /** Weight for aggregate scoring (1-10). Higher = more important. */
  importance: number;
}

// ============================================================================
// ENTITY TYPE METADATA
// ============================================================================

export type EntityTier = "canonical" | "sub-entity";

export interface EntityTypeMeta {
  id: string;
  label: string;
  tier: EntityTier;
  /** Route segment for directory page (e.g., "organizations") */
  directoryRoute?: string;
  /** Route segment for profile page (e.g., "organizations/[slug]") */
  profileRoute?: string;
  /** Table component file name without extension (e.g., "organizations-table") */
  tableComponent?: string;
  /** Wiki-server route file name (e.g., "grants") */
  apiRouteFile?: string;
  /** YAML file name in data/entities/ (e.g., "organizations") */
  yamlFile?: string;
  /** Full YAML path relative to project root (for data outside data/entities/) */
  yamlPath?: string;
  /** Subdirectory in content/docs/ for MDX pages */
  contentDir?: string;
  /** DB table name in wiki-server schema */
  dbTable?: string;
  /** Count data as another entity type (e.g., legislation → policy) */
  countsAsType?: string;
  /** Key in database.json for non-entity data (e.g., "publications") */
  buildDataKey?: string;
}

// ============================================================================
// CELL & ROW TYPES
// ============================================================================

export interface CellValue {
  /** Raw detected value */
  raw: number | boolean | string | null;
  /** Normalized score: 0-100, or -1 for N/A */
  score: number;
  /** Human-readable explanation of what was detected */
  details?: string;
}

export interface EntityTypeRow {
  entityType: string;
  label: string;
  tier: EntityTier;
  cells: Record<string, CellValue>;
  /** Weighted average of all applicable dimension scores */
  aggregateScore: number;
  /** Average score per dimension group */
  groupScores: Record<string, number>;
  /** Sample entity numericId (e.g., "E42") for quick navigation */
  sampleEntityId?: string;
  /** Sample entity slug for directory-style URLs */
  sampleEntitySlug?: string;
}

// ============================================================================
// MATRIX SNAPSHOT
// ============================================================================

export interface MatrixSnapshot {
  generatedAt: string;
  entityTypes: EntityTypeMeta[];
  dimensions: DimensionDef[];
  dimensionGroups: DimensionGroupMeta[];
  rows: EntityTypeRow[];
  /** Overall system completeness (0-100) */
  overallScore: number;
  /** Average score per dimension group across all types */
  groupAverages: Record<string, number>;
  /** Average score per dimension across all types */
  dimensionAverages: Record<string, number>;
}
