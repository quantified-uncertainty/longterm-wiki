/**
 * Types for the Epoch AI benchmark ingestion pipeline.
 */

/** A single row parsed from an Epoch benchmark CSV file */
export interface EpochBenchmarkRow {
  /** Raw model version string from Epoch CSV (e.g. "claude-sonnet-4-6_32K") */
  modelVersion: string;
  /** Numeric score (the primary benchmark metric) */
  score: number;
  /** Release/publication date string (e.g. "2026-02-17") */
  releaseDate: string | null;
  /** Organization name (e.g. "Anthropic") */
  organization: string | null;
}

/** Metadata about an Epoch benchmark CSV file */
export interface EpochBenchmarkFile {
  /** Filename without extension (e.g. "gpqa_diamond") */
  filename: string;
  /** Our benchmark slug if mapped, null if unknown */
  benchmarkSlug: string | null;
  /** Total rows parsed */
  rowCount: number;
  /** Parsed rows */
  rows: EpochBenchmarkRow[];
}

/** Result of matching an Epoch model version to our entity */
export interface ModelMatch {
  /** Epoch model version string */
  epochModelVersion: string;
  /** Our entity slug (e.g. "claude-sonnet-4-6") */
  entitySlug: string;
  /** Our entity stableId (e.g. "sid_Au1yMEZYWQ") */
  stableId: string;
}

/** A benchmark result ready for sync to wiki-server */
export interface PreparedBenchmarkResult {
  id: string;
  benchmarkId: string;
  modelId: string;
  score: number;
  unit: string | null;
  date: string | null;
  sourceUrl: string | null;
  notes: string | null;
}

/** Summary statistics for an ingestion run */
export interface IngestSummary {
  /** Total CSV files processed */
  filesProcessed: number;
  /** CSV files that mapped to our benchmarks */
  filesMapped: number;
  /** CSV files with no matching benchmark slug */
  filesUnmapped: number;
  /** Total rows parsed across all files */
  totalRows: number;
  /** Rows that matched to both a benchmark and a model */
  matchedResults: number;
  /** Rows where the model could not be mapped */
  unmatchedModelRows: number;
  /** Distinct unmatched model version strings */
  unmatchedModels: string[];
  /** Unmapped benchmark filenames */
  unmappedBenchmarks: string[];
  /** Per-benchmark breakdown */
  perBenchmark: Array<{
    benchmarkSlug: string;
    filename: string;
    totalRows: number;
    matchedRows: number;
  }>;
}
