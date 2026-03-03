import {
  pgTable,
  pgSequence,
  text,
  varchar,
  integer,
  bigint,
  bigserial,
  boolean,
  real,
  doublePrecision,
  date,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const entityIdSeq = pgSequence("entity_id_seq", { startWith: 1 });

export const entityIds = pgTable("entity_ids", {
  numericId: integer("numeric_id").primaryKey(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const citationQuotes = pgTable(
  "citation_quotes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    pageId: text("page_id_old")
      .notNull()
      .references(() => wikiPages.id, { onDelete: "cascade" }),
    pageIdInt: integer("page_id_int").references(() => wikiPages.integerIdCol), // Phase 4a: integer PK migration (#1498)
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
    claimId: bigint("claim_id", { mode: "number" }).references(() => claims.id, {
      onDelete: "set null",
    }),
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

export const wikiPages = pgTable(
  "wiki_pages",
  {
    id: text("id").primaryKey(),
    numericId: text("numeric_id"),
    // Phase 4a: new columns for integer PK migration (#1498)
    slug: text("slug").notNull().unique(),
    integerIdCol: integer("integer_id").unique(),
    title: text("title").notNull(),
    description: text("description"),
    llmSummary: text("llm_summary"),
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
    index("idx_wp_numeric_id").on(table.numericId),
    index("idx_wp_category").on(table.category),
    index("idx_wp_entity_type").on(table.entityType),
    index("idx_wp_reader_importance").on(table.readerImportance),
    index("idx_wp_recommended_score").on(table.recommendedScore),
    // GIN index on search_vector is created in migration SQL
  ]
);

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

export const citationAccuracySnapshots = pgTable(
  "citation_accuracy_snapshots",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    pageId: text("page_id_old")
      .notNull()
      .references(() => wikiPages.id, { onDelete: "cascade" }),
    pageIdInt: integer("page_id_int").references(() => wikiPages.integerIdCol), // Phase 4a: integer PK migration (#1498)
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
    pageId: text("page_id_old")
      .notNull()
      .references(() => wikiPages.id, { onDelete: "cascade" }),
    pageIdInt: integer("page_id_int").references(() => wikiPages.integerIdCol), // Phase 4a: integer PK migration (#1498)
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
    pageId: text("page_id_old")
      .notNull()
      .references(() => wikiPages.id, { onDelete: "cascade" }),
    pageIdInt: integer("page_id_int").references(() => wikiPages.integerIdCol), // Phase 4a: integer PK migration (#1498)
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
    pageId: text("page_id_old")
      .notNull()
      .references(() => wikiPages.id, { onDelete: "cascade" }),
    pageIdInt: integer("page_id_int").references(() => wikiPages.integerIdCol), // Phase 4a: integer PK migration (#1498)
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
    pageId: text("page_id_old")
      .notNull()
      .references(() => wikiPages.id, { onDelete: "cascade" }),
    pageIdInt: integer("page_id_int").references(() => wikiPages.integerIdCol), // Phase 4a: integer PK migration (#1498)
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
      .references(() => entities.id, { onDelete: "cascade" }),
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
export const claims = pgTable(
  "claims",
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
export const claimSources = pgTable(
  "claim_sources",
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
export const claimPageReferences = pgTable(
  "claim_page_references",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    claimId: bigint("claim_id", { mode: "number" })
      .notNull()
      .references(() => claims.id, { onDelete: "cascade" }),
    pageId: text("page_id_old")
      .notNull()
      .references(() => wikiPages.id, { onDelete: "cascade" }),
    pageIdInt: integer("page_id_int").references(() => wikiPages.integerIdCol), // Phase 4a: integer PK migration (#1498)
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
    publishedDate: date("published_date"),
    tags: jsonb("tags").$type<string[]>(),
    localFilename: text("local_filename"),
    credibilityOverride: real("credibility_override"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }),
    contentHash: text("content_hash"),
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
    // GIN indexes on tags, authors, and search_vector are created in migration SQL
    // (Drizzle doesn't support GIN index declarations)
  ]
);

export const resourceCitations = pgTable(
  "resource_citations",
  {
    resourceId: text("resource_id")
      .notNull()
      .references(() => resources.id, { onDelete: "cascade" }),
    pageId: text("page_id_old")
      .notNull()
      .references(() => wikiPages.id, { onDelete: "cascade" }),
    pageIdInt: integer("page_id_int").references(() => wikiPages.integerIdCol), // Phase 4a: integer PK migration (#1498)
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.resourceId, table.pageId] }),
    index("idx_rc_page_id").on(table.pageId),
  ]
);

/**
 * Entities — read mirror of data/entities/*.yaml files.
 *
 * Stores the full entity metadata (type, title, description, tags, etc.)
 * synced from the YAML source files during build. YAML stays authoritative;
 * this table is a queryable read mirror for the API.
 */
export const entities = pgTable(
  "entities",
  {
    id: text("id").primaryKey(),
    numericId: text("numeric_id"),
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
    sources: jsonb("sources").$type<
      Array<{ title: string; url?: string; author?: string; date?: string }>
    >(),
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
    index("idx_ent_numeric_id").on(table.numericId),
    index("idx_ent_entity_type").on(table.entityType),
    index("idx_ent_title").on(table.title),
  ]
);

/**
 * Facts — read mirror of data/facts/*.yaml files.
 *
 * Stores individual facts tied to entities, including timeseries data
 * (grouped by measure). YAML stays authoritative; this table is a queryable
 * read mirror for the API.
 */
export const facts = pgTable(
  "facts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    entityId: text("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    factId: text("fact_id").notNull(),
    label: text("label"),
    value: text("value"), // String representation of the value
    numeric: real("numeric"), // Parsed numeric value (null for non-numeric)
    low: real("low"), // Lower bound for range values
    high: real("high"), // Upper bound for range values
    asOf: text("as_of"), // Point-in-time (YYYY-MM, YYYY, or ISO date)
    measure: text("measure"), // Measure ID for timeseries grouping
    subject: text("subject").references(() => entities.id, {
      onDelete: "set null",
    }),
    note: text("note"),
    source: text("source"), // URL to source
    sourceResource: text("source_resource").references(() => resources.id, {
      onDelete: "set null",
    }),
    format: text("format"),
    formatDivisor: real("format_divisor"),
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
    sourceId: text("source_id_old").notNull(),
    targetId: text("target_id_old").notNull(),
    sourceIdInt: integer("source_id_int").references(() => wikiPages.integerIdCol), // Phase 4a: integer PK migration (#1498)
    targetIdInt: integer("target_id_int").references(() => wikiPages.integerIdCol), // Phase 4a: integer PK migration (#1498)
    linkType: text("link_type").notNull(), // 'yaml_related' | 'entity_link' | 'name_prefix' | 'similarity' | 'shared_tag'
    relationship: text("relationship"), // e.g. 'causes', 'mitigates' — only for yaml_related
    weight: real("weight").notNull().default(1.0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_pl_source_target_type").on(
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
    routedToPageId: text("routed_to_page_id_old").references(() => wikiPages.id, {
      onDelete: "set null",
    }),
    routedToPageIdInt: integer("routed_to_page_id_int").references(() => wikiPages.integerIdCol), // Phase 4a: integer PK migration (#1498)
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
    index("idx_auni_routed_page").on(table.routedToPageId),
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
    pageId: text("page_id_old")
      .notNull()
      .references(() => wikiPages.id, { onDelete: "cascade" }),
    pageIdInt: integer("page_id_int").references(() => wikiPages.integerIdCol), // Phase 4a: integer PK migration (#1498)
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
    event: text("event").notNull(), // success | failure | error | circuit_breaker_tripped | skipped
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
export const statements = pgTable(
  "statements",
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
    // --- Metadata ---
    status: text("status").notNull().default("active"), // "active", "superseded", "retracted"
    archiveReason: text("archive_reason"), // why this statement was superseded/retracted
    sourceFactKey: text("source_fact_key"), // "anthropic.6796e194" — YAML migration traceability
    note: text("note"),
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
  ]
);

/**
 * Statement citations — links statements to source resources.
 *
 * Each row represents one resource backing a statement. Supports both
 * resource_id (linked to data/resources/) and raw URL fallback.
 */
export const statementCitations = pgTable(
  "statement_citations",
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

export const pageCitations = pgTable(
  "page_citations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    referenceId: varchar("reference_id").notNull().unique(),
    pageId: text("page_id_old")
      .notNull()
      .references(() => wikiPages.id),
    pageIdInt: integer("page_id_int").references(() => wikiPages.integerIdCol), // Phase 4a: integer PK migration (#1498)
    title: varchar("title"),
    url: varchar("url"),
    note: text("note"),
    resourceId: text("resource_id").references(() => resources.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_pc_page_id").on(table.pageId),
    index("idx_pc_reference_id").on(table.referenceId),
  ]
);
