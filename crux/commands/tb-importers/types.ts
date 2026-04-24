/**
 * Shared types for T1 importers (QUA-640).
 *
 * Each importer fetches from an authoritative source, extracts deterministic
 * records, and emits `EnrichmentProposal` payloads that will be POSTed to
 * `POST /api/enrichment/propose` (QUA-632) with `tier=T1`.
 *
 * Until QUA-632 lands, the propose-client is a stub that writes JSON to disk
 * for inspection — the contract here is the wire format.
 */

/** Tier model from QUA-637 umbrella. */
export type EnrichmentTier = "T1" | "T2" | "T3";

/**
 * Record types this PR's importers produce. Values MUST match the sync-route
 * mount names (plural kebab-case) in
 * `apps/wiki-server/src/routes/tablebase/mount-registry.ts` — the propose
 * endpoint dispatches on these strings, and dashboards read them verbatim.
 */
export type EnrichmentRecordType =
  | "funding-rounds"
  | "personnel"
  | "benchmark-results"
  | "publication"
  | "organization-fact";

/**
 * One record proposal. The propose endpoint validates `(source, recordType)`
 * against the T1 authority allowlist and, if accepted, atomically writes:
 *   - the row into the target table
 *   - an evidence row (source URL + response hash)
 *   - a `confirmed` verdict
 */
export interface EnrichmentProposal {
  /** Tier for this proposal. T1 importers always emit "T1". */
  tier: EnrichmentTier;
  /** Authoritative source identifier, e.g. "sec-edgar:0001577552-25-000123". */
  source: string;
  /** URL the data was fetched from — written to the evidence row. */
  sourceUrl: string;
  /** SHA-256 hex of the canonical fetched payload — written to evidence. */
  responseHash: string;
  /** Target tablebase record type. */
  recordType: EnrichmentRecordType;
  /**
   * The record fields. Shape depends on `recordType`.
   *
   * NOTE: this is the *enrichment proposal*, not a fully-formed PG row.
   * The propose endpoint (QUA-632) is responsible for:
   *   - Minting the record `id` (10-char primary key)
   *   - Resolving `entityRefs` into entity stableIds (FK columns)
   *   - Populating any required fields the importer doesn't know
   *
   * The importer's job is to emit deterministic, source-derived fields:
   *   - funding-round: name, date, raised, instrument, source, notes,
   *     companyDisplayName
   *   - personnel:     role, roleType, personDisplayName, orgDisplayName,
   *     source, notes, isFounder
   *   - benchmark-result: score, unit, date, sourceUrl, notes
   *   - publication:    title, doi, publishedDate, venue, authors,
   *     publicationType, url, notes
   *   - organization-fact: property, value, valueType, source, notes
   */
  record: Record<string, unknown>;
  /**
   * Optional foreign-key resolution hints. When present, the propose endpoint
   * will resolve display names to entity stableIds before writing the row.
   */
  entityRefs?: {
    /** Slug or display name of the org the record belongs to. */
    organization?: string;
    /** Slug or display name of the person (personnel only). */
    person?: string;
    /** Slug or display name of the AI model (benchmark-result only). */
    model?: string;
    /** Benchmark id (benchmark-result only). */
    benchmark?: string;
  };
}

/** Result of submitting one proposal — populated by the propose endpoint. */
export interface ProposeResult {
  proposal: EnrichmentProposal;
  status: "accepted" | "rejected" | "pending";
  /** Server-side row id when accepted. */
  recordId?: string;
  /** Human-readable rejection reason when rejected. */
  reason?: string;
}
