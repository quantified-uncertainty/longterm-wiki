/**
 * Human-readable column description overlay for entity-profile.
 *
 * Only columns where the snake_case name isn't self-explanatory need entries.
 * Schema metadata (type, nullability, etc.) is auto-derived from Drizzle.
 */
export const COLUMN_DESCRIPTIONS: Record<string, Record<string, string>> = {
  entities: {
    id: "Entity slug (URL-safe identifier)",
    stable_id: "10-char stable ID used as FK across tables",
    numeric_id: "E-code (e.g. E42) for wiki page URLs",
    custom_fields: "Arbitrary label/value pairs for entity-specific data",
    related_entries: "Typed relationships to other entities",
  },
  personnel: {
    person_entity_id: "FK to entities.stable_id for the person",
    org_entity_id: "FK to entities.stable_id for the organization",
    person_id: "Legacy: display name or entity ID (pre-migration)",
    organization_id: "Legacy: display name or entity ID (pre-migration)",
    role_type: "key-person | board | career",
    is_founder: "Whether this person founded the organization",
    appointed_by: "Board seats only: who appointed this member",
  },
  grants: {
    org_entity_id: "FK to entities.stable_id for the grantor",
    grantee_entity_id: "FK to entities.stable_id for the recipient",
    program_id: "Soft ref to funding_programs.id",
    amount: "Funding amount in specified currency (NUMERIC)",
  },
  funding_rounds: {
    company_entity_id: "FK to entities.stable_id for the company",
    lead_investor_entity_id: "FK to entities.stable_id for the lead investor",
    raised: "Capital raised (USD, NUMERIC)",
    valuation: "Post-money valuation (USD, NUMERIC)",
    instrument: "equity | convertible-note | strategic-partnership | founding",
  },
  investments: {
    company_entity_id: "FK to entities.stable_id for the company",
    investor_entity_id: "FK to entities.stable_id for the investor",
    stake_acquired: "Pre-dilution stake (text, may be a range)",
    role: "lead | participant | founder",
  },
  equity_positions: {
    company_entity_id: "FK to entities.stable_id for the company",
    holder_entity_id: "FK to entities.stable_id for the holder",
    stake: "Post-dilution equity stake (text, may be a range)",
    as_of: "When this position was valid from",
    valid_end: "When this position expired",
  },
  divisions: {
    parent_org_id: "FK to entities.stable_id for the parent org (SET NULL on delete)",
    division_type: "fund | team | department | lab | program-area",
  },
  division_personnel: {
    division_id: "FK to divisions.id (CASCADE on delete)",
    person_id: "FK to entities.stable_id for the person (SET NULL on delete)",
  },
  funding_programs: {
    org_id: "Org stableId (10-char)",
    division_id: "FK to divisions.id (nullable)",
    program_type: "rfp | grant-round | fellowship | prize | solicitation | call",
    total_budget: "Total budget in specified currency (NUMERIC)",
  },
  benchmark_results: {
    benchmark_id: "FK to benchmarks.id",
    model_id: "Entity slug of the ai-model",
  },
  facts: {
    entity_id: "FK to entities.stable_id",
    fact_id: "Unique fact identifier within the entity",
    measure: "Timeseries grouping key",
    subject: "FK to entities.stable_id for comparative facts",
    format_divisor: "Divisor for formatted display (e.g. 1e9 for billions)",
  },
  things: {
    parent_thing_id: "FK to things.id (self-referencing hierarchy)",
    source_table: "Which PG table this thing originated from",
    source_id: "PK in the source table",
  },
  wiki_pages: {
    slug: "URL-safe page identifier",
    integer_id: "Phase 4a migration integer PK",
    content_plaintext: "Full page text (for search)",
    coverage_items: "JSONB map of coverage check results",
    synced_from_branch: "Git branch this data was synced from",
  },
  research_area_organizations: {
    research_area_id: "FK to research_areas.id",
    organization_id: "Entity stableId or slug",
    role: "pioneer | active | major | funder | emerging",
  },
};
