import {
  pgTable,
  pgSequence,
  text,
  integer,
  bigserial,
  boolean,
  real,
  date,
  timestamp,
  uniqueIndex,
  index,
  jsonb,
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

export const citationContent = pgTable(
  "citation_content",
  {
    url: text("url").primaryKey(),
    pageId: text("page_id").notNull(),
    footnote: integer("footnote").notNull(),
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
  },
  (table) => [index("idx_cc_page_id").on(table.pageId)]
);

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
    sessionId: bigserial("session_id", { mode: "number" })
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    pageId: text("page_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.pageId] }),
    index("idx_sp_page_id").on(table.pageId),
  ]
);
