/**
 * Shared types for the backfill-sources pipeline.
 */

/** A record returned by the missing-sources endpoint. */
export interface MissingSourceRecord {
  record_id: string;
  record_table: string;
  entity_id: string | null;
  entity_name: string;
  description: string;
  /** Table-specific fields (value, label, person_name, etc.) used downstream. */
  [key: string]: unknown;
}

export interface MissingSourcesResponse {
  tables: Record<string, { total: number; records: MissingSourceRecord[] }>;
  totalMissing: number;
}

/** A source that passed the verification pipeline and is ranking-eligible. */
export interface RankCandidate {
  url: string;
  snippet: string;
  provider?: string;
  /** Verbatim quotes from the page that support the claim. */
  quotes?: string[];
}

/** Per-stage USD cost breakdown for one record. */
export interface CostBreakdown {
  /** Perplexity / Exa / SCRY search calls. */
  searchCost: number;
  /** Haiku fact-extraction inside runResearch (0 when extractFacts: false). */
  factExtractionCost: number;
  /** Haiku per-source supporting-quote extraction. */
  quoteExtractCost: number;
  /** Sonnet per-quote entailment verification. */
  entailmentCost: number;
  /** Haiku ranking of multi-candidate matches. */
  rankCost: number;
}

/** Per-record outcome captured for the summary + JSON report. */
export type Outcome =
  | { kind: 'matched'; url: string; provider?: string; quotes?: string[]; updated?: boolean; cost: CostBreakdown }
  | { kind: 'no-match'; reason: string; cost: CostBreakdown }
  | { kind: 'skipped'; reason: string };

export interface RecordOutcome {
  record: MissingSourceRecord;
  outcome: Outcome;
}
