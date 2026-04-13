import {
  pgTable,
  pgSequence,
  text,
  varchar,
  integer,
  bigint,
  serial,
  bigserial,
  boolean,
  real,
  doublePrecision,
  numeric,
  date,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ============================================================================
// TableBase — Entity catalog tables
//
// These tables mirror the YAML entity/resource catalog (data/entities/,
// data/resources/). YAML files remain authoritative; PG tables are
// queryable read mirrors for the API.
//
// See: content/docs/internal/data-architecture.mdx for the full naming guide.
// ============================================================================

export const entityIdSeq = pgSequence("entity_id_seq", { startWith: 1 });

export const entityIds = pgTable("entity_ids", {
  wikiId: integer("wiki_id").primaryKey(),
  slug: text("slug").notNull().unique(),
  stableId: text("stable_id").unique(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const citationQuotes = pgTable(
  "citation_quotes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    pageId: integer("page_id")
      .notNull()
      .references(() => wikiPages.id),
    footnote: integer("footnote").notNull(),
    url: text("url"),
    resourceId: text("resource_id").references(() => resources.id, {
      onDelete: "set null",
    }),
    claimText: text("claim_text").notNull(),
    claimContext: text("claim_context"),
    sourceQuote: text("source_quote"),
    sourceLocation: text("source_location"),
    quoteVerified: boolean("quote_verified").notNull().default(false),
    verificationMethod: text("verification_method"),
    verificationScore: real("verification_score"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    sourceTitle: text("source_title"),
    sourceType: text("source_type"),
    extractionModel: text("extraction_model"),
    /** @deprecated FK to claims was dropped by migration 0065 (claims table archived). Column kept for data. */
    claimId: bigint("claim_id", { mode: "number" }),
    accuracyVerdict: text("accuracy_verdict"),
    accuracyIssues: text("accuracy_issues"),
    accuracyScore: real("accuracy_score"),
    accuracyCheckedAt: timestamp("accuracy_checked_at", {
      withTimezone: true,
    }),
    accuracySupportingQuotes: text("accuracy_supporting_quotes"),
    verificationDifficulty: text("verification_difficulty"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("citation_quotes_page_id_footnote_unique").on(
      table.pageId,
      table.footnote
    ),
    index("idx_cq_page_id").on(table.pageId),
    index("idx_cq_url").on(table.url),
    index("idx_cq_verified").on(table.quoteVerified),
    index("idx_cq_accuracy").on(table.accuracyVerdict),
    index("idx_cq_resource_id").on(table.resourceId),
    index("idx_cq_claim_id").on(table.claimId),
  ]
);

// ============================================================================
// WikiBase — Prose content tables
//
// These tables mirror the MDX wiki pages (content/docs/). MDX files remain
// authoritative; PG is a queryable mirror for full-text search and metadata.
// ============================================================================

export const wikiPages = pgTable(
  "wiki_pages",
  {
    id: integer("id").primaryKey(),
    wikiId: text("wiki_id"),
    slug: text("slug").notNull().unique(),
    title: text("title").notNull(),
    description: text("description"),
    summary: text("summary"),
    category: text("category"),
    subcategory: text("subcategory"),
    entityType: text("entity_type"),
    tags: text("tags"),
    quality: integer("quality"),
    readerImportance: integer("reader_importance"),
    researchImportance: integer("research_importance"),
    tacticalValue: integer("tactical_value"),
    backlinkCount: integer("backlink_count"),
    riskCategory: text("risk_category"),
    dateCreated: text("date_created"),
    recommendedScore: real("recommended_score"),
    clusters: jsonb("clusters").$type<string[]>(),
    hallucinationRiskLevel: text("hallucination_risk_level"),
    hallucinationRiskScore: integer("hallucination_risk_score"),
    contentPlaintext: text("content_plaintext"),
    wordCount: integer("word_count"),
    lastUpdated: text("last_updated"),
    contentFormat: text("content_format"),
    // Build metrics: coverage
    coveragePassing: integer("coverage_passing"),
    coverageTotal: integer("coverage_total"),
    coverageItems: jsonb("coverage_items").$type<Record<string, 'green' | 'amber' | 'red'>>(),
    // Build metrics: update schedule
    updateFrequency: integer("update_frequency"),
    daysSinceUpdate: integer("days_since_update"),
    daysUntilDue: integer("days_until_due"),
    staleness: real("staleness"),
    updatePriority: real("update_priority"),
    // Build metrics: rankings
    readerRank: integer("reader_rank"),
    researchRank: integer("research_rank"),
    // search_vector tsvector column is managed via raw SQL migration
    // (Drizzle doesn't have native tsvector support)
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    syncedFromBranch: text("synced_from_branch"),
    syncedFromCommit: text("synced_from_commit"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_wp_wiki_id").on(table.wikiId),
    index("idx_wp_category").on(table.category),
    index("idx_wp_entity_type").on(table.entityType),
    index("idx_wp_reader_importance").on(table.readerImportance),
    index("idx_wp_recommended_score").on(table.recommendedScore),
    // GIN index on search_vector is created in migration SQL
  ]
);

// ============================================================================
// Operational — Citation & sourcing tables
//
// These tables are not part of any Base. They track citation sourcing,
// fetched source content, accuracy scoring, and hallucination risk.
// ============================================================================

export const citationContent = pgTable(
  "citation_content",
  {
    url: text("url").primaryKey(),
    /** Matched resource ID from data/resources/*.yaml — links fetched content to curated metadata. */
    resourceId: text("resource_id"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    httpStatus: integer("http_status"),
    contentType: text("content_type"),
    pageTitle: text("page_title"),
    fullTextPreview: text("full_text_preview"),
    fullText: text("full_text"),
    contentLength: integer("content_length"),
    contentHash: text("content_hash"),
    /** How the content was fetched: firecrawl, built-in, youtube-transcript, abstract */
    fetchMethod: text("fetch_method"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_cc_fetched_at").on(table.fetchedAt),
    index("idx_cc_http_status").on(table.httpStatus),
    index("idx_cc_resource_id").on(table.resourceId),
  ]
);

/**
 * Resource Content Versions — unified append-only content history for ALL resources.
 *
 * Stores every fetched version of resource content (web pages, CSVs, HTML tables,
 * JSON API responses, etc.) with content-hash dedup. The existing `citation_content`
 * table remains as a "latest content" hot cache for fast lookups — this table adds
 * temporal depth.
 *
 * Replaces the old split between `citation_content` (web pages, overwritten) and
 * `source_snapshots` (tabular data, versioned). Both content types now go here.
 *
 * Subtype-specific metadata (e.g., pageTitle for web pages, recordCount for tabular
 * sources) is stored in the `metadata` JSONB column.
 */
export const resourceContentVersions = pgTable(
  "resource_content_versions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    resourceId: text("resource_id").references(() => resources.id, {
      onDelete: "set null",
    }),
    url: text("url").notNull(),
    contentHash: text("content_hash").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    content: text("content"),
    contentLength: integer("content_length"),
    httpStatus: integer("http_status"),
    contentType: text("content_type"),
    fetchMethod: text("fetch_method"),
    /** Subtype-specific metadata: {pageTitle, fullTextPreview} for web pages,
     *  {recordCount, mappingValid, parserVersion, notes} for tabular sources */
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_rcv_url_hash").on(table.url, table.contentHash),
    index("idx_rcv_url_fetched").on(table.url, table.fetchedAt),
    index("idx_rcv_resource_id").on(table.resourceId),
    index("idx_rcv_fetched_at").on(table.fetchedAt),
  ]
);

export const citationAccuracySnapshots = pgTable(
  "citation_accuracy_snapshots",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    pageId: integer("page_id").references(() => wikiPages.id),
    totalCitations: integer("total_citations").notNull(),
    checkedCitations: integer("checked_citations").notNull(),
    accurateCount: integer("accurate_count").notNull().default(0),
    minorIssuesCount: integer("minor_issues_count").notNull().default(0),
    inaccurateCount: integer("inaccurate_count").notNull().default(0),
    unsupportedCount: integer("unsupported_count").notNull().default(0),
    notVerifiableCount: integer("not_verifiable_count").notNull().default(0),
    averageScore: real("average_score"),
    snapshotAt: timestamp("snapshot_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_cas_page_id").on(table.pageId),
    index("idx_cas_snapshot_at").on(table.snapshotAt),
  ]
);

export const editLogs = pgTable(
  "edit_logs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    pageId: integer("page_id").references(() => wikiPages.id),
    date: date("date").notNull(),
    tool: text("tool").notNull(),
    agency: text("agency").notNull(),
    requestedBy: text("requested_by"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_el_page_id").on(table.pageId),
    index("idx_el_date").on(table.date),
    index("idx_el_tool").on(table.tool),
  ]
);

export const hallucinationRiskSnapshots = pgTable(
  "hallucination_risk_snapshots",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    pageId: integer("page_id").references(() => wikiPages.id, {
      onDelete: "cascade",
    }),
    score: integer("score").notNull(),
    level: text("level").notNull(), // 'low' | 'medium' | 'high'
    factors: jsonb("factors").$type<string[]>(),
    integrityIssues: jsonb("integrity_issues").$type<string[]>(),
    computedAt: timestamp("computed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_hrs_page_id").on(table.pageId),
    index("idx_hrs_computed_at").on(table.computedAt),
    index("idx_hrs_level").on(table.level),
  ]
);

export const sessions = pgTable(
  "sessions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    date: date("date").notNull(),
    branch: text("branch"),
    title: text("title").notNull(),
    summary: text("summary"),
    model: text("model"),
    duration: text("duration"),
    cost: text("cost"),
    costCents: integer("cost_cents"),
    durationMinutes: real("duration_minutes"),
    prUrl: text("pr_url"),
    checksYaml: text("checks_yaml"),
    issuesJson: jsonb("issues_json"),
    learningsJson: jsonb("learnings_json"),
    recommendationsJson: jsonb("recommendations_json"),
    reviewed: boolean("reviewed"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_sess_date_title").on(table.date, table.title),
    index("idx_sess_date").on(table.date),
    index("idx_sess_branch").on(table.branch),
  ]
);

export const sessionPages = pgTable(
  "session_pages",
  {
    sessionId: bigint("session_id", { mode: "number" })
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    pageId: integer("page_id")
      .notNull()
      .references(() => wikiPages.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.pageId] }),
    index("idx_sp_page_id").on(table.pageId),
  ]
);

export const autoUpdateRuns = pgTable(
  "auto_update_runs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    date: date("date").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    trigger: text("trigger").notNull(),
    budgetLimit: real("budget_limit"),
    budgetSpent: real("budget_spent"),
    sourcesChecked: integer("sources_checked"),
    sourcesFailed: integer("sources_failed"),
    itemsFetched: integer("items_fetched"),
    itemsRelevant: integer("items_relevant"),
    pagesPlanned: integer("pages_planned"),
    pagesUpdated: integer("pages_updated"),
    pagesFailed: integer("pages_failed"),
    pagesSkipped: integer("pages_skipped"),
    newPagesCreated: text("new_pages_created"),
    detailsJson: jsonb("details_json"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_aur_date").on(table.date),
    index("idx_aur_trigger").on(table.trigger),
    uniqueIndex("idx_aur_started_at_unique").on(table.startedAt),
  ]
);

export const autoUpdateResults = pgTable(
  "auto_update_results",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: bigint("run_id", { mode: "number" })
      .notNull()
      .references(() => autoUpdateRuns.id, { onDelete: "cascade" }),
    pageId: integer("page_id").references(() => wikiPages.id),
    status: text("status").notNull(),
    tier: text("tier"),
    durationMs: integer("duration_ms"),
    errorMessage: text("error_message"),
  },
  (table) => [
    index("idx_aures_run_id").on(table.runId),
    index("idx_aures_page_id").on(table.pageId),
    index("idx_aures_status").on(table.status),
  ]
);

export const summaries = pgTable(
  "summaries",
  {
    entityId: text("entity_id")
      .primaryKey()
      .references(() => entities.stableId, { onDelete: "cascade" }),
    entityType: text("entity_type").notNull(),
    oneLiner: text("one_liner"),
    summary: text("summary"),
    review: text("review"),
    keyPoints: jsonb("key_points").$type<string[]>(),
    keyClaims: jsonb("key_claims").$type<string[]>(),
    model: text("model"),
    tokensUsed: integer("tokens_used"),
    generatedAt: timestamp("generated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_sum_entity_type").on(table.entityType),
    index("idx_sum_model").on(table.model),
    index("idx_sum_generated_at").on(table.generatedAt),
  ]
);

/** Claims extracted from wiki pages. */
/**
 * Claims extracted from wiki pages.
 *
 * `entityId` is the primary entity this claim was extracted from (page or data entity).
 * `relatedEntities` is a JSONB array of other entity IDs this claim relates to,
 * enabling claims to be independent of a single page.
 *
 * Claim taxonomy:
 *   claimType: granular type (factual, evaluative, causal, historical, numeric, consensus, speculative, relational)
 *   claimCategory: high-level category (factual, opinion, analytical, speculative, relational)
 *
 * Integration with other data layers:
 *   factId: links numeric claims to data/facts/ entries (e.g. "anthropic.6796e194")
 *   resourceIds: JSONB array of resource IDs from data/resources/ backing this claim
 *
 * Legacy columns (value, unit) are retained for backward compatibility but
 * new code should use section instead.
 * footnoteRefs is also legacy — new code should use claim_page_references table.
 */
/** @archived Migration 0065 renamed this table to _archived_claims. Schema kept for citationQuotes.claimId FK reference. */
export const claims = pgTable(
  "_archived_claims",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    entityId: text("entity_id") // primary entity (extraction source)
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    entityType: text("entity_type").notNull(),
    claimType: text("claim_type").notNull(),
    claimText: text("claim_text").notNull(),
    // @deprecated — legacy text fields; use valueNumeric/valueLow/valueHigh + measure instead.
    // Still written for backward compat but not read by new code paths.
    value: text("value"),
    unit: text("unit"),
    /** @deprecated Use claimVerdict instead. Kept for backward compatibility. */
    confidence: text("confidence"),
    /** @deprecated Use claim_sources table instead. Kept for backward compat (double-write). */
    sourceQuote: text("source_quote"),
    // --- Enhanced fields (migration 0028) ---
    claimCategory: text("claim_category"), // factual | opinion | analytical | speculative | relational
    relatedEntities: jsonb("related_entities"), // string[] — other entity IDs this claim relates to
    factId: text("fact_id"), // link to facts system: "entity.factKey" (e.g. "anthropic.6796e194")
    resourceIds: jsonb("resource_ids"), // string[] — resource IDs from data/resources/
    section: text("section"), // section heading where claim appears
    /** @deprecated Use claim_page_references table instead. Kept for backward compat. */
    footnoteRefs: text("footnote_refs"), // comma-separated footnote refs (e.g. "1,3,7")
    // --- Phase 2 fields (migration 0029) ---
    claimMode: text("claim_mode").notNull().default("endorsed"), // 'endorsed' | 'attributed'
    attributedTo: text("attributed_to"), // entity_id of person/org making the claim
asOf: text("as_of"),                // temporal index: YYYY-MM or YYYY-MM-DD
    measure: text("measure"),           // measure ID linking to facts taxonomy
    valueNumeric: doublePrecision("value_numeric"), // central numeric value (machine-readable)
    valueLow: doublePrecision("value_low"),        // lower bound for range values
    valueHigh: doublePrecision("value_high"),      // upper bound for range values
    // --- Verdict fields (migration 0031) ---
    claimVerdict: text("claim_verdict"),
    claimVerdictScore: real("claim_verdict_score"),
    claimVerdictIssues: text("claim_verdict_issues"),
    claimVerdictQuotes: text("claim_verdict_quotes"),
    claimVerdictDifficulty: text("claim_verdict_difficulty"),
    claimVerifiedAt: timestamp("claim_verified_at", { withTimezone: true }),
    claimVerdictModel: text("claim_verdict_model"),
    // --- Structured claims fields (migration 0032) ---
    subjectEntity: text("subject_entity"),         // entity_id this claim is about (e.g. "anthropic")
    property: text("property"),                    // property from controlled vocabulary (e.g. "funding_round_amount")
    structuredValue: text("structured_value"),      // normalized value (e.g. "30000000")
    valueUnit: text("value_unit"),                 // unit of measurement (e.g. "USD", "percent", "count")
    valueDate: date("value_date"),                 // when the value was true/measured
    qualifiers: jsonb("qualifiers").$type<Record<string, string>>(), // additional context (e.g. {"round": "Series B"})
    // --- Reasoning traces (migration 0034) ---
    inferenceType: text("inference_type"),  // direct_assertion | derived | aggregated | interpreted | editorial
    // --- Pinned claims (migration 0034) ---
    isPinned: boolean("is_pinned").notNull().default(false), // canonical value for <F> components
    // --- Timestamps ---
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_cl_entity_id").on(table.entityId),
    index("idx_cl_entity_type").on(table.entityType),
    index("idx_cl_claim_type").on(table.claimType),
    index("idx_cl_claim_category").on(table.claimCategory),
    index("idx_cl_fact_id").on(table.factId),
    index("idx_cl_claim_mode").on(table.claimMode),
    index("idx_cl_attributed_to").on(table.attributedTo),
    index("idx_cl_as_of").on(table.asOf),
    index("idx_cl_measure").on(table.measure),
    index("idx_cl_verdict").on(table.claimVerdict),
    index("idx_cl_verified_at").on(table.claimVerifiedAt),
    index("idx_cl_subject_entity").on(table.subjectEntity),
    index("idx_cl_property").on(table.property),
    index("idx_cl_subject_property").on(table.subjectEntity, table.property),
    index("idx_cl_inference_type").on(table.inferenceType),
    // GIN index on relatedEntities is created in migration 0028
    // (Drizzle doesn't support GIN index declarations on JSONB)
  ]
);

/**
 * Claim sources — join table linking claims to their supporting resources.
 *
 * Each row represents one resource backing a claim.
 * Replaces the JSONB resource_ids array with proper relational rows,
 * enabling per-source quotes, primary source flags, and JOIN queries.
 *
 * claim_mode on the parent claim tells you whether the wiki endorses the claim
 * or is attributing it to another entity (e.g., "Anthropic claims that...").
 */
/** @archived Migration 0065 renamed this table to _archived_claim_sources. */
export const claimSources = pgTable(
  "_archived_claim_sources",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    claimId: bigint("claim_id", { mode: "number" })
      .notNull()
      .references(() => claims.id, { onDelete: "cascade" }),
    resourceId: text("resource_id").references(() => resources.id, {
      onDelete: "set null",
    }),
    url: text("url"), // fallback if resourceId not known
    sourceQuote: text("source_quote"), // exact excerpt supporting the claim
    isPrimary: boolean("is_primary").notNull().default(false),
    addedAt: timestamp("added_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // --- Verdict fields (migration 0031) ---
    sourceVerdict: text("source_verdict"),
    sourceVerdictScore: real("source_verdict_score"),
    sourceVerdictIssues: text("source_verdict_issues"),
    sourceCheckedAt: timestamp("source_checked_at", { withTimezone: true }),
    // --- Metadata fields (migration 0037) ---
    sourceTitle: text("source_title"),
    sourceType: text("source_type"),
    sourceLocation: text("source_location"),
  },
  (table) => [
    index("idx_cs_claim_id").on(table.claimId),
    index("idx_cs_resource_id").on(table.resourceId),
    index("idx_cs_is_primary").on(table.isPrimary),
    index("idx_cs_source_verdict").on(table.sourceVerdict),
  ]
);

/** Claim-to-page references — links a claim to every wiki page it appears on. */
/** @archived Migration 0065 renamed this table to _archived_claim_page_references. */
export const claimPageReferences = pgTable(
  "_archived_claim_page_references",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    claimId: bigint("claim_id", { mode: "number" })
      .notNull()
      .references(() => claims.id, { onDelete: "cascade" }),
    pageId: integer("page_id")
      .references(() => wikiPages.id, { onDelete: "cascade" }),
    footnote: integer("footnote"),
    section: text("section"),
    // --- Phase 3 fields (migration 0033) ---
    quoteText: text("quote_text"),
    referenceId: varchar("reference_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_cpr_claim_id").on(table.claimId),
    index("idx_cpr_page_id").on(table.pageId),
    // The real unique constraint is a COALESCE-based expression index in
    // migration 0031_unify_claims_citations.sql:
    //   CREATE UNIQUE INDEX idx_cpr_claim_page_footnote
    //     ON claim_page_references (claim_id, page_id, COALESCE(footnote, -1));
    // Drizzle doesn't support expression indexes, so we declare a plain
    // index here for query-planning awareness only.
    index("idx_cpr_claim_page_footnote").on(
      table.claimId,
      table.pageId,
    ),
  ]
);

export const resources = pgTable(
  "resources",
  {
    id: text("id").primaryKey(),
    url: text("url").notNull(),
    title: text("title"),
    type: text("type"),
    summary: text("summary"),
    review: text("review"),
    abstract: text("abstract"),
    keyPoints: jsonb("key_points").$type<string[]>(),
    publicationId: text("publication_id"),
    authors: jsonb("authors").$type<string[]>(),
    /** Entity stableIds of matched authors (linked by crux people link-resources) */
    authorEntityIds: jsonb("author_entity_ids").$type<string[]>(),
    publishedDate: date("published_date"),
    tags: jsonb("tags").$type<string[]>(),
    localFilename: text("local_filename"),
    credibilityOverride: real("credibility_override"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }),
    contentHash: text("content_hash"),
    stableId: text("stable_id").unique(),
    /** HTTP reachability of the resource URL.
     *  Values: ok | dead | soft_404 | not_found | timeout | unreachable | paywall | error.
     *  Written by resource-ingest and source-fetcher after each fetch attempt.
     *  UI should use isDeadFetchStatus() to detect broken links.
     *  Distinct from enrichmentStatus which tracks the LLM pipeline stage. */
    fetchStatus: text("fetch_status"),
    lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),
    /** Wayback Machine archive URL for this resource */
    archiveUrl: text("archive_url"),
    /** Stance for legislation coverage: support, oppose, neutral, mixed, analysis */
    stance: text("stance"),
    /** Short context note: "Foundational alignment paper from Anthropic" */
    contextNote: text("context_note"),
    /** High-level purpose: homepage, primary_source, commentary, dataset, tool */
    resourcePurpose: text("resource_purpose"),
    /** Fine-grained subtype: arxiv_preprint, blog_post, executive_order, etc. */
    resourceSubtype: text("resource_subtype"),
    /** Type-specific metadata for web pages, media, misc (JSONB bag) */
    typeMetadata: jsonb("type_metadata").$type<Record<string, unknown>>(),
    /** Authoring org entity stableId (distinct from publicationId which is the venue) */
    publisherEntityId: text("publisher_entity_id"),
    /** Entity stableIds this resource is about (approach, concept, policy, org entities) */
    relatedEntityIds: jsonb("related_entity_ids").$type<string[]>(),
    /** LLM enrichment pipeline stage: pending | fetched | classified | enriched | reviewed.
     *  Tracks how far a resource has progressed through classify/enrich/review.
     *  Written by fetch-all, classify, enrich, enrich-papers, enrich-crossref, resource-enrich.
     *  Distinct from fetchStatus which tracks HTTP reachability of the URL. */
    enrichmentStatus: text("enrichment_status"),
    /** When enrichment pipeline last ran */
    enrichmentDate: timestamp("enrichment_date", { withTimezone: true }),
    /** Computed composite importance score 0-1 */
    importanceScore: real("importance_score"),
    /** How content behaves over time: immutable | versioned | evergreen | ephemeral */
    contentLifecycle: text("content_lifecycle"),
    // search_vector tsvector column is managed via raw SQL migration
    // (Drizzle doesn't have native tsvector support)
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_res_url").on(table.url),
    index("idx_res_type").on(table.type),
    index("idx_res_publication_id").on(table.publicationId),
    index("idx_res_created_at").on(table.createdAt),
    index("idx_res_enrichment_status").on(table.enrichmentStatus),
    index("idx_res_importance_score").on(table.importanceScore),
    index("idx_res_publisher_entity_id").on(table.publisherEntityId),
    index("idx_res_resource_purpose").on(table.resourcePurpose),
    index("idx_res_resource_subtype").on(table.resourceSubtype),
    index("idx_res_content_lifecycle").on(table.contentLifecycle),
    // GIN indexes on tags, authors, related_entity_ids, and search_vector
    // are created in migration SQL (Drizzle doesn't support GIN index declarations)
  ]
);

export const resourceCitations = pgTable(
  "resource_citations",
  {
    resourceId: text("resource_id")
      .notNull()
      .references(() => resources.id, { onDelete: "cascade" }),
    pageId: integer("page_id")
      .notNull()
      .references(() => wikiPages.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.resourceId, table.pageId] }),
    index("idx_rc_page_id").on(table.pageId),
  ]
);

// ── Resource sub-tables ───────────────────────────────────────────────

/** Type-specific metadata for academic papers (~800-2,000 resources). */
export const resourcePapers = pgTable("resource_papers", {
  resourceId: text("resource_id")
    .primaryKey()
    .references(() => resources.id, { onDelete: "cascade" }),
  arxivId: text("arxiv_id"),
  doi: text("doi"),
  semanticScholarId: text("semantic_scholar_id"),
  abstract: text("abstract"),
  citationCount: integer("citation_count"),
  influentialCitationCount: integer("influential_citation_count"),
  categories: jsonb("categories").$type<string[]>(),
  methodology: text("methodology"),
  year: integer("year"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_rp_arxiv_id").on(table.arxivId),
  index("idx_rp_doi").on(table.doi),
  index("idx_rp_semantic_scholar_id").on(table.semanticScholarId),
  index("idx_rp_year").on(table.year),
]);

/** Type-specific metadata for forum posts (~400-1,200 resources). */
export const resourceForumPosts = pgTable("resource_forum_posts", {
  resourceId: text("resource_id")
    .primaryKey()
    .references(() => resources.id, { onDelete: "cascade" }),
  forum: text("forum").notNull(),
  forumPostId: text("forum_post_id"),
  forumSlug: text("forum_slug"),
  karma: integer("karma"),
  commentCount: integer("comment_count"),
  authorUsername: text("author_username"),
  forumTags: jsonb("forum_tags").$type<string[]>(),
  sequenceTitle: text("sequence_title"),
  curated: boolean("curated"),
  crossPostedFrom: text("cross_posted_from"),
  canonicalForum: text("canonical_forum"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_rfp_forum").on(table.forum),
  index("idx_rfp_forum_post_id").on(table.forumPostId),
  index("idx_rfp_cross_posted_from").on(table.crossPostedFrom),
]);

/** Type-specific metadata for policy/government documents (~100-300 resources). */
export const resourcePolicyDocs = pgTable("resource_policy_docs", {
  resourceId: text("resource_id")
    .primaryKey()
    .references(() => resources.id, { onDelete: "cascade" }),
  documentType: text("document_type"),
  jurisdictionEntityId: text("jurisdiction_entity_id"),
  agencyEntityId: text("agency_entity_id"),
  policyEntityId: text("policy_entity_id"),
  effectiveDate: text("effective_date"),
  documentStatus: text("document_status"),
  referenceNumber: text("reference_number"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_rpd_jurisdiction").on(table.jurisdictionEntityId),
  index("idx_rpd_agency").on(table.agencyEntityId),
  index("idx_rpd_policy").on(table.policyEntityId),
  index("idx_rpd_document_type").on(table.documentType),
]);

/**
 * Type-specific metadata for tabular data sources (~16 resources).
 *
 * Follows the resourcePapers/resourceForumPosts/resourcePolicyDocs sub-table pattern.
 * Stores import-pipeline configuration (column mappings, schemas, sourcing config)
 * for structured data sources (CSVs, HTML tables, JSON APIs, spreadsheets).
 *
 * The `sourceSlug` preserves the human-readable identifier (e.g., 'coefficient-giving')
 * from the old `data_sources.id` column. The resource's URL is the fetch URL or a
 * synthetic URN for URL-less sources ('urn:lw:tabular-source:<slug>').
 *
 * Intentionally omits lastSnapshotAt, snapshotRecordCount, latestSnapshotHash —
 * these are denormalized caches derivable from source_snapshots/resource_content_versions.
 * The old data_sources table had them; they should not be re-added here.
 *
 * Part of: Unify Data Sources into Resources (Discussion #3567, PR 2/5).
 */
export const resourceTabularSources = pgTable("resource_tabular_sources", {
  resourceId: text("resource_id")
    .primaryKey()
    .references(() => resources.id, { onDelete: "cascade" }),
  /** Human-readable slug (was data_sources.id, e.g. 'coefficient-giving') */
  sourceSlug: text("source_slug").notNull().unique(),
  /** csv | html_table | json_api | spreadsheet */
  dataFormat: text("data_format").notNull(),
  /** direct_download | api_endpoint | web_scrape | manual_export */
  accessMethod: text("access_method").notNull(),
  /** grant | personnel | investment | publication | mixed */
  recordType: text("record_type").notNull(),
  /** static | weekly | monthly | quarterly | annual */
  updateFrequency: text("update_frequency"),
  /** Maps source column names to internal field names */
  columnMapping: jsonb("column_mapping").$type<Record<string, string>>(),
  /** Frictionless-inspired field descriptions */
  sourceSchema: jsonb("source_schema").$type<Record<string, unknown>>(),
  /** { strategy, matchFields, fuzzyFields, exactFields } */
  /** Source-check verification strategy. Shape: { strategy, matchFields?, fuzzyFields?, exactFields? }. Issue #4017 B5. */
  verificationConfig: jsonb("verification_config").$type<{
    strategy: string;
    matchFields?: string[];
    fuzzyFields?: string[];
    exactFields?: string[];
    [key: string]: unknown;
  }>(),
  /** active | archived | defunct */
  sourceStatus: text("source_status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Source Snapshots ─────────────────────────────────────────────────

/**
 * Source Snapshots — permanent storage of raw source content (CSV text, HTML, JSON).
 *
 * Snapshots are never deleted. Content-hash dedup prevents storing identical
 * snapshots via UNIQUE(source_slug, snapshot_hash). At ~1-3MB per snapshot
 * across 14 grant sources, storage is negligible (~728MB/year at weekly cadence).
 *
 * source_slug references resource_tabular_sources.source_slug (the human-readable
 * slug like "coefficient-giving"). The old data_sources table was dropped in 0161.
 */
export const sourceSnapshots = pgTable("source_snapshots", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  /** Human-readable slug referencing resource_tabular_sources.source_slug */
  sourceSlug: text("source_slug").notNull()
    .references(() => resourceTabularSources.sourceSlug, { onDelete: "cascade" }),
  /** Resource ID from unified resources table */
  resourceId: text("resource_id").references(() => resources.id, { onDelete: "set null" }),
  snapshotHash: text("snapshot_hash").notNull(),
  recordCount: integer("record_count"),
  /** Raw CSV/HTML/JSON text — the ground truth. Parsed on-demand. */
  rawContent: text("raw_content").notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  /** False if expected columns were missing during snapshot capture */
  mappingValid: boolean("mapping_valid").notNull().default(true),
  /** Tracks which parser version produced this snapshot */
  parserVersion: text("parser_version"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_ss_source_slug").on(table.sourceSlug),
  index("idx_ss_resource_id").on(table.resourceId),
  index("idx_ss_fetched_at").on(table.fetchedAt),
  uniqueIndex("idx_ss_dedup").on(table.sourceSlug, table.snapshotHash),
]);

// ── TableBase: Entity catalog (continued) ─────────────────────────────

/**
 * Entities — read mirror of data/entities/*.yaml files (TableBase).
 *
 * Stores the full entity metadata (type, title, description, tags, etc.)
 * synced from the YAML source files during build. YAML stays authoritative;
 * this table is a queryable read mirror for the API.
 *
 * Naming note: "entities" in this table refers to YAML catalog entries
 * (orgs, people, risks, concepts). This is distinct from FactBase "entities"
 * which have their own 10-char IDs in packages/factbase/data/things/.
 */
export const entities = pgTable(
  "entities",
  {
    id: text("id").notNull().unique(), // slug — kept unique for URL resolution
    wikiId: text("wiki_id"),
    stableId: text("stable_id").notNull().primaryKey(), // stableId is the PK
    entityType: text("entity_type").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    website: text("website"),
    tags: jsonb("tags").$type<string[]>(),
    clusters: jsonb("clusters").$type<string[]>(),
    status: text("status"),
    lastUpdated: text("last_updated"),
    customFields: jsonb("custom_fields").$type<
      Array<{ label: string; value: string; link?: string }>
    >(),
    relatedEntries: jsonb("related_entries").$type<
      Array<{ id: string; type: string; relationship?: string }>
    >(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // search_vector tsvector column is managed via raw SQL migration 0120
    // (Drizzle doesn't have native tsvector support)
  },
  (table) => [
    index("idx_ent_wiki_id").on(table.wikiId),
    index("idx_ent_entity_type").on(table.entityType),
    index("idx_ent_title").on(table.title),
    // GIN index on search_vector + trigram index on title created in migration SQL
  ]
);

// ── FactBase: Structured facts mirror ─────────────────────────────────

/**
 * Facts — read mirror of FactBase YAML (packages/factbase/data/things/).
 *
 * Stores individual facts tied to entities, including timeseries data
 * (grouped by measure). PG is the authoritative source for facts;
 * YAML is synced here and the build pipeline reads from PG.
 *
 * Naming note: "facts" in this table are FactBase structured triples. This
 * is distinct from the legacy data/facts/*.yaml system (which is deprecated
 * for entities covered by FactBase). See data-system-authority.mdx.
 */
export const facts = pgTable(
  "facts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    entityId: text("entity_id")
      .notNull()
      .references(() => entities.stableId, { onDelete: "cascade" }),
    factId: text("fact_id").notNull(),
    label: text("label"),
    value: text("value"), // String representation of the value
    numeric: real("numeric"), // Parsed numeric value (null for non-numeric)
    low: real("low"), // Lower bound for range values
    high: real("high"), // Upper bound for range values
    asOf: text("as_of"), // Point-in-time (YYYY-MM, YYYY, or ISO date)
    validEnd: text("valid_end"), // Expiry date — fact was true until this date
    currency: text("currency"), // Currency code for monetary values (default: USD)
    measure: text("measure"), // Measure ID for timeseries grouping
    subject: text("subject").references(() => entities.stableId, {
      onDelete: "set null",
    }),
    note: text("note"),
    source: text("source"), // URL to source
    format: text("format"),
    formatDivisor: real("format_divisor"),
    sourceQuote: text("source_quote"),
    usdEquivalent: real("usd_equivalent"),
    exchangeRate: real("exchange_rate"),
    exchangeRateDate: text("exchange_rate_date"),
    dollarYear: integer("dollar_year"),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_facts_entity_fact").on(table.entityId, table.factId),
    index("idx_facts_entity_id").on(table.entityId),
    index("idx_facts_measure").on(table.measure),
    index("idx_facts_as_of").on(table.asOf),
    index("idx_facts_subject").on(table.subject),
  ]
);

/**
 * Page links — stores directional links between entities/pages.
 *
 * Populated during build-data sync. Each row represents a signal that
 * source_id relates to target_id, with a link_type indicating the origin
 * of the signal and an optional relationship label.
 *
 * Used to compute backlinks (reverse lookup) and the related-pages graph
 * (weighted aggregation across all link types).
 */
export const pageLinks = pgTable(
  "page_links",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sourceId: integer("source_id").references(() => wikiPages.id),
    targetId: integer("target_id").references(() => wikiPages.id),
    linkType: text("link_type").notNull(), // 'yaml_related' | 'entity_link' | 'name_prefix' | 'similarity' | 'shared_tag'
    relationship: text("relationship"), // e.g. 'causes', 'mitigates' — only for yaml_related
    weight: real("weight").notNull().default(1.0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("page_links_source_target_unique").on(
      table.sourceId,
      table.targetId,
      table.linkType
    ),
    index("idx_pl_source_id").on(table.sourceId),
    index("idx_pl_target_id").on(table.targetId),
    index("idx_pl_link_type").on(table.linkType),
  ]
);

/**
 * Agent sessions — tracks active Claude Code sessions and their checklist state.
 *
 * Each row represents a single agent session (identified by branch name).
 * The checklist Markdown is stored as text and updated as the session progresses.
 * This replaces the previous pattern of committing `.claude/wip-checklist.md` to git.
 */
export const agentSessions = pgTable(
  "agent_sessions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    branch: text("branch").notNull(),
    task: text("task").notNull(),
    sessionType: text("session_type").notNull(),
    issueNumber: integer("issue_number"),
    checklistMd: text("checklist_md").notNull(),
    worktree: text("worktree"), // working directory path for collision detection
    prUrl: text("pr_url"), // PR URL recorded when crux issues done --pr=URL is called
    prOutcome: text("pr_outcome"), // Outcome: merged | merged_with_revisions | reverted | closed_without_merge
    fixesPrUrl: text("fixes_pr_url"), // URL of the PR this session is fixing (enables fix-chain tracking)
    // Session log fields — written at session end via sync-session (replaces sessions table for agent workflow)
    date: date("date"),
    title: text("title"), // final session title (PR title-style), distinct from task (checklist description)
    summary: text("summary"),
    model: text("model"),
    duration: text("duration"),
    durationMinutes: real("duration_minutes"),
    cost: text("cost"),
    costCents: integer("cost_cents"),
    checksYaml: text("checks_yaml"),
    issuesJson: jsonb("issues_json"),
    learningsJson: jsonb("learnings_json"),
    recommendationsJson: jsonb("recommendations_json"),
    reviewed: boolean("reviewed"),
    status: text("status").notNull().default("active"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_as_branch").on(table.branch),
    index("idx_as_status").on(table.status),
    index("idx_as_issue").on(table.issueNumber),
    index("idx_as_started_at").on(table.startedAt),
    index("idx_as_date").on(table.date),
  ]
);

export const agentSessionPages = pgTable(
  "agent_session_pages",
  {
    agentSessionId: bigint("agent_session_id", { mode: "number" })
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    pageId: integer("page_id")
      .notNull()
      .references(() => wikiPages.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.agentSessionId, table.pageId] }),
    index("idx_asp_page_id").on(table.pageId),
    index("idx_asp_agent_session_id").on(table.agentSessionId),
  ]
);

/**
 * Tracks which entities (by stableId) each agent session touched.
 * Mirrors agentSessionPages but for entities instead of wiki pages.
 */
export const agentSessionEntities = pgTable(
  "agent_session_entities",
  {
    agentSessionId: bigint("agent_session_id", { mode: "number" })
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    entityStableId: text("entity_stable_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.agentSessionId, table.entityStableId] }),
    index("idx_ase_entity_stable_id").on(table.entityStableId),
    // PK (agent_session_id, entity_stable_id) covers single-column lookups on agent_session_id
  ]
);

/**
 * Auto-update news items — individual news items discovered during auto-update runs.
 *
 * Each item represents a news article/post found by the feed fetcher, enriched with
 * LLM-based relevance scoring and optional routing to a wiki page.
 */
export const autoUpdateNewsItems = pgTable(
  "auto_update_news_items",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: bigint("run_id", { mode: "number" })
      .notNull()
      .references(() => autoUpdateRuns.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    url: text("url").notNull(),
    sourceId: text("source_id").notNull(),
    publishedAt: text("published_at"),
    summary: text("summary"),
    relevanceScore: integer("relevance_score"),
    topicsJson: jsonb("topics_json").$type<string[]>(),
    entitiesJson: jsonb("entities_json").$type<string[]>(),
    routedToPageId: integer("routed_to_page_id").references(() => wikiPages.id, {
      onDelete: "set null",
    }),
    routedToPageTitle: text("routed_to_page_title"),
    routedTier: text("routed_tier"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_auni_run_id").on(table.runId),
    index("idx_auni_source_id").on(table.sourceId),
    index("idx_auni_relevance").on(table.relevanceScore),
    index("idx_auni_routed_page_id").on(table.routedToPageId),
    index("idx_auni_published_at").on(table.publishedAt),
  ]
);

/**
 * Jobs — task queue for background job processing.
 *
 * Stores pending, running, completed, and failed jobs.
 * Workers (GHA workflows or local) claim jobs atomically via
 * SELECT FOR UPDATE SKIP LOCKED and report results back.
 */
/**
 * Page improve runs — intermediate data from V2 orchestrator and page-improver runs.
 *
 * Captures research sources, citation audits, cost tracking, section diffs, and
 * quality gate results so they can be queried, compared, and reused later.
 * See GitHub issue #826.
 */
export const pageImproveRuns = pgTable(
  "page_improve_runs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    pageId: integer("page_id").references(() => wikiPages.id),
    engine: text("engine").notNull(), // 'v1' | 'v2'
    tier: text("tier").notNull(), // 'polish' | 'standard' | 'deep'
    directions: text("directions"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    durationS: real("duration_s"),
    totalCost: real("total_cost"),

    // Research artifacts
    sourceCache: jsonb("source_cache"),
    researchSummary: text("research_summary"),

    // Citation audit artifacts
    citationAudit: jsonb("citation_audit"),

    // Cost tracking
    costEntries: jsonb("cost_entries"),
    costBreakdown: jsonb("cost_breakdown"),

    // Section-level diffs
    sectionDiffs: jsonb("section_diffs"),

    // Quality gate
    qualityMetrics: jsonb("quality_metrics"),
    qualityGatePassed: boolean("quality_gate_passed"),
    qualityGaps: jsonb("quality_gaps").$type<string[]>(),

    // Pipeline metadata
    toolCallCount: integer("tool_call_count"),
    refinementCycles: integer("refinement_cycles"),
    phasesRun: jsonb("phases_run").$type<string[]>(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_pir_page_id").on(table.pageId),
    index("idx_pir_engine").on(table.engine),
    index("idx_pir_started_at").on(table.startedAt),
    index("idx_pir_page_started").on(table.pageId, table.startedAt),
  ]
);

export const jobs = pgTable(
  "jobs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    type: text("type").notNull(),
    status: text("status").notNull().default("pending"),
    params: jsonb("params"),
    result: jsonb("result"),
    error: text("error"),
    priority: integer("priority").notNull().default(0),
    retries: integer("retries").notNull().default(0),
    maxRetries: integer("max_retries").notNull().default(3),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    workerId: text("worker_id"),
    runAfter: timestamp("run_after", { withTimezone: true }),
    dedupKey: text("dedup_key"),
    parentJobId: bigint("parent_job_id", { mode: "number" }),
    costUsd: numeric("cost_usd", { precision: 10, scale: 4 }),
  },
  (table) => [
    index("idx_jobs_status_priority").on(table.status, table.priority),
    index("idx_jobs_type_status").on(table.type, table.status),
    index("idx_jobs_created_at").on(table.createdAt),
  ]
);

/**
 * Page citations — regular (non-claim) footnote citations on wiki pages.
 *
 * Each row represents a citation that appears as a footnote on a page but is
 * not backed by a claim. The `referenceId` field provides a shared namespace
 * with `claim_page_references.reference_id` so the frontend can render both
 * claim-backed and regular citations in a unified footnote list.
 */
/**
 * Active agents — tracks currently-running Claude Code agents for coordination.
 *
 * Each row represents a live agent session. Agents register on start, push
 * status updates (current step, files touched, heartbeat), and pull the list
 * of other active agents to detect conflicts (same issue, overlapping files).
 *
 * Stale agents (no heartbeat for >30 min) can be auto-marked by a sweep.
 */
export const activeAgents = pgTable(
  "active_agents",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sessionId: text("session_id").notNull().unique(), // unique per invocation (branch name or UUID)
    sessionName: text("session_name"), // human-friendly name (e.g., "bright-falcon-quiet-river")
    branch: text("branch"),
    task: text("task").notNull(),
    status: text("status").notNull().default("active"), // active | completed | errored | stale
    currentStep: text("current_step"), // free-text: what the agent is doing right now
    issueNumber: integer("issue_number"),
    prNumber: integer("pr_number"),
    filesTouched: jsonb("files_touched").$type<string[]>(),
    model: text("model"),
    worktree: text("worktree"), // worktree path if running in isolation
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_aa_status").on(table.status),
    index("idx_aa_issue").on(table.issueNumber),
    index("idx_aa_heartbeat").on(table.heartbeatAt),
    index("idx_aa_started_at").on(table.startedAt),
    index("idx_aa_branch").on(table.branch),
  ]
);

/**
 * Agent session events — activity timeline for agent sessions.
 *
 * Each row is one event in an agent's session lifecycle (checklist check,
 * status update, error, free-form note, etc.). This provides a reconstructable
 * audit trail of what happened during a session — complementing the
 * `active_agents` table (which only stores the latest state) and the
 * `agent_sessions` table (which stores the final checklist snapshot).
 */
export const agentSessionEvents = pgTable(
  "agent_session_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    agentId: bigint("agent_id", { mode: "number" })
      .notNull()
      .references(() => activeAgents.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(), // registered | checklist_check | status_update | error | note | completed
    message: text("message").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    timestamp: timestamp("timestamp", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_ase_agent_id").on(table.agentId),
    index("idx_ase_event_type").on(table.eventType),
    index("idx_ase_timestamp").on(table.timestamp),
  ]
);

/**
 * Groundskeeper runs — task execution history from the groundskeeper daemon.
 *
 * Each row is one execution of a scheduled task (health-check, resolve-conflicts,
 * code-review, etc.). Replaces the local JSON run log with a server-side store
 * so the dashboard can visualize task history, uptime, and circuit breaker events.
 */
export const groundskeeperRuns = pgTable(
  "groundskeeper_runs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    taskName: text("task_name").notNull(),
    event: text("event").notNull(), // success | failure | error | circuit_breaker_tripped | circuit_breaker_reset | half_open_attempt | half_open_success | skipped
    success: boolean("success").notNull(),
    durationMs: integer("duration_ms"),
    summary: text("summary"),
    errorMessage: text("error_message"),
    consecutiveFailures: integer("consecutive_failures"),
    circuitBreakerActive: boolean("circuit_breaker_active").notNull().default(false),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    timestamp: timestamp("timestamp", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_gkr_task_name").on(table.taskName),
    index("idx_gkr_event").on(table.event),
    index("idx_gkr_timestamp").on(table.timestamp),
    index("idx_gkr_task_timestamp").on(table.taskName, table.timestamp),
  ]
);

export const serviceHealthIncidents = pgTable(
  "service_health_incidents",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    service: text("service").notNull(),
    severity: text("severity").notNull(),
    status: text("status").notNull().default("open"),
    title: text("title").notNull(),
    detail: text("detail"),
    detectedAt: timestamp("detected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: text("resolved_by"),
    checkSource: text("check_source"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    githubIssueNumber: integer("github_issue_number"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_shi_service").on(table.service),
    index("idx_shi_status").on(table.status),
    index("idx_shi_severity").on(table.severity),
    index("idx_shi_detected_at").on(table.detectedAt),
    index("idx_shi_service_status").on(table.service, table.status),
    uniqueIndex("idx_shi_open_service_title")
      .on(table.service, table.title)
      .where(sql`status = 'open'`),
  ]
);

// ============================================================================
// STATEMENTS SYSTEM — Phase 1 (#1540)
// ============================================================================

/**
 * Properties — controlled vocabulary for structured data.
 *
 * Each property defines a named attribute (e.g., "valuation", "headcount",
 * "ceo") that can be used in statements. Seeded from data/fact-measures.yaml.
 *
 * `unit_format_id` references a hardcoded TypeScript constant UNIT_FORMATS
 * in apps/web/src/lib/unit-formats.ts — not a DB table.
 */
export const properties = pgTable(
  "properties",
  {
    id: text("id").primaryKey(), // kebab-case: "valuation", "funding-round", "ceo"
    label: text("label").notNull(),
    category: text("category").notNull(), // financial, organizational, safety, performance, milestone, relation
    description: text("description"), // human-readable description of this property
    entityTypes: text("entity_types")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`), // ["organization"], ["person"], etc.
    valueType: text("value_type").notNull(), // "number", "string", "entity", "date"
    defaultUnit: text("default_unit"), // "USD", "percent", "count", "tokens", null
    stalenessCadence: text("staleness_cadence"), // "quarterly", "annually", null
    unitFormatId: text("unit_format_id"), // references UNIT_FORMATS TS constant
    rangeEntityTypes: text("range_entity_types").array(), // for entity-valued properties
    inversePropertyId: text("inverse_property_id"), // e.g., "parent-org" <-> "subsidiary"
    isSymmetric: boolean("is_symmetric").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_prop_category").on(table.category),
    index("idx_prop_value_type").on(table.valueType),
  ]
);

/**
 * Statements — all facts, structured + attributed varieties.
 *
 * Replaces the organic claims + facts YAML system with a clean, typed store
 * for discrete factual information about entities.
 *
 * Two varieties:
 * - **structured**: wiki-authored with a property from the controlled vocabulary,
 *   a typed value, and a subject entity. `valid_end IS NULL` = currently believed true.
 * - **attributed**: reports what a specific person/publication said.
 *   `attributed_to` is required. No structured value fields.
 *
 * `valid_start` / `valid_end` are text (not date) to support partial dates
 * like "2025", "2025-07", "2026-02" from YAML facts.
 */
/** @archived Migration 0065 renamed this table to _archived_statements. */
export const statements = pgTable(
  "_archived_statements",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    variety: text("variety").notNull(), // "structured" | "attributed"
    statementText: text("statement_text"), // free-text version of the statement (attributed variety)
    subjectEntityId: text("subject_entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    propertyId: text("property_id").references(() => properties.id, {
      onDelete: "set null",
    }),
    // --- Typed value columns (structured variety) ---
    valueNumeric: doublePrecision("value_numeric"),
    valueUnit: text("value_unit"), // e.g., "USD", "percent" — display hint
    valueText: text("value_text"),
    valueEntityId: text("value_entity_id").references(() => entities.id, {
      onDelete: "set null",
    }),
    valueDate: date("value_date"),
    valueSeries: jsonb("value_series"), // { low, high } for ranges
    qualifierKey: text("qualifier_key"), // e.g., "round:series-g"
    validStart: text("valid_start"), // "2026-02", "2025", ISO date
    validEnd: text("valid_end"), // null = currently believed true
    temporalGranularity: text("temporal_granularity"), // "year", "quarter", "month", "day"
    // --- Attribution (attributed variety) ---
    attributedTo: text("attributed_to").references(() => entities.id, {
      onDelete: "set null",
    }),
    // --- Verdict / sourcing ---
    verdict: text("verdict"), // "verified", "unsupported", "disputed", "unverified"
    verdictScore: real("verdict_score"), // 0–1 confidence
    verdictQuotes: text("verdict_quotes"), // external source quotes supporting verdict
    verdictModel: text("verdict_model"), // LLM model used for sourcing
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    claimCategory: text("claim_category"), // factual, opinion, analytical, speculative, relational
    // --- Metadata ---
    status: text("status").notNull().default("active"), // "active", "superseded", "retracted"
    archiveReason: text("archive_reason"), // why this statement was superseded/retracted
    sourceFactKey: text("source_fact_key"), // "anthropic.6796e194" — YAML migration traceability
    note: text("note"),
    // --- Quality scoring ---
    qualityScore: real("quality_score"), // 0–1 composite quality score
    qualityDimensions: jsonb("quality_dimensions"), // per-dimension scores { structure, precision, ... }
    scoredAt: timestamp("scored_at", { withTimezone: true }),
    // --- Timestamps ---
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_stmt_subject").on(table.subjectEntityId),
    index("idx_stmt_property").on(table.propertyId),
    index("idx_stmt_variety").on(table.variety),
    index("idx_stmt_status").on(table.status),
    index("idx_stmt_valid_start").on(table.validStart),
    index("idx_stmt_subject_property").on(
      table.subjectEntityId,
      table.propertyId
    ),
    index("idx_stmt_source_fact_key").on(table.sourceFactKey),
    index("idx_stmt_quality_score").on(table.qualityScore),
  ]
);

/**
 * Statement citations — links statements to source resources.
 *
 * Each row represents one resource backing a statement. Supports both
 * resource_id (linked to data/resources/) and raw URL fallback.
 */
/** @archived Migration 0065 renamed this table to _archived_statement_citations. */
export const statementCitations = pgTable(
  "_archived_statement_citations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    statementId: bigint("statement_id", { mode: "number" })
      .notNull()
      .references(() => statements.id, { onDelete: "cascade" }),
    resourceId: text("resource_id").references(() => resources.id, {
      onDelete: "set null",
    }),
    url: text("url"), // fallback if no resource
    sourceQuote: text("source_quote"),
    locationNote: text("location_note"),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_sc_statement_id").on(table.statementId),
    index("idx_sc_resource_id").on(table.resourceId),
    index("idx_sc_is_primary").on(table.isPrimary),
  ]
);

/** Statement-to-page references — links a statement to every wiki page it appears on. */
/** @archived Migration 0065 renamed this table to _archived_statement_page_references. */
export const statementPageReferences = pgTable(
  "_archived_statement_page_references",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    statementId: bigint("statement_id", { mode: "number" }).notNull().references(
      () => statements.id,
      { onDelete: "cascade" }
    ),
    pageId: integer("page_id").notNull().references(
      () => wikiPages.id,
      { onDelete: "cascade" }
    ),
    footnoteResourceId: varchar("footnote_resource_id"),
    section: text("section"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_spr_page").on(t.pageId),
    index("idx_spr_statement").on(t.statementId),
    uniqueIndex("idx_spr_stmt_page_footnote").on(t.statementId, t.pageId, t.footnoteResourceId),
  ]
);

/**
 * Entity coverage scores — tracks entity-level quality scoring history.
 *
 * Each row is a snapshot of an entity's overall statement quality at a point in time.
 */
/** @archived Migration 0065 renamed this table to _archived_entity_coverage_scores. */
export const entityCoverageScores = pgTable(
  "_archived_entity_coverage_scores",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    entityId: text("entity_id").notNull(),
    coverageScore: real("coverage_score").notNull(),
    categoryScores: jsonb("category_scores").notNull(), // { financial: 0.8, safety: 0.6, ... }
    statementCount: integer("statement_count").notNull(),
    qualityAvg: real("quality_avg"),
    scoredAt: timestamp("scored_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_ecs_entity_id").on(table.entityId),
    index("idx_ecs_scored_at").on(table.scoredAt),
  ]
);

export const pageCitations = pgTable(
  "page_citations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    referenceId: varchar("reference_id").notNull().unique(),
    pageId: integer("page_id").references(() => wikiPages.id),
    title: varchar("title"),
    url: varchar("url"),
    note: text("note"),
    resourceId: text("resource_id").references(() => resources.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_pc_page_id").on(table.pageId),
    index("idx_pc_reference_id").on(table.referenceId),
  ]
);

// ── Unified Source-Check System ──────────────────────────────────────────
//
// Two tables replace the previous six legacy sourcing tables
// (kb_fact_resource_*, record_*, thing_resource_* variants).
// See discussion #2950 for architecture decisions.

/**
 * Per-source check evidence — one row per source×claim check.
 *
 * Supports both row-level (fieldName=NULL) and cell-level (fieldName='amount')
 * sourcing for any record type (facts, grants, personnel, etc.).
 */
export const recordSources = pgTable(
  "source_check_evidence",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    recordType: text("record_type").notNull(), // 'fact', 'grant', 'personnel', 'investment', etc.
    recordId: text("record_id").notNull(), // PK in the source table
    fieldName: text("field_name"), // NULL = whole row, or specific column name
    entityId: text("entity_id"), // which entity this is about (for grouping/display)
    expectedValue: text("expected_value"), // what the record says
    resourceId: text("resource_id").references(() => resources.id, {
      onDelete: "set null",
    }),
    sourceUrl: text("source_url"), // direct URL
    extractedValue: text("extracted_value"), // what the source says
    extractedQuote: text("extracted_quote"), // relevant passage from source
    verdict: text("verdict").notNull(), // confirmed | contradicted | unverifiable | outdated | partial
    confidence: real("confidence"), // 0.0 to 1.0
    isPrimarySource: boolean("is_primary_source").notNull().default(false),
    checkerModel: text("checker_model"),
    notes: text("notes"),
    checkedAt: timestamp("checked_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_sce_record").on(table.recordType, table.recordId),
    index("idx_sce_entity").on(table.entityId),
    index("idx_sce_verdict").on(table.verdict),
    index("idx_sce_checked").on(table.checkedAt),
    // Dedup unique index: idx_sce_dedup on (record_type, record_id, COALESCE(source_url, ''), COALESCE(checker_model, ''))
    // Defined in migration 0135. COALESCE expressions require raw SQL, not Drizzle .on() syntax.
  ]
);

/**
 * Aggregate verdict per claim — one row per (recordType, recordId, fieldName).
 *
 * Derived from source_check_evidence. Separates evidence (per-source checks)
 * from conclusions (all-things-considered verdict).
 */
export const sourceVerdicts = pgTable(
  "source_check_verdicts",
  {
    recordType: text("record_type").notNull(),
    recordId: text("record_id").notNull(),
    fieldName: text("field_name"), // NULL = whole row verdict
    entityId: text("entity_id"), // for grouping/display
    /** Human-readable name for this record, persisted at write time (survives record deletion). */
    displayName: text("display_name"),
    /** Human-readable name for the parent entity, persisted at write time. */
    entityDisplayName: text("entity_display_name"),
    verdict: text("verdict").notNull(), // confirmed | contradicted | outdated | partial | unverifiable | unchecked
    confidence: real("confidence"),
    reasoning: text("reasoning"),
    sourcesChecked: integer("sources_checked").notNull().default(0),
    needsRecheck: boolean("needs_recheck").notNull().default(false),
    nextCheckDue: timestamp("next_check_due", { withTimezone: true }),
    lastComputedAt: timestamp("last_computed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // PK is (record_type, record_id, COALESCE(field_name, '')) defined in migration SQL
    index("idx_scv_verdict").on(table.verdict),
    index("idx_scv_recheck").on(table.needsRecheck),
    index("idx_scv_entity").on(table.entityId),
    index("idx_scv_type").on(table.recordType),
  ]
);

/**
 * Auto-suggested source URL candidates for records with an unverifiable verdict.
 *
 * When a sourcing verdict is `unverifiable` (source missing / doesn't cover the
 * claim), the `crux sourcing suggest-urls` command runs web search for the claim
 * and writes 1-3 candidate URLs here for human review or auto-recheck.
 *
 * Composite identity matches `source_check_verdicts`: (recordType, recordId, fieldName).
 */
export const sourcingUrlSuggestions = pgTable(
  "sourcing_url_suggestions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    recordType: text("record_type").notNull(),
    recordId: text("record_id").notNull(),
    fieldName: text("field_name"), // NULL = whole row
    entityId: text("entity_id"),
    suggestedUrl: text("suggested_url").notNull(),
    title: text("title"),
    snippet: text("snippet"),
    relevanceScore: real("relevance_score"), // 0..1, provider-supplied or heuristic
    sourceProvider: text("source_provider").notNull(), // exa | perplexity | scry | manual
    generatorModel: text("generator_model"),
    /** pending | approved | rejected | auto_verified */
    status: text("status").notNull().default("pending"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy: text("reviewed_by"), // agent session id or user handle
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_sus_record").on(table.recordType, table.recordId),
    index("idx_sus_entity").on(table.entityId),
    index("idx_sus_status").on(table.status),
    index("idx_sus_created").on(table.createdAt),
    // Unique (record_type, record_id, COALESCE(field_name, ''), suggested_url)
    // declared in migration SQL since COALESCE cannot be expressed in Drizzle .on().
    // CHECK (status IN ('pending','approved','rejected','auto_verified')) likewise in migration.
  ]
);

/**
 * Audit log for TableBase changes — records every insert/update/delete
 * to PG-primary tables (personnel, grants, funding_rounds, etc.).
 * Provides git-like change history for data that bypasses git.
 */
export const tablebaseAuditLog = pgTable(
  "tablebase_audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    recordType: text("record_type").notNull(),
    recordId: varchar("record_id", { length: 10 }).notNull(),
    operation: text("operation").notNull(), // 'insert', 'update', 'delete'
    oldData: jsonb("old_data"),
    newData: jsonb("new_data").notNull(),
    sourceUrl: text("source_url"),
    verdict: text("verdict"),
    evidence: text("evidence"),
    agentSessionId: text("agent_session_id"),
    prNumber: integer("pr_number"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_audit_log_record").on(table.recordType, table.recordId),
    index("idx_audit_log_created").on(table.createdAt),
    index("idx_audit_log_session").on(table.agentSessionId),
    index("idx_audit_log_type").on(table.recordType),
  ]
);

/**
 * Personnel — unified table covering key-persons, board-seats, and career-history.
 *
 * A single person connects to multiple organizations via different role types.
 * Uses TEXT for person/org references because some records reference display names
 * rather than entity IDs (e.g., board seats with non-entity members, career-history
 * with non-entity organizations like "D. E. Shaw Research").
 * When the reference is a known entity, the canonical 10-char entity ID is stored.
 */
export const personnel = pgTable(
  "personnel",
  {
    id: varchar("id", { length: 10 }).primaryKey(),
    personId: text("person_id").notNull(), // legacy: entity ID or display name (kept for migration compat)
    organizationId: text("organization_id").notNull(), // legacy: entity ID or free text (kept for migration compat)
    /** FK to entities.stable_id for the person. Null when unresolved. */
    personEntityId: text("person_entity_id").references(
      () => entities.stableId,
      { onDelete: "restrict" }
    ),
    /** Display name fallback when person doesn't have an entity. */
    personDisplayName: text("person_display_name"),
    /** FK to entities.stable_id for the organization. Null when unresolved. */
    orgEntityId: text("org_entity_id").references(
      () => entities.stableId,
      { onDelete: "restrict" }
    ),
    /** Display name fallback when org doesn't have an entity. */
    orgDisplayName: text("org_display_name"),
    role: text("role").notNull(), // job title or board role
    roleType: text("role_type").notNull(), // 'key-person' | 'board' | 'career'
    startDate: text("start_date"), // YYYY or YYYY-MM (flexible KB date format)
    endDate: text("end_date"), // YYYY or YYYY-MM; null if current
    isFounder: boolean("is_founder").notNull().default(false),
    appointedBy: text("appointed_by"), // board-seats only
    background: text("background"), // board-seats only
    source: text("source"), // URL confirming the role
    notes: text("notes"),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_personnel_person").on(table.personId),
    index("idx_personnel_org").on(table.organizationId),
    index("idx_personnel_person_entity").on(table.personEntityId),
    index("idx_personnel_org_entity").on(table.orgEntityId),
    index("idx_personnel_role_type").on(table.roleType),
    // Natural key uniqueness: prevents duplicate role assignments.
    // Partial index — only enforced when entity IDs are resolved (non-null).
    uniqueIndex("uq_personnel_natural_key")
      .on(table.personEntityId, table.orgEntityId, table.roleType, table.role)
      .where(
        sql`person_entity_id IS NOT NULL AND org_entity_id IS NOT NULL`
      ),
  ]
);

/**
 * Grants — major grants, programs, and spending initiatives.
 *
 * Each grant is associated with a grantor organization. Amount in USD by default.
 */
export const grants = pgTable(
  "grants",
  {
    id: varchar("id", { length: 10 }).primaryKey(),
    organizationId: text("organization_id").notNull(), // legacy: grantor entity ID (kept for migration compat)
    granteeId: text("grantee_id"), // legacy: recipient entity (kept for migration compat)
    /** FK to entities.stable_id for the grantor organization. Null when unresolved. */
    orgEntityId: text("org_entity_id").references(
      () => entities.stableId,
      { onDelete: "restrict" }
    ),
    /** Display name fallback when grantor org doesn't have an entity. */
    orgDisplayName: text("org_display_name"),
    /** FK to entities.stable_id for the grantee. Null when unresolved. */
    granteeEntityId: text("grantee_entity_id").references(
      () => entities.stableId,
      { onDelete: "restrict" }
    ),
    /** Display name fallback when grantee doesn't have an entity. */
    granteeDisplayName: text("grantee_display_name"),
    name: text("name").notNull(), // program or grant name
    amount: numeric("amount"), // funding amount (NUMERIC for precise financial data; Drizzle returns string)
    currency: text("currency").notNull().default("USD"),
    period: text("period"), // time period (e.g. "2016-2025")
    date: text("date"), // announcement/start date (YYYY-MM)
    status: text("status"), // active | completed | winding-down
    source: text("source"), // URL to announcement or report
    notes: text("notes"),
    programId: text("program_id").references(
      () => fundingPrograms.id,
      { onDelete: "set null" }
    ),
    dataSourceId: text("data_source_id").references(
      () => resourceTabularSources.sourceSlug,
      { onDelete: "set null" }
    ),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_grants_org").on(table.organizationId),
    index("idx_grants_grantee").on(table.granteeId),
    index("idx_grants_org_entity").on(table.orgEntityId),
    index("idx_grants_grantee_entity").on(table.granteeEntityId),
    index("idx_grants_status").on(table.status),
    index("idx_grants_program").on(table.programId),
    index("idx_grants_data_source").on(table.dataSourceId),
  ]
);

/**
 * Funding rounds — equity and strategic investment rounds for companies.
 *
 * Stores amounts as NUMERIC for precision. `lead_investor` may be an entity ID
 * or display name (same convention as personnel: entity IDs when known).
 * `stake_acquired` and `stake` in investments/equity are stored as TEXT because
 * they can be single values or ranges like "[0.07, 0.15]".
 */
export const fundingRounds = pgTable(
  "funding_rounds",
  {
    id: varchar("id", { length: 10 }).primaryKey(),
    companyId: text("company_id").notNull(), // legacy: entity ID of the company (kept for migration compat)
    /** FK to entities.stable_id for the company. Null when unresolved. */
    companyEntityId: text("company_entity_id").references(
      () => entities.stableId,
      { onDelete: "set null" }
    ),
    /** Display name fallback when company doesn't have an entity. */
    companyDisplayName: text("company_display_name"),
    name: text("name").notNull(), // round name (e.g., "Series A", "Founding")
    date: text("date"), // YYYY or YYYY-MM
    raised: numeric("raised"), // capital raised (USD)
    raisedLow: numeric("raised_low"), // parsed low bound of raised
    raisedHigh: numeric("raised_high"), // parsed high bound of raised
    valuation: numeric("valuation"), // post-money valuation (USD)
    valuationLow: numeric("valuation_low"), // parsed low bound of valuation
    valuationHigh: numeric("valuation_high"), // parsed high bound of valuation
    instrument: text("instrument"), // equity, convertible-note, strategic-partnership, founding
    leadInvestor: text("lead_investor"), // legacy: entity ID or display name (kept for migration compat)
    /** FK to entities.stable_id for the lead investor. Null when unresolved. */
    leadInvestorEntityId: text("lead_investor_entity_id").references(
      () => entities.stableId,
      { onDelete: "set null" }
    ),
    /** Display name fallback when lead investor doesn't have an entity. */
    leadInvestorDisplayName: text("lead_investor_display_name"),
    source: text("source"), // URL to announcement
    notes: text("notes"),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_fr_company").on(table.companyId),
    index("idx_fr_company_entity").on(table.companyEntityId),
    index("idx_fr_lead_investor_entity").on(table.leadInvestorEntityId),
    index("idx_fr_date").on(table.date),
  ]
);

/**
 * Investments — investor participation in funding rounds.
 *
 * Links an investor to a company (and optionally a funding round by name).
 * `stake_acquired` is TEXT to support ranges like "[0.07, 0.15]".
 */
export const investments = pgTable(
  "investments",
  {
    id: varchar("id", { length: 10 }).primaryKey(),
    companyId: text("company_id").notNull(), // legacy: entity ID of the company (kept for migration compat)
    investorId: text("investor_id").notNull(), // legacy: entity ID or display name (kept for migration compat)
    /** FK to entities.stable_id for the company. Null when unresolved. */
    companyEntityId: text("company_entity_id").references(
      () => entities.stableId,
      { onDelete: "set null" }
    ),
    /** Display name fallback when company doesn't have an entity. */
    companyDisplayName: text("company_display_name"),
    /** FK to entities.stable_id for the investor. Null when unresolved. */
    investorEntityId: text("investor_entity_id").references(
      () => entities.stableId,
      { onDelete: "set null" }
    ),
    /** Display name fallback when investor doesn't have an entity. */
    investorDisplayName: text("investor_display_name"),
    roundName: text("round_name"), // name of the funding round
    date: text("date"), // YYYY or YYYY-MM
    amount: numeric("amount"), // capital contributed (USD)
    amountLow: numeric("amount_low"), // parsed low bound of amount
    amountHigh: numeric("amount_high"), // parsed high bound of amount
    stakeAcquired: text("stake_acquired"), // pre-dilution stake (single or range as JSON string)
    stakeLow: numeric("stake_low"), // parsed low bound of stake_acquired
    stakeHigh: numeric("stake_high"), // parsed high bound of stake_acquired
    instrument: text("instrument"), // equity, convertible-note, etc.
    role: text("role"), // lead | participant | founder
    conditions: text("conditions"), // investment conditions
    source: text("source"), // URL to source
    notes: text("notes"),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_inv_company").on(table.companyId),
    index("idx_inv_investor").on(table.investorId),
    index("idx_inv_company_entity").on(table.companyEntityId),
    index("idx_inv_investor_entity").on(table.investorEntityId),
    index("idx_inv_date").on(table.date),
    // Natural key uniqueness: uq_investments_entity_key
    // Expression index on (LOWER(COALESCE(investor_entity_id, investor_id)),
    //   LOWER(COALESCE(company_entity_id, company_id)), LOWER(COALESCE(round_name, '')))
    // Non-partial — covers ALL rows. Uses entity_id when resolved, raw_id as fallback.
    // Managed in migration 0170_investments_display_name_dedup.sql (not representable in Drizzle API).
  ]
);

/**
 * Equity positions — current/historical equity ownership stakes.
 *
 * Temporal: `as_of` marks when the position was valid from, `valid_end` when it expired.
 * `stake` is TEXT to support ranges like "[0.015, 0.025]".
 */
export const equityPositions = pgTable(
  "equity_positions",
  {
    id: varchar("id", { length: 10 }).primaryKey(),
    companyId: text("company_id").notNull(), // legacy: entity ID of the company (kept for migration compat)
    holderId: text("holder_id").notNull(), // legacy: entity ID or display name (kept for migration compat)
    /** FK to entities.stable_id for the company. Null when unresolved. */
    companyEntityId: text("company_entity_id").references(
      () => entities.stableId,
      { onDelete: "set null" }
    ),
    /** Display name fallback when company doesn't have an entity. */
    companyDisplayName: text("company_display_name"),
    /** FK to entities.stable_id for the holder. Null when unresolved. */
    holderEntityId: text("holder_entity_id").references(
      () => entities.stableId,
      { onDelete: "set null" }
    ),
    /** Display name fallback when holder doesn't have an entity. */
    holderDisplayName: text("holder_display_name"),
    stake: text("stake"), // current post-dilution equity stake (single or range as JSON string)
    stakeLow: numeric("stake_low"), // parsed low bound of stake
    stakeHigh: numeric("stake_high"), // parsed high bound of stake
    source: text("source"), // URL to source
    notes: text("notes"),
    asOf: text("as_of"), // when this position was valid from (YYYY or YYYY-MM)
    validEnd: text("valid_end"), // when this position expired
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_ep_company").on(table.companyId),
    index("idx_ep_holder").on(table.holderId),
    index("idx_ep_company_entity").on(table.companyEntityId),
    index("idx_ep_holder_entity").on(table.holderEntityId),
  ]
);

/**
 * Secondary Market Prices — tracks private company valuations across
 * secondary/derivatives market platforms over time.
 *
 * Each row is one observation: a platform's price for a company on a given date.
 * Multiple platforms may have different prices on the same date.
 */
export const secondaryMarketPrices = pgTable(
  "secondary_market_prices",
  {
    id: varchar("id", { length: 10 }).primaryKey(),
    /** Legacy company ID (entity slug). Kept for migration compat. */
    companyId: text("company_id").notNull(),
    /** FK to entities.stable_id for the company. Null when unresolved. */
    companyEntityId: text("company_entity_id").references(
      () => entities.stableId,
      { onDelete: "set null" }
    ),
    /** Display name fallback when company doesn't have an entity. */
    companyDisplayName: text("company_display_name"),
    /** Platform identifier: ventuals, forge, hiive, upmarket, premier-alternatives, notice */
    platform: text("platform").notNull(),
    /** Observation date: YYYY-MM-DD or YYYY-MM */
    date: text("date").notNull(),
    /** Per-share price in USD (nullable; not all platforms report this) */
    pricePerShare: numeric("price_per_share"),
    /** Implied company valuation in USD */
    impliedValuation: numeric("implied_valuation"),
    /** Lower bound of implied valuation if range */
    impliedValuationLow: numeric("implied_valuation_low"),
    /** Upper bound of implied valuation if range */
    impliedValuationHigh: numeric("implied_valuation_high"),
    /** Trading volume in USD (nullable) */
    volume: numeric("volume"),
    /** Open interest for derivatives platforms (nullable) */
    openInterest: numeric("open_interest"),
    /** Best bid per share (nullable) */
    bidPrice: numeric("bid_price"),
    /** Best ask per share (nullable) */
    askPrice: numeric("ask_price"),
    /** Bid-ask spread as percentage (nullable) */
    spreadPercent: numeric("spread_percent"),
    /** Price type: mark, oracle, last_trade, indicative, bid, ask, mid */
    priceType: text("price_type").notNull().default("last_trade"),
    /** URL to the platform page */
    source: text("source"),
    notes: text("notes"),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_smp_company").on(table.companyId),
    index("idx_smp_company_entity").on(table.companyEntityId),
    index("idx_smp_platform").on(table.platform),
    index("idx_smp_date").on(table.date),
    index("idx_smp_company_date").on(table.companyEntityId, table.date),
    uniqueIndex("idx_smp_unique").on(
      table.companyId,
      table.platform,
      table.date,
      table.priceType
    ),
  ]
);

/**
 * Divisions — organizational sub-units (funds, teams, departments, labs, program areas).
 */
export const divisions = pgTable(
  "divisions",
  {
    id: varchar("id", { length: 10 }).primaryKey(),
    slug: text("slug").unique(), // entity slug for entity system integration
    parentOrgId: text("parent_org_id").references(() => entities.stableId, {
      onDelete: "set null",
    }), // parent org stableId (10-char)
    name: text("name").notNull(),
    divisionType: text("division_type").notNull(), // fund | team | department | lab | program-area
    lead: text("lead"), // person stableId or display name
    status: text("status"), // active | inactive | dissolved
    startDate: text("start_date"), // YYYY or YYYY-MM
    endDate: text("end_date"),
    website: text("website"),
    source: text("source"),
    notes: text("notes"),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_div_org").on(table.parentOrgId),
    // slug UNIQUE constraint already creates an implicit index
    index("idx_div_type").on(table.divisionType),
    index("idx_div_status").on(table.status),
  ]
);

/**
 * Division personnel — people assigned to specific divisions.
 */
export const divisionPersonnel = pgTable(
  "division_personnel",
  {
    id: varchar("id", { length: 10 }).primaryKey(),
    divisionId: text("division_id")
      .notNull()
      .references(() => divisions.id, { onDelete: "cascade" }), // divisions.id
    personId: text("person_id").references(() => entities.stableId, {
      onDelete: "set null",
    }), // person stableId
    /** Display name fallback when person doesn't have a matching entity. */
    personDisplayName: text("person_display_name"),
    role: text("role").notNull(),
    startDate: text("start_date"),
    endDate: text("end_date"),
    source: text("source"),
    notes: text("notes"),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_dp_division").on(table.divisionId),
    index("idx_dp_person").on(table.personId),
    // Natural key uniqueness: prevents duplicate person-division assignments.
    uniqueIndex("uq_division_personnel_natural_key")
      .on(table.divisionId, table.personId),
  ]
);

/**
 * Benchmarks — AI evaluation benchmark definitions.
 */
export const benchmarks = pgTable(
  "benchmarks",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    category: text("category"), // coding | reasoning | math | knowledge | multimodal | safety | agentic | general
    description: text("description"),
    website: text("website"),
    scoringMethod: text("scoring_method"),
    higherIsBetter: boolean("higher_is_better").notNull().default(true),
    introducedDate: text("introduced_date"),
    maintainer: text("maintainer"),
    source: text("source"),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_benchmarks_category").on(table.category),
  ]
);

/**
 * Benchmark results — individual model scores on benchmarks.
 */
export const benchmarkResults = pgTable(
  "benchmark_results",
  {
    id: varchar("id", { length: 10 }).primaryKey(),
    benchmarkId: text("benchmark_id")
      .notNull()
      .references(() => benchmarks.id),
    modelId: text("model_id")
      .notNull()
      .references(() => entities.stableId, { onDelete: "cascade" }),
    score: doublePrecision("score").notNull(),
    unit: text("unit"),
    date: text("date"),
    sourceUrl: text("source_url"),
    notes: text("notes"),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_br_benchmark").on(table.benchmarkId),
    index("idx_br_model").on(table.modelId),
    uniqueIndex("idx_br_benchmark_model").on(table.benchmarkId, table.modelId),
  ]
);

/**
 * Funding programs — RFPs, grant rounds, fellowships, prizes, solicitations.
 * Complementary to `grants` (individual awards). Individual grants link to their
 * parent program via `grants.programId`.
 */
export const fundingPrograms = pgTable(
  "funding_programs",
  {
    id: varchar("id", { length: 10 }).primaryKey(),
    orgId: text("org_id").notNull(), // org stableId (10-char)
    divisionId: text("division_id"), // divisions.id (nullable)
    name: text("name").notNull(),
    description: text("description"),
    programType: text("program_type").notNull(), // rfp | grant-round | fellowship | prize | solicitation | call
    totalBudget: numeric("total_budget"), // USD amount (Drizzle returns string)
    currency: text("currency").default("USD"),
    applicationUrl: text("application_url"),
    openDate: text("open_date"), // YYYY or YYYY-MM or ISO date
    deadline: text("deadline"),
    status: text("status"), // open | closed | awarded
    source: text("source"),
    notes: text("notes"),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_fp_org").on(table.orgId),
    index("idx_fp_division").on(table.divisionId),
    index("idx_fp_status").on(table.status),
    index("idx_fp_type").on(table.programType),
    uniqueIndex("uq_fp_org_name").on(table.orgId, table.name),
  ]
);

// ── Record Source-Checking ─────────────────────────────────────────────
//
// Unified sourcing for structured data records (grants, personnel,
// divisions, funding programs, etc.). Mirrors the two-tier fact
// sourcing model: evidence (per-source checks) → verdicts (aggregate).

// Legacy record sourcing tables removed — replaced by
// unified source_check_evidence and source_check_verdicts tables above.
// See migration 0127 and discussion #2950.

// ── Entity Events (Timeline / Milestones) ────────────────────────────
//
// Generic event/milestone table for any entity type. Replaces inline
// timeline tables in wiki pages and can eventually subsume the YAML-based
// milestone arrays used by legislation pages.
//
// Design: one event per row, linked to an entity. Event types are
// parameterized (not hardcoded to policy labels), so the same table
// serves organizations, people, legislation, projects, etc.

/**
 * Entity events — milestones, announcements, incidents, transitions.
 *
 * Each row is a single dated event associated with one entity.
 * Rendered by timeline components on directory pages.
 */
export const entityEvents = pgTable(
  "entity_events",
  {
    id: varchar("id", { length: 10 }).primaryKey(),
    /** FK to entities.stable_id for the parent entity */
    entityId: text("entity_id")
      .notNull()
      .references(() => entities.stableId, { onDelete: "cascade" }),
    /** Display name fallback when entity is unresolved */
    entityDisplayName: text("entity_display_name"),
    date: text("date").notNull(), // YYYY, YYYY-MM, or YYYY-MM-DD
    title: text("title").notNull(),
    description: text("description"),
    /** Event type — generic across entity types */
    eventType: text("event_type").notNull(), // founding | acquisition | pivot | launch | publication | policy | milestone | leadership-change | incident | funding | dissolution | other
    /** Significance level for filtering/sorting */
    significance: text("significance"), // major | moderate | minor
    source: text("source"), // URL to source
    notes: text("notes"),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_ee_entity").on(table.entityId),
    index("idx_ee_date").on(table.date),
    index("idx_ee_type").on(table.eventType),
    index("idx_ee_significance").on(table.significance),
  ]
);

// ── Entity Assessments ──────────────────────────────────────────────
//
// Structured quality/capability ratings for entities. Replaces the
// "Quick Assessment" tables currently embedded in wiki pages.
// Each row is a single dimension rating for one entity.

/**
 * Entity assessments — structured ratings along named dimensions.
 *
 * Examples: "speed: Fast (<1 week)", "transparency: High",
 * "research output: Declining", "financial health: Stable".
 */
export const entityAssessments = pgTable(
  "entity_assessments",
  {
    id: varchar("id", { length: 10 }).primaryKey(),
    /** FK to entities.stable_id */
    entityId: text("entity_id")
      .notNull()
      .references(() => entities.stableId, { onDelete: "cascade" }),
    /** Dimension being assessed (e.g., 'speed', 'transparency', 'research-output') */
    dimension: text("dimension").notNull(),
    /** Rating value — free text to support varied scales */
    rating: text("rating").notNull(), // e.g., "Fast (<1 week)", "High", "Declining"
    /** Supporting evidence or explanation */
    evidence: text("evidence"),
    /** Who/what produced this assessment */
    assessor: text("assessor").notNull().default("editorial"), // editorial | llm | community | external
    /** When this assessment was made (YYYY-MM-DD) */
    assessedAt: text("assessed_at"),
    source: text("source"),
    notes: text("notes"),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_ea_entity").on(table.entityId),
    index("idx_ea_dimension").on(table.dimension),
    // Natural key: one rating per entity per dimension per assessor
    uniqueIndex("uq_entity_assessment_natural_key")
      .on(table.entityId, table.dimension, table.assessor),
  ]
);

// ── Publications ────────────────────────────────────────────────────
//
// Key publications (papers, reports, blog posts) associated with entities.
// Complements research_area_papers (which links papers to research areas)
// by linking papers directly to organizations and people.

/**
 * Publications — papers, reports, and blog posts linked to entities.
 *
 * Each row is a publication associated with an organization or person.
 * Can link to the resources table when the publication is also tracked
 * as a citation source.
 */
export const publications = pgTable(
  "publications",
  {
    id: varchar("id", { length: 10 }).primaryKey(),
    /** FK to entities.stable_id for the primary author/org */
    entityId: text("entity_id")
      .notNull()
      .references(() => entities.stableId, { onDelete: "cascade" }),
    /** Display name fallback */
    entityDisplayName: text("entity_display_name"),
    /** Optional FK to resources table for citation tracking */
    resourceId: text("resource_id").references(() => resources.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    authors: text("authors"), // comma-separated or structured
    url: text("url"),
    venue: text("venue"), // journal, conference, arXiv, blog
    publishedDate: text("published_date"), // YYYY or YYYY-MM
    publicationType: text("publication_type").notNull().default("paper"), // paper | report | blog-post | book | thesis | preprint | policy-brief
    citationCount: integer("citation_count"),
    /** Whether this is a flagship/seminal work for the entity */
    isFlagship: boolean("is_flagship").notNull().default(false),
    abstract: text("abstract"),
    source: text("source"),
    notes: text("notes"),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_pub_entity").on(table.entityId),
    index("idx_pub_resource").on(table.resourceId),
    index("idx_pub_type").on(table.publicationType),
    index("idx_pub_date").on(table.publishedDate),
    index("idx_pub_flagship").on(table.isFlagship),
  ]
);

// ── Cross-Base: Unified Things Table ──────────────────────────────────
//
// Every identifiable item in the system gets a single row here. Enables
// cross-domain queries, unified sourcing status, and a single browse UI.
//
// NAMING NOTE: This PG `things` table is a cross-base universal index.
// It is NOT related to the FactBase "things" directory
// (packages/factbase/data/things/) which contains FactBase entity YAML files.
// The name collision is a known confusion — see data-architecture.mdx.

export const VALID_THING_TYPES = [
  "entity",
  "fact",
  "grant",
  "resource",
  "personnel",
  "division",
  "funding-round",
  "investment",
  "equity-position",
  "benchmark",
  "benchmark-result",
  "funding-program",
  "division-personnel",
  "research-area",
  "policy-stakeholder",
  "entity-event",
  "entity-assessment",
  "publication",
  "political-race",
  "race-candidate",
] as const;

export type ThingType = (typeof VALID_THING_TYPES)[number];

export const things = pgTable(
  "things",
  {
    id: text("id").primaryKey(),
    thingType: text("thing_type").notNull(),
    title: text("title").notNull(),
    parentThingId: text("parent_thing_id").references((): any => things.id, {
      onDelete: "set null",
    }),
    sourceTable: text("source_table").notNull(),
    sourceId: text("source_id").notNull(),
    entityType: text("entity_type"),
    description: text("description"),
    sourceUrl: text("source_url"),
    wikiId: text("wiki_id"),
    parentTitle: text("parent_title"),
    // verdict, verdict_confidence, verdict_at columns removed — sourcing
    // verdicts now live in the unified source_check_verdicts table. See migration 0127.
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // search_vector tsvector column is managed via migration SQL (generated column)
  },
  (table) => [
    index("idx_things_type").on(table.thingType),
    index("idx_things_parent").on(table.parentThingId),
    index("idx_things_entity_type").on(table.entityType),
    index("idx_things_updated").on(table.updatedAt),
    uniqueIndex("idx_things_source_unique").on(table.sourceTable, table.sourceId),
    // GIN index on search_vector is created in migration SQL
  ]
);

// Legacy thing sourcing tables removed — replaced by
// unified source_check_evidence and source_check_verdicts tables.
// See migration 0127 and discussion #2950.

// ── QA Page Checks ─────────────────────────────────────────────────────
//
// Records of QA sweep checks against live site pages. Tracks which pages
// have been audited, when, and what was found. Used by the queue endpoint
// to prioritize least-recently-checked pages.

export const qaPageChecks = pgTable(
  "qa_page_checks",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    thingId: text("thing_id").references(() => things.id, {
      onDelete: "set null",
    }),
    pageUrl: text("page_url").notNull(),
    directory: text("directory"),
    checkType: text("check_type").notNull().default("detail"),
    result: text("result").notNull(),
    findings: jsonb("findings").$type<
      { severity: string; description: string; githubIssue?: number }[]
    >(),
    depth: text("depth"),
    sweepId: text("sweep_id"),
    checkedAt: timestamp("checked_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_qpc_thing").on(table.thingId),
    index("idx_qpc_page_url").on(table.pageUrl),
    index("idx_qpc_directory").on(table.directory),
    index("idx_qpc_checked_at").on(table.checkedAt),
    index("idx_qpc_sweep").on(table.sweepId),
  ]
);

// ── Research Areas ──────────────────────────────────────────────────────
//
// Bodies of work with papers, organizations, and ongoing activity.
// PG-first (like grants, personnel, benchmarks). Rich data lives here;
// minimal YAML entity stubs exist only for EntityLink resolution.

/**
 * Research areas — fields, techniques, and research programs in AI safety.
 *
 * Each row represents a body of work that has papers, organizations, and
 * potentially grant funding. Examples: RLHF, mechanistic interpretability,
 * scalable oversight, red-teaming.
 */
export const researchAreas = pgTable(
  "research_areas",
  {
    id: text("id").primaryKey(), // slug: 'rlhf', 'mech-interp'
    wikiId: text("wiki_id"), // 'E259' — links to entity_ids for wiki pages
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").notNull().default("active"), // active | emerging | mature | declining | archived
    cluster: text("cluster"), // grouping: 'alignment-training', 'interpretability', etc.
    parentAreaId: text("parent_area_id").references((): any => researchAreas.id, {
      onDelete: "set null",
    }),
    firstProposed: text("first_proposed"), // '2017 (Christiano et al.)'
    firstProposedYear: integer("first_proposed_year"), // 2017 (for sorting)
    tags: jsonb("tags").$type<string[]>().notNull().default([]), // flexible facets
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    source: text("source"), // primary reference URL
    notes: text("notes"),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_ra_status").on(table.status),
    index("idx_ra_cluster").on(table.cluster),
    index("idx_ra_parent").on(table.parentAreaId),
    // GIN index on tags created in migration SQL
  ]
);

/**
 * Organizations working on a research area.
 */
export const researchAreaOrganizations = pgTable(
  "research_area_organizations",
  {
    researchAreaId: text("research_area_id")
      .notNull()
      .references(() => researchAreas.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(), // entity stableId or slug
    role: text("role").notNull().default("active"), // pioneer | active | major | funder | emerging
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.researchAreaId, table.organizationId] }),
    index("idx_rao_org").on(table.organizationId),
  ]
);

/**
 * Key papers associated with a research area.
 * Links to the resources table when available; otherwise stores title+url inline.
 */
export const researchAreaPapers = pgTable(
  "research_area_papers",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    researchAreaId: text("research_area_id")
      .notNull()
      .references(() => researchAreas.id, { onDelete: "cascade" }),
    resourceId: text("resource_id").references(() => resources.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    url: text("url"),
    authors: text("authors"),
    publishedDate: text("published_date"), // YYYY or YYYY-MM
    citationCount: integer("citation_count"),
    isSeminal: boolean("is_seminal").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_rap_area_url")
      .on(table.researchAreaId, table.url)
      .where(sql`url IS NOT NULL`),
    index("idx_rap_area").on(table.researchAreaId),
    index("idx_rap_resource").on(table.resourceId),
  ]
);

/**
 * Risks that a research area addresses, studies, or relates to.
 */
export const researchAreaRisks = pgTable(
  "research_area_risks",
  {
    researchAreaId: text("research_area_id")
      .notNull()
      .references(() => researchAreas.id, { onDelete: "cascade" }),
    riskId: text("risk_id").notNull(), // entity slug
    relevance: text("relevance").notNull().default("addresses"), // addresses | studies | exacerbates
    effectiveness: text("effectiveness"), // high | moderate | low | uncertain
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.researchAreaId, table.riskId] }),
    index("idx_rar_risk").on(table.riskId),
  ]
);

/**
 * Entity–Resource join table with explicit relationship flags.
 * Replaces heuristic domain-matching in org-data.ts with relational data.
 *
 * authoredByEntity: the entity authored/published this resource
 * isSubject: the resource is about this entity
 */
export const entityResources = pgTable(
  "entity_resources",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    entityId: text("entity_id")
      .notNull()
      .references(() => entities.stableId, { onDelete: "cascade" }),
    resourceId: text("resource_id")
      .notNull()
      .references(() => resources.id, { onDelete: "cascade" }),
    authoredByEntity: boolean("authored_by_entity").notNull().default(false),
    isSubject: boolean("is_subject").notNull().default(false),
    inferenceSource: text("inference_source"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_er_entity_resource").on(table.entityId, table.resourceId),
    index("idx_er_entity").on(table.entityId),
    index("idx_er_resource").on(table.resourceId),
  ]
);

/**
 * Many-to-many link between grants and research areas.
 */
export const grantResearchAreas = pgTable(
  "grant_research_areas",
  {
    grantId: varchar("grant_id", { length: 10 })
      .notNull()
      .references(() => grants.id, { onDelete: "cascade" }),
    researchAreaId: text("research_area_id")
      .notNull()
      .references(() => researchAreas.id, { onDelete: "cascade" }),
    confidence: real("confidence"), // 0-1; how confident is the tag
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.grantId, table.researchAreaId] }),
    index("idx_gra_area").on(table.researchAreaId),
  ]
);

// ── Research Area Evaluations ─────────────────────────────────────────────
//
// LLM-scored (or human-scored) dimensions for cross-area comparison.
// Individual evaluations accumulate per (area, dimension, evaluator).
// Consensus scores are computed periodically and cached in research_area_scores.

/**
 * Individual evaluation of a research area on a specific dimension.
 */
export const researchAreaEvaluations = pgTable(
  "research_area_evaluations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    researchAreaId: text("research_area_id")
      .notNull()
      .references(() => researchAreas.id, { onDelete: "cascade" }),
    dimension: text("dimension").notNull(),
    score: doublePrecision("score").notNull(), // 1-10 scale
    confidence: doublePrecision("confidence"), // 0-1
    reasoning: text("reasoning"),
    evaluatorType: text("evaluator_type").notNull().default("llm"), // 'llm' | 'human'
    evaluatorId: text("evaluator_id").notNull(), // model ID or user identifier
    promptVersion: text("prompt_version").notNull().default(""),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_rae_unique").on(
      table.researchAreaId,
      table.dimension,
      table.evaluatorId,
      table.promptVersion
    ),
    index("idx_rae_area").on(table.researchAreaId),
    index("idx_rae_dimension").on(table.dimension),
    index("idx_rae_evaluator").on(table.evaluatorId),
  ]
);

/**
 * Aggregated consensus scores (computed from evaluations).
 */
export const researchAreaScores = pgTable(
  "research_area_scores",
  {
    researchAreaId: text("research_area_id")
      .notNull()
      .references(() => researchAreas.id, { onDelete: "cascade" }),
    dimension: text("dimension").notNull(),
    meanScore: doublePrecision("mean_score").notNull(),
    medianScore: doublePrecision("median_score"),
    stdDev: doublePrecision("std_dev"),
    minScore: doublePrecision("min_score"),
    maxScore: doublePrecision("max_score"),
    numEvaluators: integer("num_evaluators").notNull().default(0),
    modelAgreement: doublePrecision("model_agreement"), // 0-1; 1 = perfect agreement
    lastComputed: timestamp("last_computed", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.researchAreaId, table.dimension] }),
    index("idx_ras_dimension").on(table.dimension),
  ]
);

/**
 * Registry of valid evaluation dimensions.
 */
export const evaluationDimensions = pgTable("evaluation_dimensions", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  description: text("description"),
  category: text("category"), // 'prioritization' | 'field-health' | 'impact'
  scaleMin: doublePrecision("scale_min").notNull().default(1),
  scaleMax: doublePrecision("scale_max").notNull().default(10),
  higherIsBetter: boolean("higher_is_better").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Wikibase page similarity — top-N most similar pages per page.
 *
 * Built from content redundancy analysis in build-data.mjs.
 * Each row stores one similarity pair (page → similar page) with rank 1-5.
 * Replaced in full on each build sync.
 *
 * See GitHub issue #2434 (epic #2428).
 */
export const wikibasePageSimilarity = pgTable(
  "wikibase_page_similarity",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    pageId: integer("page_id").references(() => wikiPages.id),
    similarPageId: integer("similar_page_id").references(() => wikiPages.id),
    similarity: integer("similarity").notNull(), // 0-100 percentage
    rank: integer("rank").notNull(), // 1-5
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_wps_page_id").on(table.pageId),
    uniqueIndex("idx_wps_page_rank").on(table.pageId, table.rank),
  ]
);

/**
 * Wikibase page assessments — temporal scoring events for wiki pages.
 *
 * Each row is a single assessment of a page by a specific assessor at a point in time.
 * Multiple assessors can score the same page (structural, llm-grading, editorial,
 * frontmatter-sync), and assessments accumulate over time for history tracking.
 *
 * See GitHub issue #2429 (epic #2428).
 */
export const wikibasePageAssessments = pgTable(
  "wikibase_page_assessments",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    pageId: integer("page_id").references(() => wikiPages.id),
    assessor: text("assessor").notNull(), // 'structural' | 'llm-grading' | 'editorial' | 'frontmatter-sync'
    method: text("method"), // 'metrics-extractor-v1' | 'crux-grade-sonnet' | 'frontmatter-manual'
    model: text("model"), // LLM model used (NULL for structural/editorial)
    quality: integer("quality"), // 0-100
    readerImportance: real("reader_importance"), // 0-100
    researchImportance: real("research_importance"), // 0-100
    tacticalValue: real("tactical_value"), // 0-100
    ratingFocus: real("rating_focus"), // 0-10
    ratingNovelty: real("rating_novelty"),
    ratingRigor: real("rating_rigor"),
    ratingCompleteness: real("rating_completeness"),
    ratingConcreteness: real("rating_concreteness"),
    ratingActionability: real("rating_actionability"),
    ratingObjectivity: real("rating_objectivity"),
    structuralScore: integer("structural_score"), // 0-15 raw (structural assessor only)
    wordCount: integer("word_count"),
    note: text("note"),
    assessedAt: timestamp("assessed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_wpa_page_assessor_time").on(table.pageId, table.assessor, table.assessedAt),
    index("idx_wpa_page_time").on(table.pageId, table.assessedAt),
    index("idx_wpa_assessor").on(table.assessor),
  ]
);

// ── Website Sources ──────────────────────────────────────────────────────
//
// Websites tracked as structured data feeds. Each source is a domain
// linked to an entity (usually an org). A periodic pipeline fetches
// tracked pages, extracts structured facts via LLM, and upserts them
// into TableBase/FactBase. See Discussion #2928.

export const websiteSources = pgTable(
  "website_sources",
  {
    id: varchar("id", { length: 10 }).primaryKey(),
    /** Canonical domain, e.g. "anthropic.com" */
    domain: text("domain").notNull(),
    /** FK to entities.stable_id — usually the org this website belongs to */
    entityId: text("entity_id").references(() => entities.stableId, {
      onDelete: "set null",
    }),
    /** Display name resolved from entity, cached for convenience */
    entityDisplayName: text("entity_display_name"),
    /** Source reliability: high | medium | low */
    reliability: text("reliability").notNull().default("medium"),
    /** Default days between re-fetches for pages under this source */
    refreshIntervalDays: integer("refresh_interval_days")
      .notNull()
      .default(30),
    enabled: boolean("enabled").notNull().default(true),
    notes: text("notes"),
    /** When the extraction pipeline last ran for this source */
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    /** Error message from last failed run */
    lastError: text("last_error"),
    /** Consecutive pipeline failures (reset to 0 on success) */
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_ws_domain").on(table.domain),
    index("idx_ws_entity").on(table.entityId),
    index("idx_ws_enabled").on(table.enabled),
  ]
);

/** Individual pages within a tracked website source. */
export const websiteSourcePages = pgTable(
  "website_source_pages",
  {
    id: varchar("id", { length: 10 }).primaryKey(),
    /** FK to website_sources.id */
    sourceId: varchar("source_id", { length: 10 })
      .notNull()
      .references(() => websiteSources.id, { onDelete: "cascade" }),
    /** Page path relative to domain, e.g. "/about", "/team" */
    path: text("path").notNull(),
    /** Role of this page: about | team | research | pricing | careers | docs | other */
    pageRole: text("page_role"),
    /** JSON array of FactBase property IDs to extract, e.g. ["headcount", "headquarters"] */
    extractTargets: jsonb("extract_targets").$type<string[]>(),
    /** Override source-level refresh interval for this page */
    refreshIntervalDays: integer("refresh_interval_days"),
    enabled: boolean("enabled").notNull().default(true),
    /** When this page was last fetched */
    lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),
    /** Content hash from last fetch (for change detection) */
    lastContentHash: text("last_content_hash"),
    /** ID of the most recent page_snapshot record (future FK) */
    lastSnapshotId: varchar("last_snapshot_id", { length: 10 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_wsp_source_path").on(table.sourceId, table.path),
    index("idx_wsp_role").on(table.pageRole),
    index("idx_wsp_enabled").on(table.enabled),
  ]
);

// ── Page Snapshots ──────────────────────────────────────────────────────
//
// Dated snapshots of website source pages. Each snapshot stores the full
// extracted text, a content hash for dedup, and extraction status for the
// LLM fact-extraction pipeline. See Discussion #2928, Issue #3652.

export const pageSnapshots = pgTable(
  "page_snapshots",
  {
    id: varchar("id", { length: 10 }).primaryKey(),
    /** FK to website_source_pages.id */
    websiteSourcePageId: varchar("website_source_page_id", { length: 10 })
      .notNull()
      .references(() => websiteSourcePages.id, { onDelete: "cascade" }),
    /** Full URL that was fetched */
    url: text("url").notNull(),
    /** When the page was fetched */
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** SHA-256 of full_text for content-hash dedup */
    contentHash: text("content_hash").notNull(),
    /** Extracted text/markdown after HTML stripping */
    fullText: text("full_text").notNull(),
    /** Page <title> at time of fetch */
    titleAtTime: text("title_at_time"),
    /** HTTP status code from the fetch */
    httpStatus: integer("http_status").notNull().default(200),
    /** Length of full_text in characters */
    contentLength: integer("content_length").notNull().default(0),
    /** Extraction pipeline status: pending | extracted | failed | skipped */
    extractionStatus: text("extraction_status").notNull().default("pending"),
    /** When fact extraction was last run on this snapshot */
    extractedAt: timestamp("extracted_at", { withTimezone: true }),
    /** JSONB array of extracted facts (populated by extraction pipeline) */
    extractedFacts: jsonb("extracted_facts"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Note: actual SQL migration uses fetched_at DESC for most-recent-first lookups.
    // Drizzle's index() doesn't support column-level DESC, so this is ASC here.
    // The deployed index (0158_page_snapshots.sql) is authoritative.
    index("idx_ps_page_fetched").on(
      table.websiteSourcePageId,
      table.fetchedAt
    ),
    index("idx_ps_extraction_status").on(table.extractionStatus),
    uniqueIndex("idx_ps_page_content_hash").on(
      table.websiteSourcePageId,
      table.contentHash
    ),
  ]
);

// ── Policy Stakeholders ──────────────────────────────────────────────────
//
// Cross-entity join table tracking organization/person positions on policy entities.
// Enables queries like "which orgs oppose AI regulation?" and
// "what policies has Anthropic taken positions on?"

export const policyStakeholders = pgTable(
  "policy_stakeholders",
  {
    id: varchar("id", { length: 10 }).primaryKey(),
    /** FK to entities.stable_id for the policy/legislation entity */
    policyEntityId: text("policy_entity_id")
      .notNull()
      .references(() => entities.stableId, { onDelete: "cascade" }),
    /** FK to entities.stable_id for the stakeholder. Null when unresolved. */
    stakeholderEntityId: text("stakeholder_entity_id").references(
      () => entities.stableId,
      { onDelete: "set null" }
    ),
    /** Display name (always present — used when stakeholder has no entity) */
    stakeholderDisplayName: text("stakeholder_display_name").notNull(),
    /** Position: support | oppose | neutral | mixed */
    position: text("position").notNull(),
    /** Importance/weight: high | medium | low */
    importance: text("importance"),
    /** Reason for the position */
    reason: text("reason"),
    /** Source URL */
    source: text("source"),
    /** Array of contextual notes (funding connections, conflicts, etc.) */
    context: jsonb("context").$type<string[]>(),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_ps_policy").on(table.policyEntityId),
    index("idx_ps_stakeholder").on(table.stakeholderEntityId),
    index("idx_ps_position").on(table.position),
  ]
);

// ── Prediction Market Questions ──────────────────────────────────────────
//
// Tracks prediction market questions linked to wiki entities.
// Each row represents one question on one platform (Metaculus, Polymarket, Manifold).
// Probability snapshots are stored in a companion table for time-series analysis.

export const predictionMarketQuestions = pgTable(
  "prediction_market_questions",
  {
    id: varchar("id", { length: 10 }).primaryKey(),
    /** Platform: metaculus, polymarket, manifold */
    platform: text("platform").notNull(),
    /** Platform's native question ID (e.g., Metaculus question number) */
    platformQuestionId: text("platform_question_id").notNull(),
    /** FK to entities.stable_id for the linked wiki entity */
    entityId: text("entity_id").references(() => entities.stableId, {
      onDelete: "set null",
    }),
    /** Display name fallback when entity doesn't exist */
    entityDisplayName: text("entity_display_name"),
    /** Full question text */
    questionText: text("question_text").notNull(),
    /** Permalink to the question on the platform */
    questionUrl: text("question_url"),
    /** Expected resolution date (YYYY-MM-DD) */
    resolutionDate: text("resolution_date"),
    /** Resolution criteria description */
    resolutionCriteria: text("resolution_criteria"),
    /** Question type: binary, numeric, multiple_choice */
    questionType: text("question_type").notNull().default("binary"),
    /** Topic category: valuation, ipo, safety, timeline, regulation, capability, etc. */
    category: text("category"),
    /** Whether the question has resolved */
    isResolved: boolean("is_resolved").notNull().default(false),
    /** Actual resolution value (0/1 for binary, numeric for range) */
    resolutionValue: numeric("resolution_value"),
    /** Notes about the resolution */
    resolutionNotes: text("resolution_notes"),
    /** Denormalized latest probability (0-1) for quick display */
    currentProbability: numeric("current_probability"),
    /** How this question was discovered: manual, llm_agent, api_search */
    discoveryMethod: text("discovery_method"),
    /** Source URL or reference for discovery */
    source: text("source"),
    notes: text("notes"),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_pmq_platform_id").on(
      table.platform,
      table.platformQuestionId
    ),
    index("idx_pmq_entity").on(table.entityId),
    index("idx_pmq_platform").on(table.platform),
    index("idx_pmq_resolved").on(table.isResolved),
    index("idx_pmq_category").on(table.category),
  ]
);

// ── Prediction Market Snapshots ──────────────────────────────────────────
//
// Time-series observations of prediction market probabilities.
// Each row is one snapshot: a question's probability on a given date.
// Used for charting probability trends over time.

export const predictionMarketSnapshots = pgTable(
  "prediction_market_snapshots",
  {
    id: varchar("id", { length: 10 }).primaryKey(),
    /** FK to prediction_market_questions.id */
    questionId: varchar("question_id", { length: 10 })
      .notNull()
      .references(() => predictionMarketQuestions.id, { onDelete: "cascade" }),
    /** Observation date: YYYY-MM-DD */
    date: text("date").notNull(),
    /** Probability (0.0 to 1.0) for binary questions */
    probability: numeric("probability"),
    /** Lower CI bound (e.g., Metaculus 25th percentile) */
    probabilityLow: numeric("probability_low"),
    /** Upper CI bound (e.g., Metaculus 75th percentile) */
    probabilityHigh: numeric("probability_high"),
    /** Number of forecasters at snapshot time */
    numForecasters: integer("num_forecasters"),
    /** Trading volume in USD (Polymarket) */
    volume: numeric("volume"),
    /** Open interest in USD (Polymarket) */
    openInterest: numeric("open_interest"),
    /** Community aggregated prediction (may differ from probability) */
    communityPrediction: numeric("community_prediction"),
    /** Source: API endpoint or URL */
    source: text("source"),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_pms_question_date").on(table.questionId, table.date),
    index("idx_pms_question").on(table.questionId),
    index("idx_pms_date").on(table.date),
  ]
);

// ============================================================================
// Operational — Data Quality Snapshots
//
// Point-in-time snapshots of data quality metrics across all bases.
// Captured periodically to track coverage and sourcing trends.
// ============================================================================

export const dataQualitySnapshots = pgTable(
  "data_quality_snapshots",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    capturedAt: timestamp("captured_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Source-check verdicts
    verdictsTotal: integer("verdicts_total").notNull().default(0),
    verdictsConfirmed: integer("verdicts_confirmed").notNull().default(0),
    verdictsContradicted: integer("verdicts_contradicted").notNull().default(0),
    verdictsPartial: integer("verdicts_partial").notNull().default(0),
    verdictsUnverifiable: integer("verdicts_unverifiable").notNull().default(0),
    verdictsOutdated: integer("verdicts_outdated").notNull().default(0),
    verdictsNeedsRecheck: integer("verdicts_needs_recheck").notNull().default(0),
    // Record coverage
    personnelTotal: integer("personnel_total").notNull().default(0),
    personnelWithSource: integer("personnel_with_source").notNull().default(0),
    personnelWithStartDate: integer("personnel_with_start_date").notNull().default(0),
    grantsTotal: integer("grants_total").notNull().default(0),
    grantsWithSource: integer("grants_with_source").notNull().default(0),
    investmentsTotal: integer("investments_total").notNull().default(0),
    investmentsWithSource: integer("investments_with_source").notNull().default(0),
    fundingRoundsTotal: integer("funding_rounds_total").notNull().default(0),
    // Entity coverage
    entitiesTotal: integer("entities_total").notNull().default(0),
    entitiesWithWikiPage: integer("entities_with_wiki_page").notNull().default(0),
    // FactBase
    factbaseEntities: integer("factbase_entities").notNull().default(0),
    factbaseFacts: integer("factbase_facts").notNull().default(0),
    // Pages
    pagesTotal: integer("pages_total").notNull().default(0),
    // Extra JSON for future metrics without migration
    extra: jsonb("extra").default({}),
  },
  (table) => [
    index("idx_dqs_captured").on(table.capturedAt),
  ]
);

// ── Bluesky Data Source ────────────────────────────────────────────────
//
// Tracks Bluesky (AT Protocol) accounts and their posts for use as a
// structured data source.  Posts can be linked to entities and resources.

/** Tracked Bluesky accounts. */
export const blueskyAccounts = pgTable(
  "bluesky_accounts",
  {
    /** Decentralized Identifier — AT Protocol primary key */
    did: text("did").primaryKey(),
    handle: text("handle").notNull(),
    displayName: text("display_name"),
    description: text("description"),
    followerCount: integer("follower_count"),
    postCount: integer("post_count"),
    /** FK to entities.stable_id — links this account to a wiki entity */
    entityStableId: text("entity_stable_id").references(
      () => entities.stableId,
      { onDelete: "set null" }
    ),
    /** Freeform tags for filtering (e.g. ["ai-safety", "policy"]) */
    relevanceTags: jsonb("relevance_tags").$type<string[]>(),
    lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_ba_handle").on(table.handle),
    index("idx_ba_entity").on(table.entityStableId),
  ]
);

/** Individual Bluesky posts fetched from tracked accounts. */
export const blueskyPosts = pgTable(
  "bluesky_posts",
  {
    /** AT Protocol URI (at://did/app.bsky.feed.post/...) */
    uri: text("uri").primaryKey(),
    /** Content-hash identifier */
    cid: text("cid"),
    accountDid: text("account_did")
      .notNull()
      .references(() => blueskyAccounts.did, { onDelete: "cascade" }),
    text: text("text"),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull(),
    likeCount: integer("like_count"),
    repostCount: integer("repost_count"),
    replyCount: integer("reply_count"),
    quoteCount: integer("quote_count"),
    /** URL embedded in the post (from record.embed.external.uri) */
    embeddedUrl: text("embedded_url"),
    /** Title of the embedded link */
    embeddedTitle: text("embedded_title"),
    /** URI of the post this is replying to */
    replyToUri: text("reply_to_uri"),
    /** FK to resources — links this post to a known resource by embedded URL */
    resourceId: text("resource_id").references(() => resources.id, {
      onDelete: "set null",
    }),
    /** Entity stableIds this post is about */
    entityStableIds: jsonb("entity_stable_ids").$type<string[]>(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("idx_bp_account_did").on(table.accountDid),
    index("idx_bp_posted_at").on(table.postedAt),
    index("idx_bp_embedded_url").on(table.embeddedUrl),
    index("idx_bp_resource_id").on(table.resourceId),
  ]
);

// ── Political Races ──────────────────────────────────────────────────────
//
// Tracks political races relevant to AI policy (2026 midterms, ballot measures).
// ---------------------------------------------------------------------------
// Platform accounts — external platform identities for wiki entities
// ---------------------------------------------------------------------------

/** Maps wiki entities (people, orgs) to accounts on external platforms. */
export const platformAccounts = pgTable(
  "platform_accounts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** Platform identifier: 'lesswrong', 'eaforum', 'github', 'twitter', etc. */
    platform: text("platform").notNull(),
    /** Username/slug/handle on the platform */
    platformUsername: text("platform_username").notNull(),
    /** Immutable platform-internal ID (LW _id, GitHub numeric ID, etc.) */
    platformUserId: text("platform_user_id"),
    /** FK to entities.stable_id — nullable (accounts can exist before linking) */
    entityStableId: text("entity_stable_id").references(
      () => entities.stableId,
      { onDelete: "set null" }
    ),
    /** Cached display name from the platform */
    displayName: text("display_name"),
    /** Full URL to the profile page */
    profileUrl: text("profile_url"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_pa_platform_username").on(table.platform, table.platformUsername),
    index("idx_pa_entity").on(table.entityStableId),
    index("idx_pa_platform_user_id").on(table.platform, table.platformUserId),
  ]
);

// ---------------------------------------------------------------------------
// Political races — election tracking
// ---------------------------------------------------------------------------

// Each race can have multiple candidates via the race_candidates join table.

export const politicalRaces = pgTable(
  "political_races",
  {
    id: varchar("id", { length: 10 }).primaryKey(),
    /** Full race name, e.g. "NY-12 Democratic Primary 2026" */
    name: text("name").notNull(),
    /** Race type: primary, general, runoff, special, ballot_measure */
    raceType: text("race_type").notNull(),
    /** Party: democrat, republican, or null for ballot measures */
    party: text("party"),
    /** Level: federal_house, federal_senate, state_governor, state_legislature, ballot_measure */
    level: text("level").notNull(),
    /** US state abbreviation */
    state: text("state"),
    /** District identifier, e.g. "NY-12", "NE-Sen", "TN-Gov" */
    district: text("district"),
    /** Election date: YYYY-MM-DD */
    electionDate: text("election_date"),
    /** Status: upcoming, active, resolved, cancelled */
    status: text("status").notNull().default("upcoming"),
    /** Winner stableId or "Yes"/"No" for ballot measures */
    outcome: text("outcome"),
    /** Narrative outcome details */
    outcomeDetails: text("outcome_details"),
    /** Short AI relevance description */
    aiAngle: text("ai_angle"),
    /** Longer AI relevance narrative */
    aiAngleSummary: text("ai_angle_summary"),
    /** FK to entities.stable_id for linked legislation */
    policyEntityId: text("policy_entity_id").references(
      () => entities.stableId,
      { onDelete: "set null" }
    ),
    /** For ballot measures: measure title */
    measureTitle: text("measure_title"),
    /** For ballot measures: measure description */
    measureDescription: text("measure_description"),
    source: text("source"),
    notes: text("notes"),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_pr_status").on(table.status),
    index("idx_pr_state").on(table.state),
    index("idx_pr_level").on(table.level),
    index("idx_pr_race_type").on(table.raceType),
    index("idx_pr_election_date").on(table.electionDate),
    index("idx_pr_policy_entity").on(table.policyEntityId),
  ]
);

// ── Race Candidates ──────────────────────────────────────────────────────
//
// Candidates participating in political races, with PAC backing info.
// For ballot measures, "candidates" are the "For" and "Against" sides.

export const raceCandidates = pgTable(
  "race_candidates",
  {
    id: varchar("id", { length: 10 }).primaryKey(),
    /** FK to political_races.id */
    raceId: varchar("race_id", { length: 10 })
      .notNull()
      .references(() => politicalRaces.id, { onDelete: "cascade" }),
    /** FK to entities.stable_id for the candidate */
    candidateEntityId: text("candidate_entity_id").references(
      () => entities.stableId,
      { onDelete: "set null" }
    ),
    /** Always present display name */
    candidateDisplayName: text("candidate_display_name").notNull(),
    isIncumbent: boolean("is_incumbent").notNull().default(false),
    isWinner: boolean("is_winner").notNull().default(false),
    /** Vote share as decimal (0.42 = 42%) */
    voteShare: numeric("vote_share"),
    /** Status: running, won, lost, withdrew */
    status: text("status").notNull().default("running"),
    /** FK to entities.stable_id for primary PAC */
    pacEntityId: text("pac_entity_id").references(
      () => entities.stableId,
      { onDelete: "set null" }
    ),
    /** PAC display name fallback */
    pacDisplayName: text("pac_display_name"),
    /** Total PAC spending in USD */
    pacAmount: numeric("pac_amount"),
    /** PAC position: support, oppose */
    pacPosition: text("pac_position"),
    party: text("party"),
    /** Notable endorsements */
    endorsements: text("endorsements"),
    /** AI stance: pro_regulation, anti_regulation, mixed, neutral */
    aiStance: text("ai_stance"),
    source: text("source"),
    notes: text("notes"),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_rc_race").on(table.raceId),
    index("idx_rc_candidate_entity").on(table.candidateEntityId),
    index("idx_rc_pac_entity").on(table.pacEntityId),
    index("idx_rc_status").on(table.status),
    index("idx_rc_ai_stance").on(table.aiStance),
  ]
);

// ============================================================================
// Claims-first sourcing — proposed_claims + claim_record_links
//
// Research agents propose structured claims about entities. A sourcing
// worker checks each claim against source evidence and records a verdict.
// claim_record_links connects approved claims to the records they affected.
//
// See: https://github.com/quantified-uncertainty/longterm-wiki/issues/3253
// ============================================================================

/**
 * Proposed claims — structured assertions submitted by research agents
 * for sourcing before being applied to TableBase records.
 */
export const proposedClaims = pgTable(
  "proposed_claims",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    batchId: text("batch_id").notNull(),

    // What's being claimed
    claimText: text("claim_text").notNull(),
    entityId: text("entity_id"),
    targetTable: text("target_table").notNull(),
    targetField: text("target_field"),
    proposedValue: text("proposed_value"),
    proposedData: jsonb("proposed_data"),

    // Source evidence (from research agent)
    resourceId: text("resource_id").references(() => resources.id, { onDelete: "set null" }),
    sourceUrl: text("source_url").notNull(),
    agentEvidence: text("agent_evidence"),

    // Source-check state (updated by worker)
    status: text("status").notNull().default("pending"),
    verdictConfidence: real("verdict_confidence"),
    verdictReasoning: text("verdict_reasoning"),
    extractedValue: text("extracted_value"),
    checkerModel: text("checker_model"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    evidenceId: bigint("evidence_id", { mode: "number" }),

    // Job tracking
    verificationJobId: bigint("verification_job_id", { mode: "number" }),

    // Audit
    submittedBy: text("submitted_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_pc_batch").on(table.batchId),
    index("idx_pc_status").on(table.status),
    index("idx_pc_entity").on(table.entityId),
    index("idx_pc_resource").on(table.resourceId),
    index("idx_pc_target").on(table.targetTable, table.entityId),
  ]
);

/**
 * Claim-record links — connects verified claims to the domain records
 * they were applied to (personnel, grants, funding_rounds, etc.).
 */
export const claimRecordLinks = pgTable(
  "claim_record_links",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    claimId: bigint("claim_id", { mode: "number" })
      .notNull()
      .references(() => proposedClaims.id, { onDelete: "cascade" }),
    recordType: text("record_type").notNull(),
    recordId: text("record_id").notNull(),
    matchVerdict: text("match_verdict"),
    matchConfidence: real("match_confidence"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_crl_claim").on(table.claimId),
    index("idx_crl_record").on(table.recordType, table.recordId),
    uniqueIndex("uq_crl_claim_record").on(table.claimId, table.recordType, table.recordId),
  ]
);

/**
 * Operations log — records manual DB operations, deploy actions, and other
 * production changes that don't naturally live in a PR or code commit.
 *
 * Linked to agent_sessions when the operation was performed during a session.
 */
export const operationsLog = pgTable(
  "operations_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    description: text("description").notNull(),
    prNumber: integer("pr_number"),
    agentSessionId: bigint("agent_session_id", { mode: "number" }).references(
      () => agentSessions.id,
      { onDelete: "set null" }
    ),
    operator: text("operator").notNull().default("agent"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_ops_log_created").on(table.createdAt),
    index("idx_ops_log_pr").on(table.prNumber),
    index("idx_ops_log_session").on(table.agentSessionId),
  ]
);

// ── Political Scores ────────────────────────────────────────────────────
//
// Scorecard ratings from interest groups (LCV, Humane Society, FP4A, etc.)
// for politicians. One row per (politician, scorer, year, scoreType).

export const politicalScores = pgTable(
  "political_scores",
  {
    id: varchar("id", { length: 10 }).primaryKey(),
    /** FK to entities.stable_id for the politician */
    politicianEntityId: text("politician_entity_id")
      .notNull()
      .references(() => entities.stableId, { onDelete: "cascade" }),
    /** Display name fallback when FK unresolved */
    politicianDisplayName: text("politician_display_name"),
    /** Scoring organization slug, e.g. 'lcv', 'humane_society', 'fp4a' */
    scorerOrg: text("scorer_org").notNull(),
    /** Optional FK to entities.stable_id for the scoring organization */
    scorerEntityId: text("scorer_entity_id").references(
      () => entities.stableId,
      { onDelete: "set null" }
    ),
    /** Score value, typically 0-100 */
    score: numeric("score").notNull(),
    /** Maximum possible score (default 100) */
    maxScore: numeric("max_score").notNull().default("100"),
    /** Year the score applies to */
    year: integer("year").notNull(),
    /** Category: 'environmental', 'animal_welfare', 'foreign_policy', etc. */
    scoreType: text("score_type"),
    /** URL to the scorecard page */
    sourceUrl: text("source_url"),
    notes: text("notes"),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_polscore_politician").on(table.politicianEntityId),
    index("idx_polscore_scorer").on(table.scorerEntityId),
    index("idx_polscore_year").on(table.year),
    index("idx_polscore_score_type").on(table.scoreType),
    uniqueIndex("uq_political_scores_natural_key").on(
      table.politicianEntityId,
      table.scorerOrg,
      table.year,
      table.scoreType
    ),
  ]
);

// ── Political Offices ───────────────────────────────────────────────────
//
// Current and past political offices held by politicians.
// Enables queries like "all current US senators" or "NC representatives".

export const politicalOffices = pgTable(
  "political_offices",
  {
    id: varchar("id", { length: 10 }).primaryKey(),
    /** FK to entities.stable_id for the politician */
    politicianEntityId: text("politician_entity_id")
      .notNull()
      .references(() => entities.stableId, { onDelete: "cascade" }),
    /** Display name fallback */
    politicianDisplayName: text("politician_display_name"),
    /** Office type: senator, representative, governor, state_senator, etc. */
    officeType: text("office_type").notNull(),
    /** Jurisdiction: 'US', 'NY', 'TX', etc. */
    jurisdiction: text("jurisdiction").notNull(),
    /** District: 'NC-4', 'NJ-5', etc. */
    district: text("district"),
    /** Party: 'democratic', 'republican', 'independent' */
    party: text("party"),
    /** Status: incumbent, candidate, former */
    status: text("status").notNull().default("incumbent"),
    /** Term start: YYYY or YYYY-MM */
    termStart: text("term_start"),
    /** Term end: YYYY or YYYY-MM */
    termEnd: text("term_end"),
    sourceUrl: text("source_url"),
    notes: text("notes"),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_poloffice_politician").on(table.politicianEntityId),
    index("idx_poloffice_type").on(table.officeType),
    index("idx_poloffice_jurisdiction").on(table.jurisdiction),
    index("idx_poloffice_party").on(table.party),
    index("idx_poloffice_status").on(table.status),
  ]
);

// ── Campaign Finance ──────────────────────────────────────────────────
//
// FEC campaign finance data for politicians.
// One row per (fec_candidate_id, cycle).

export const campaignFinance = pgTable(
  "campaign_finance",
  {
    id: varchar("id", { length: 10 }).primaryKey(),
    /** FK to entities.stable_id for the politician */
    politicianEntityId: varchar("politician_entity_id", { length: 40 }).references(
      () => entities.stableId,
      { onDelete: "set null" }
    ),
    /** Display name fallback */
    politicianDisplayName: varchar("politician_display_name", { length: 200 }),
    /** Election cycle year (2024, 2026, etc.) */
    cycle: integer("cycle").notNull(),
    /** Total raised during the cycle */
    totalRaised: numeric("total_raised", { precision: 14, scale: 2 }),
    /** Total spent during the cycle */
    totalSpent: numeric("total_spent", { precision: 14, scale: 2 }),
    /** Cash on hand */
    cashOnHand: numeric("cash_on_hand", { precision: 14, scale: 2 }),
    /** Contributions from individuals */
    individualContributions: numeric("individual_contributions", {
      precision: 14,
      scale: 2,
    }),
    /** Contributions from PACs */
    pacContributions: numeric("pac_contributions", { precision: 14, scale: 2 }),
    /** Small-dollar contributions (under $200) */
    smallDonorContributions: numeric("small_donor_contributions", {
      precision: 14,
      scale: 2,
    }),
    /** Self-funding by the candidate */
    selfFunding: numeric("self_funding", { precision: 14, scale: 2 }),
    /** Party affiliation */
    party: varchar("party", { length: 20 }),
    /** Office type: senate, house, president */
    officeType: varchar("office_type", { length: 30 }),
    /** State abbreviation */
    state: varchar("state", { length: 5 }),
    /** District (e.g., "01", "AL" for at-large) */
    district: varchar("district", { length: 10 }),
    /** FEC candidate ID (e.g., H2NC04290) */
    fecCandidateId: varchar("fec_candidate_id", { length: 20 }),
    /** URL to FEC source */
    sourceUrl: text("source_url"),
    /** Date the FEC data was last updated */
    dataAsOf: date("data_as_of"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_campfin_politician").on(table.politicianEntityId),
    index("idx_campfin_cycle").on(table.cycle),
    index("idx_campfin_state").on(table.state),
    index("idx_campfin_office_type").on(table.officeType),
    uniqueIndex("uq_campaign_finance_natural_key").on(
      table.fecCandidateId,
      table.cycle
    ),
  ]
);

// ── Political Votes ───────────────────────────────────────────────────
//
// Roll call voting records for tracked legislation (congressional and state).
// One row per (politician, legislation, roll_call_number, congress_number).

export const politicalVotes = pgTable(
  "political_votes",
  {
    id: varchar("id", { length: 10 }).primaryKey(),
    /** FK to entities.stable_id for the politician (nullable for external politicians) */
    politicianEntityId: varchar("politician_entity_id", { length: 40 }).references(
      () => entities.stableId,
      { onDelete: "cascade" }
    ),
    /** Display name fallback when FK unresolved */
    politicianDisplayName: varchar("politician_display_name", { length: 200 }),
    /** Legislation entity slug in responses.yaml (e.g., "california-sb1047") */
    legislationEntityId: varchar("legislation_entity_id", { length: 100 }),
    /** Human-readable title of the legislation */
    legislationTitle: varchar("legislation_title", { length: 500 }),
    /** Vote cast: yea, nay, abstain, not_voting, present */
    vote: varchar("vote", { length: 20 }).notNull(),
    /** Date the vote was cast */
    voteDate: date("vote_date"),
    /** Chamber: senate, house, state_senate, state_assembly */
    chamber: varchar("chamber", { length: 20 }),
    /** Roll call number for the vote */
    rollCallNumber: integer("roll_call_number"),
    /** Congress number (e.g., 118, 119) */
    congressNumber: integer("congress_number"),
    /** Session within a Congress (1 or 2) */
    session: integer("session"),
    /** URL to the vote record source */
    sourceUrl: text("source_url"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_polvote_politician").on(table.politicianEntityId),
    index("idx_polvote_legislation").on(table.legislationEntityId),
    index("idx_polvote_date").on(table.voteDate),
    index("idx_polvote_chamber").on(table.chamber),
    uniqueIndex("uq_political_votes_natural_key").on(
      table.politicianEntityId,
      table.legislationEntityId,
      table.rollCallNumber,
      table.congressNumber,
    ),
  ]
);

// ── Coverage Scans ─────────────────────────────────────────────────

export const tablebaseCoverageScans = pgTable(
  "tablebase_coverage_scans",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    coverageScore: integer("coverage_score").notNull(),
    signalsFilled: integer("signals_filled").notNull().default(0),
    signalsTotal: integer("signals_total").notNull().default(0),
    signals: jsonb("signals").notNull().default({}),
    scannedAt: timestamp("scanned_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_coverage_scans_entity").on(table.entityId),
    index("idx_coverage_scans_type_score").on(table.entityType, table.coverageScore),
    index("idx_coverage_scans_scanned_at").on(table.scannedAt),
  ],
);

// ── Scanner Results ──────────────────────────────────────────────

export const tablebaseScannerResults = pgTable(
  "tablebase_scanner_results",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    scanRunId: text("scan_run_id").notNull(),
    recordType: text("record_type").notNull(),
    entityId: text("entity_id").notNull(),
    entityName: text("entity_name").notNull(),
    entityType: text("entity_type").notNull(),
    totalRecords: integer("total_records").notNull().default(0),
    verifiedRecords: integer("verified_records").notNull().default(0),
    completenessPct: real("completeness_pct").notNull().default(0),
    missingFields: jsonb("missing_fields").notNull().default([]),
    entityImportance: real("entity_importance"),
    scannedAt: timestamp("scanned_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_scanner_results_run_id").on(table.scanRunId),
    index("idx_scanner_results_entity").on(table.entityId),
    index("idx_scanner_results_scanned_at").on(table.scannedAt),
    index("idx_scanner_results_type_entity").on(table.recordType, table.entityId),
    uniqueIndex("uq_scanner_results_natural_key").on(table.scanRunId, table.recordType, table.entityId),
  ],
);
