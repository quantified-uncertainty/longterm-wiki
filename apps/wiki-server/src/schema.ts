import {
  pgTable,
  pgSequence,
  text,
  integer,
  bigserial,
  boolean,
  real,
  timestamp,
  uniqueIndex,
  index,
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
