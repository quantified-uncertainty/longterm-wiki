/**
 * Shared types for T1 importers (QUA-640, wired in QUA-665).
 *
 * Each importer fetches from an authoritative source, extracts deterministic
 * records, and emits `EnrichmentProposal` payloads that are POSTed to
 * `POST /api/enrichment/propose` (QUA-632) with `tier=T1`.
 *
 * The propose-client translates these proposals into the endpoint's
 * `ProposeRequestSchema` (see `propose-client.ts::buildProposeRequest`).
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
  /**
   * SHA-256 hex of the canonical fetched payload — written to evidence.
   * MUST be pure lowercase hex (no `sha256:` prefix) because the
   * propose-client derives `row.id` from `responseHash[:10]` and that
   * derivation expects hex-only input.
   */
  responseHash: string;
  /** Target tablebase record type. */
  recordType: EnrichmentRecordType;
  /**
   * The record fields. Shape depends on `recordType`.
   *
   * The importer emits deterministic, source-derived fields:
   *   - funding-rounds:     name, date, raised, instrument, source, notes,
   *                         companyDisplayName
   *   - personnel:          role, roleType, personDisplayName, orgDisplayName,
   *                         source, notes, isFounder
   *   - benchmark-results:  score, unit, date, sourceUrl, notes
   *   - publication:        title, doi, publishedDate, venue, authors,
   *                         publicationType, url, notes
   *   - organization-fact:  property, value, valueType, source, notes
   *
   * `propose-client.ts::buildProposeRequest` mints the 10-char `row.id` from
   * `responseHash[:10]` and merges `entityRefs` into the correct FK column
   * names before POSTing. Downstream entity-FK resolution (slug → stableId)
   * happens in each sync handler's `resolveEntityFKs` step.
   */
  record: Record<string, unknown>;
  /**
   * Optional foreign-key resolution hints. `buildProposeRequest` maps these
   * to the sync schema's FK columns:
   *   - funding-rounds:     organization → companyId
   *   - personnel:          organization → organizationId, person → personId
   *   - benchmark-results:  model → modelId, benchmark → benchmarkId
   */
  entityRefs?: {
    /** Slug or display name of the org the record belongs to. */
    organization?: string;
    /** Slug or display name of the person (personnel only). */
    person?: string;
    /** Slug or display name of the AI model (benchmark-results only). */
    model?: string;
    /** Benchmark id (benchmark-results only). */
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
