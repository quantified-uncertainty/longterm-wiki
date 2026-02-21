import {
  pgTable,
  pgSequence,
  text,
  integer,
  bigint,
  bigserial,
  boolean,
  real,
  date,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";

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
    pageId: text("page_id").notNull(),
    footnote: integer("footnote").notNull(),
    url: text("url"),
    resourceId: text("resource_id"),
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
  ]
);

export const wikiPages = pgTable(
  "wiki_pages",
  {
    id: text("id").primaryKey(),
    numericId: text("numeric_id"),
    title: text("title").notNull(),
    description: text("description"),
    llmSummary: text("llm_summary"),
    category: text("category"),
    subcategory: text("subcategory"),
    entityType: text("entity_type"),
    tags: text("tags"),
    quality: integer("quality"),
    readerImportance: integer("reader_importance"),
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
    // GIN index on search_vector is created in migration SQL
  ]
);

export const citationContent = pgTable("citation_content", {
  url: text("url").primaryKey(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
  httpStatus: integer("http_status"),
  contentType: text("content_type"),
  pageTitle: text("page_title"),
  fullTextPreview: text("full_text_preview"),
  contentLength: integer("content_length"),
  contentHash: text("content_hash"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const citationAccuracySnapshots = pgTable(
  "citation_accuracy_snapshots",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    pageId: text("page_id").notNull(),
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
    pageId: text("page_id").notNull(),
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
    pageId: text("page_id").notNull(),
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
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
    pageId: text("page_id").notNull(),
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
    index("idx_aur_started_at").on(table.startedAt),
  ]
);

export const autoUpdateResults = pgTable(
  "auto_update_results",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: bigint("run_id", { mode: "number" })
      .notNull()
      .references(() => autoUpdateRuns.id, { onDelete: "cascade" }),
    pageId: text("page_id").notNull(),
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
    entityId: text("entity_id").primaryKey(),
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

/**
 * Claims extracted from wiki pages.
 *
 * `entityId` is a logical reference to a wiki entity (page or data entity)
 * but is NOT enforced via FK — claims may reference entities from multiple
 * source tables (wikiPages, summaries, etc.) or entities not yet synced.
 */
export const claims = pgTable(
  "claims",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    entityId: text("entity_id").notNull(), // logical FK — see table comment above
    entityType: text("entity_type").notNull(),
    claimType: text("claim_type").notNull(),
    claimText: text("claim_text").notNull(),
    value: text("value"),
    unit: text("unit"),
    confidence: text("confidence"),
    sourceQuote: text("source_quote"),
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
    // GIN index on search_vector is created in migration SQL
  ]
);

export const resourceCitations = pgTable(
  "resource_citations",
  {
    resourceId: text("resource_id")
      .notNull()
      .references(() => resources.id, { onDelete: "cascade" }),
    pageId: text("page_id").notNull(),
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
    sourceId: text("source_id").notNull(),
    targetId: text("target_id").notNull(),
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
    routedToPageId: text("routed_to_page_id"),
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
