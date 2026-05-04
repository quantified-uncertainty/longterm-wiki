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

/**
 * Per-source detail captured during verification. One CandidateRecord per
 * URL the pipeline considered for a record — both rejected and accepted —
 * so reports can be triaged after the fact without re-running the search.
 *
 * Both judges' observations are stored when the dual-judge wrapper is
 * enabled; vLLM fields are null when it's disabled or unreachable. The
 * Haiku-side fields drive every accept/reject and DB write; the vLLM
 * fields exist only for offline comparison.
 */
export interface CandidateRecord {
  url: string;
  provider?: string;
  title?: string;
  decision: 'accepted' | 'rejected';
  /** Set when decision === 'rejected'. */
  rejection_reason: string | null;
  /** Slots the entity-mention check reported as missing (debug aid). */
  missing_slots?: string[][];
  /** sha256 of the exact page text passed to the judges. The text itself is
   *  written under that hash to BACKFILL_CONTENT_CACHE_DIR (default
   *  `dev/backfill-content-cache/`) so any candidate can be replayed
   *  byte-for-byte after the run. Null when no LLM call was made (cheap
   *  pre-checks rejected the candidate before content ever reached a model). */
  content_sha256: string | null;
  /** Length of the page text passed to the judges (chars). */
  content_chars: number | null;
  /** Quote-extraction stage observations. Both judges saw the same prompt
   *  (built from claim + entity + content); raw responses captured verbatim. */
  quote_extraction: {
    haiku: {
      raw_text: string;
      quotes: string[];
      duration_ms: number;
    };
    vllm: {
      raw_text: string;
      quotes: string[];
      verified_quotes: string[];
      duration_ms: number;
    } | null;
    /** The subset of haiku.quotes that actually appear verbatim in the page. */
    haiku_verified_quotes: string[];
  } | null;
  /** Entailment stage observations. Only populated when quote-extraction
   *  produced verbatim quotes (otherwise verification rejected before this
   *  stage). The verified_quotes that drove this call are reproducible from
   *  the quote_extraction.haiku_verified_quotes field. */
  entailment: {
    sonnet: {
      raw_text: string;
      supports: boolean;
      duration_ms: number;
    };
    vllm: {
      raw_text: string;
      decision: 'supports' | 'no-support' | 'unparseable';
      duration_ms: number;
    } | null;
  } | null;
}

/**
 * YAML write outcome for one record's dual-write mirror.
 *
 *   wrote            — source: <url> appended to the right entity in YAML
 *   skipped-existing — entity/stakeholder already had a non-empty source
 *   not-found        — entity/stakeholder couldn't be located in YAML
 *   no-yaml-target   — entity sid wasn't in the index (legacy thing: file)
 *   not-applicable   — record's table isn't YAML-mirrored (no write needed)
 *   error            — read or write IO failure (see error string)
 */
export type YamlWriteStatusReport =
  | 'wrote'
  | 'skipped-existing'
  | 'not-found'
  | 'no-yaml-target'
  | 'not-applicable'
  | 'error';

export interface YamlWriteRecordReport {
  status: YamlWriteStatusReport;
  filepath: string | null;
  error?: string;
}

/** Per-record outcome captured for the summary + JSON report. */
export type Outcome =
  | {
      kind: 'matched';
      url: string;
      provider?: string;
      quotes?: string[];
      updated?: boolean;
      yaml_write?: YamlWriteRecordReport;
      cost: CostBreakdown;
      candidates: CandidateRecord[];
    }
  | { kind: 'no-match'; reason: string; cost: CostBreakdown; candidates: CandidateRecord[] }
  | { kind: 'skipped'; reason: string };

export interface RecordOutcome {
  record: MissingSourceRecord;
  outcome: Outcome;
}
