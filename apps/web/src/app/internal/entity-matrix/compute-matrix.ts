/**
 * Entity Matrix — Server-side data loading
 *
 * Reads entity-matrix.json generated at build time by
 * crux/entity-matrix/generate.ts. This avoids importing
 * crux scanner code directly (which uses .ts extension imports
 * incompatible with the Next.js TypeScript config).
 */

import fs from "fs";
import path from "path";

// Types duplicated here to avoid importing from crux (which uses .ts extensions)
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
  detection: string;
  valueType: string;
  importance: number;
}

export interface CellValue {
  raw: number | boolean | string | null;
  score: number;
  details?: string;
}

export interface EntityTypeMeta {
  id: string;
  label: string;
  tier: string;
  directoryRoute?: string;
  profileRoute?: string;
}

export interface EntityTypeRow {
  entityType: string;
  label: string;
  tier: "canonical" | "sub-entity";
  cells: Record<string, CellValue>;
  aggregateScore: number;
  groupScores: Record<string, number>;
  sampleEntityId?: string;
}

export interface MatrixSnapshot {
  generatedAt: string;
  entityTypes: EntityTypeMeta[];
  dimensions: DimensionDef[];
  dimensionGroups: DimensionGroupMeta[];
  rows: EntityTypeRow[];
  overallScore: number;
  groupAverages: Record<string, number>;
  dimensionAverages: Record<string, number>;
}

const DATA_DIR = path.resolve(process.cwd(), "src/data");

let _cached: MatrixSnapshot | null = null;

export function getMatrixSnapshot(): MatrixSnapshot {
  if (!_cached) {
    const filePath = path.join(DATA_DIR, "entity-matrix.json");
    if (!fs.existsSync(filePath)) {
      // Return empty snapshot if file doesn't exist (e.g., dev mode without prebuild)
      return {
        generatedAt: new Date().toISOString(),
        entityTypes: [],
        dimensions: [],
        dimensionGroups: [],
        rows: [],
        overallScore: 0,
        groupAverages: {},
        dimensionAverages: {},
      };
    }
    _cached = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  }
  return _cached!;
}
