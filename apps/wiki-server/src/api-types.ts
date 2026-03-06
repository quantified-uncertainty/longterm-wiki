/**
 * Shared API Types — Canonical Zod schemas for wiki-server request/response shapes.
 *
 * These schemas are the single source of truth for API validation. They are imported
 * by both the wiki-server route handlers (for runtime validation) and the crux client
 * library (for TypeScript type inference via `z.infer<>`).
 *
 * Convention:
 *   - `XyzSchema`     — Zod schema for runtime validation
 *   - `Xyz`           — TypeScript type inferred from the schema (`z.infer<typeof XyzSchema>`)
 *   - Input types     — Shapes the client sends to the server
 *   - Result types    — Shapes the server returns to the client (not validated here;
 *                        defined as plain TS interfaces for documentation)
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

/** Default maximum items per batch for most endpoints. */
export const MAX_BATCH_SIZE = 200;

// ---------------------------------------------------------------------------
// Common patterns
// ---------------------------------------------------------------------------

export const DateStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const PageIdSchema = z.string().min(1).max(200);

// ---------------------------------------------------------------------------
// Edit Logs
// ---------------------------------------------------------------------------

export const VALID_TOOLS = [
  "crux-create",
  "crux-improve",
  "crux-grade",
  "crux-fix",
  "crux-fix-escalated",
  "crux-audit",
  "crux-audit-escalated",
  "crux-audit-source-replace",
  "crux-audit-pass2",
  "claude-code",
  "manual",
  "bulk-script",
] as const;

export const VALID_AGENCIES = ["human", "ai-directed", "automated"] as const;

export const EditLogEntrySchema = z.object({
  pageId: PageIdSchema,
  date: DateStringSchema,
  tool: z.enum(VALID_TOOLS),
  agency: z.enum(VALID_AGENCIES),
  requestedBy: z.string().max(200).nullable().optional(),
  note: z.string().max(5000).nullable().optional(),
});
export type EditLogEntry = z.infer<typeof EditLogEntrySchema>;

export const EditLogBatchSchema = z.object({
  items: z.array(EditLogEntrySchema).min(1).max(MAX_BATCH_SIZE),
});
export type EditLogBatch = z.infer<typeof EditLogBatchSchema>;

// ---------------------------------------------------------------------------
// Citation Quotes
// ---------------------------------------------------------------------------

export const UpsertCitationQuoteSchema = z.object({
  pageId: PageIdSchema,
  footnote: z.number().int().min(0),
  url: z.string().max(2000).nullable().optional(),
  resourceId: z.string().max(200).nullable().optional(),
  claimText: z.string().min(1).max(10000),
  claimContext: z.string().max(10000).nullable().optional(),
  sourceQuote: z.string().max(10000).nullable().optional(),
  sourceLocation: z.string().max(1000).nullable().optional(),
  quoteVerified: z.boolean().optional(),
  verificationMethod: z.string().max(200).nullable().optional(),
  verificationScore: z.number().min(0).max(1).nullable().optional(),
  sourceTitle: z.string().max(1000).nullable().optional(),
  sourceType: z.string().max(100).nullable().optional(),
  extractionModel: z.string().max(200).nullable().optional(),
});
export type UpsertCitationQuote = z.infer<typeof UpsertCitationQuoteSchema>;

export const UpsertCitationQuoteBatchSchema = z.object({
  items: z.array(UpsertCitationQuoteSchema).min(1).max(100),
});

// ---------------------------------------------------------------------------
// Citation Accuracy
// ---------------------------------------------------------------------------

export const AccuracyVerdictSchema = z.enum([
  "accurate",
  "inaccurate",
  "unsupported",
  "minor_issues",
  "not_verifiable",
]);
export type AccuracyVerdict = z.infer<typeof AccuracyVerdictSchema>;

/** Runtime-accessible array of valid verdict values — use for iteration/aggregation. */
export const ACCURACY_VERDICTS = AccuracyVerdictSchema.options;

export const MarkAccuracySchema = z.object({
  pageId: PageIdSchema,
  footnote: z.number().int().min(0),
  verdict: AccuracyVerdictSchema,
  score: z.number().min(0).max(1),
  issues: z.string().max(10000).nullable().optional(),
  supportingQuotes: z.string().max(10000).nullable().optional(),
  verificationDifficulty: z
    .enum(["easy", "moderate", "hard"])
    .nullable()
    .optional(),
});
export type MarkAccuracy = z.infer<typeof MarkAccuracySchema>;

export const MarkAccuracyBatchSchema = z.object({
  items: z.array(MarkAccuracySchema).min(1).max(100),
});

export interface AccuracyDashboardData {
  exportedAt: string;
  summary: {
    totalCitations: number;
    checkedCitations: number;
    accurateCitations: number;
    inaccurateCitations: number;
    unsupportedCitations: number;
    minorIssueCitations: number;
    uncheckedCitations: number;
    averageScore: number | null;
  };
  verdictDistribution: Record<string, number>;
  difficultyDistribution: Record<string, number>;
  pages: Array<{
    pageId: string;
    totalCitations: number;
    checked: number;
    accurate: number;
    inaccurate: number;
    unsupported: number;
    minorIssues: number;
    accuracyRate: number | null;
    avgScore: number | null;
  }>;
  flaggedCitations: Array<{
    pageId: string;
    footnote: number;
    claimText: string;
    sourceTitle: string | null;
    url: string | null;
    verdict: string;
    score: number | null;
    issues: string | null;
    difficulty: string | null;
    checkedAt: string | null;
  }>;
  domainAnalysis: Array<{
    domain: string;
    totalCitations: number;
    checked: number;
    accurate: number;
    inaccurate: number;
    unsupported: number;
    minorIssues: number;
    inaccuracyRate: number | null;
  }>;
}

// ---------------------------------------------------------------------------
// Citation Content
// ---------------------------------------------------------------------------

/** Maximum size for the full-text preview field (50 KB). */
export const CITATION_CONTENT_PREVIEW_MAX = 50 * 1024;
/** Maximum size for the full_text field (5 MB). */
export const CITATION_CONTENT_FULL_TEXT_MAX = 5 * 1024 * 1024;

export const UpsertCitationContentSchema = z.object({
  url: z.string().min(1).max(2000),
  resourceId: z.string().max(200).nullable().optional(),
  fetchedAt: z.string().datetime(),
  httpStatus: z.number().int().nullable().optional(),
  contentType: z.string().max(200).nullable().optional(),
  pageTitle: z.string().max(1000).nullable().optional(),
  fullTextPreview: z.string().max(CITATION_CONTENT_PREVIEW_MAX).nullable().optional(),
  fullText: z.string().max(CITATION_CONTENT_FULL_TEXT_MAX).nullable().optional(),
  contentLength: z.number().int().nullable().optional(),
  contentHash: z.string().max(64).nullable().optional(),
});
export type UpsertCitationContent = z.infer<typeof UpsertCitationContentSchema>;

// -- Citation Content: Response types -----------------------------------------

export interface CitationContentRow {
  url: string;
  resourceId: string | null;
  fetchedAt: string;
  httpStatus: number | null;
  contentType: string | null;
  pageTitle: string | null;
  fullTextPreview: string | null;
  fullText: string | null;
  contentLength: number | null;
  contentHash: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CitationContentListEntry {
  url: string;
  fetchedAt: string;
  httpStatus: number | null;
  contentType: string | null;
  pageTitle: string | null;
  contentLength: number | null;
  contentHash: string | null;
  hasFullText: boolean;
  hasPreview: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CitationContentListResult {
  entries: CitationContentListEntry[];
  total: number;
  withFullText: number;
  withPreview: number;
  limit: number;
  offset: number;
}

export interface CitationContentStatsResult {
  total: number;
  withFullText: number;
  withPreview: number;
  coverage: number;
  okCount: number;
  deadCount: number;
  avgContentLength: number | null;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const CreateSessionSchema = z.object({
  date: DateStringSchema,
  branch: z.string().max(500).nullable().optional(),
  title: z.string().min(1).max(1000),
  summary: z.string().max(10000).nullable().optional(),
  model: z.string().max(100).nullable().optional(),
  duration: z.string().max(100).nullable().optional(),
  cost: z.string().max(100).nullable().optional(),
  /** Numeric cost in integer cents, auto-parsed from `cost` string if not provided. Enables aggregation and alerting. */
  costCents: z.number().int().min(0).nullable().optional(),
  /** Numeric duration in minutes (float), auto-parsed from `duration` string if not provided. Enables aggregation. */
  durationMinutes: z.number().min(0).nullable().optional(),
  prUrl: z.string().max(1000).nullable().optional(),
  checksYaml: z.string().max(10000).nullable().optional(),
  issuesJson: z.unknown().nullable().optional(),
  learningsJson: z.unknown().nullable().optional(),
  recommendationsJson: z.unknown().nullable().optional(),
  /** Whether /review-pr was run during this session. NULL = unknown (pre-feature). */
  reviewed: z.boolean().nullable().optional(),
  pages: z
    .array(z.string().min(1).max(200))
    .optional()
    .default([])
    .transform((arr) => [...new Set(arr)]),
});
export type CreateSession = z.infer<typeof CreateSessionSchema>;

export const CreateSessionBatchSchema = z.object({
  items: z.array(CreateSessionSchema).min(1).max(MAX_BATCH_SIZE),
});

// ---------------------------------------------------------------------------
// Auto-Update Runs
// ---------------------------------------------------------------------------

export const AutoUpdateResultSchema = z.object({
  pageId: z.string().min(1).max(200),
  status: z.enum(["success", "failed", "skipped"]),
  tier: z.string().max(50).nullable().optional(),
  durationMs: z.number().int().min(0).nullable().optional(),
  errorMessage: z.string().max(5000).nullable().optional(),
});
export type AutoUpdateResult = z.infer<typeof AutoUpdateResultSchema>;

export const RecordAutoUpdateRunSchema = z.object({
  date: DateStringSchema,
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable().optional(),
  trigger: z.enum(["scheduled", "manual"]),
  budgetLimit: z.number().min(0).nullable().optional(),
  budgetSpent: z.number().min(0).nullable().optional(),
  sourcesChecked: z.number().int().min(0).nullable().optional(),
  sourcesFailed: z.number().int().min(0).nullable().optional(),
  itemsFetched: z.number().int().min(0).nullable().optional(),
  itemsRelevant: z.number().int().min(0).nullable().optional(),
  pagesPlanned: z.number().int().min(0).nullable().optional(),
  pagesUpdated: z.number().int().min(0).nullable().optional(),
  pagesFailed: z.number().int().min(0).nullable().optional(),
  pagesSkipped: z.number().int().min(0).nullable().optional(),
  newPagesCreated: z.array(z.string()).optional(),
  results: z.array(AutoUpdateResultSchema).max(100).optional(),
});
export type RecordAutoUpdateRun = z.infer<typeof RecordAutoUpdateRunSchema>;

// ---------------------------------------------------------------------------
// Auto-Update News Items
// ---------------------------------------------------------------------------

export const AutoUpdateNewsItemSchema = z.object({
  title: z.string().min(1).max(2000),
  url: z.string().min(1).max(5000),
  sourceId: z.string().min(1).max(200),
  publishedAt: z.string().max(100).nullable().optional(),
  summary: z.string().max(5000).nullable().optional(),
  relevanceScore: z.number().int().min(0).max(100).nullable().optional(),
  topics: z.array(z.string().max(200)).optional().default([]),
  entities: z.array(z.string().max(200)).optional().default([]),
  routedToPageId: z.string().max(200).nullable().optional(),
  routedToPageTitle: z.string().max(500).nullable().optional(),
  routedTier: z.string().max(50).nullable().optional(),
});
export type AutoUpdateNewsItemInput = z.infer<typeof AutoUpdateNewsItemSchema>;

export const AutoUpdateNewsBatchSchema = z.object({
  runId: z.number().int().positive(),
  items: z.array(AutoUpdateNewsItemSchema).min(1).max(500),
});

// ---------------------------------------------------------------------------
// Hallucination Risk
// ---------------------------------------------------------------------------

export const RiskSnapshotSchema = z.object({
  pageId: z.string().min(1).max(300),
  score: z.number().int().min(0).max(100),
  level: z.enum(["low", "medium", "high"]),
  factors: z.array(z.string()).nullable().optional(),
  integrityIssues: z.array(z.string()).nullable().optional(),
});
export type RiskSnapshotInput = z.infer<typeof RiskSnapshotSchema>;

export const RiskSnapshotBatchSchema = z.object({
  snapshots: z.array(RiskSnapshotSchema).min(1).max(700),
});

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

export const UpsertSummarySchema = z.object({
  entityId: z.string().min(1).max(300),
  entityType: z.string().min(1).max(100),
  oneLiner: z.string().max(1000).nullable().optional(),
  summary: z.string().max(50000).nullable().optional(),
  review: z.string().max(50000).nullable().optional(),
  keyPoints: z.array(z.string().max(2000)).max(50).nullable().optional(),
  keyClaims: z.array(z.string().max(2000)).max(50).nullable().optional(),
  model: z.string().max(200).nullable().optional(),
  tokensUsed: z.number().int().min(0).nullable().optional(),
});
export type UpsertSummary = z.infer<typeof UpsertSummarySchema>;

export const UpsertSummaryBatchSchema = z.object({
  items: z.array(UpsertSummarySchema).min(1).max(MAX_BATCH_SIZE),
});

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

/**
 * Claim category taxonomy — high-level grouping for how a claim should be
 * treated, verified, and displayed.
 */
export const ClaimCategorySchema = z.enum([
  "factual", // Verifiable against sources (dates, events, numbers)
  "opinion", // Subjective evaluations, value judgments
  "analytical", // Wiki's own inferences drawn from evidence
  "speculative", // Uncertain projections, predictions
  "relational", // Cross-entity comparisons or relationships
]);
export type ClaimCategory = z.infer<typeof ClaimCategorySchema>;

/**
 * Claim type — granular classification matching the claim-first architecture
 * taxonomy (E892). These map to different verification strategies.
 */
export const ClaimTypeSchema = z.enum([
  // Core types (existing)
  "factual", // Verifiable against a single source
  "evaluative", // Subjective assessments or judgments
  "causal", // Cause-effect assertions
  "historical", // Historical events with dates
  // Extended types (from claim-first architecture)
  "numeric", // Numeric values that should link to fact system
  "consensus", // Claims requiring multiple source agreement
  "speculative", // Explicit predictions or uncertain projections
  "relational", // Cross-entity comparisons
]);
export type ClaimType = z.infer<typeof ClaimTypeSchema>;

export const InferenceTypeSchema = z.enum([
  "direct_assertion",
  "derived",
  "aggregated",
  "interpreted",
  "editorial",
]);
export type InferenceType = z.infer<typeof InferenceTypeSchema>;

export const ClaimModeSchema = z.enum(["endorsed", "attributed"]);
export type ClaimMode = z.infer<typeof ClaimModeSchema>;

export const ClaimVerdictSchema = z.enum([
  "verified",
  "unsupported",
  "disputed",
  "unverified",
]);
export type ClaimVerdict = z.infer<typeof ClaimVerdictSchema>;

export const VerdictDifficultySchema = z.enum(["easy", "moderate", "hard"]);
export type VerdictDifficulty = z.infer<typeof VerdictDifficultySchema>;

export const InsertClaimSchema = z.object({
  entityId: z.string().min(1).max(300),
  entityType: z.string().min(1).max(100),
  claimType: z.string().min(1).max(100),
  claimText: z.string().min(1).max(10000),
  // @deprecated — legacy text fields; use valueNumeric/valueLow/valueHigh + measure instead.
  // Still accepted for backward compat but not used by new code paths.
  value: z.string().max(1000).nullable().optional(),
  unit: z.string().max(100).nullable().optional(),
  /** @deprecated Use claimVerdict instead. Kept for backward compatibility. */
  confidence: z.string().max(100).nullable().optional(),
  /** @deprecated Use sources[] (claim_sources table) instead. Kept for backward compat (double-write). */
  sourceQuote: z.string().max(10000).nullable().optional(),
  // Enhanced fields (migration 0028)
  claimCategory: ClaimCategorySchema.nullable().optional(),
  relatedEntities: z.array(z.string().max(300)).nullable().optional(),
  factId: z.string().max(300).nullable().optional(),
  resourceIds: z.array(z.string().max(300)).nullable().optional(),
  section: z.string().max(1000).nullable().optional(),
  /** @deprecated Use claim_page_references table instead. Kept for backward compat. */
  footnoteRefs: z.string().max(500).nullable().optional(),
  // Phase 2 fields (migration 0029)
  claimMode: ClaimModeSchema.nullable().optional(),
  attributedTo: z.string().max(300).nullable().optional(),
  asOf: z.string().max(20).nullable().optional(), // YYYY-MM or YYYY-MM-DD
  measure: z.string().max(200).nullable().optional(),
  valueNumeric: z.number().nullable().optional(),
  valueLow: z.number().nullable().optional(),
  valueHigh: z.number().nullable().optional(),
  // Verdict fields (migration 0031)
  claimVerdict: ClaimVerdictSchema.nullable().optional(),
  claimVerdictScore: z.number().min(0).max(1).nullable().optional(),
  claimVerdictIssues: z.string().max(10000).nullable().optional(),
  claimVerdictQuotes: z.string().max(10000).nullable().optional(),
  claimVerdictDifficulty: VerdictDifficultySchema.nullable().optional(),
  claimVerdictModel: z.string().max(200).nullable().optional(),
  // Structured claim fields (migration 0032)
  subjectEntity: z.string().max(300).nullable().optional(),    // entity_id this claim is about
  property: z.string().max(200).nullable().optional(),         // property from controlled vocabulary
  structuredValue: z.string().max(2000).nullable().optional(), // normalized value
  valueUnit: z.string().max(100).nullable().optional(),        // unit of measurement (USD, percent, count, etc.)
  valueDate: z.string().max(20).nullable().optional(),         // YYYY-MM-DD when the value was true/measured
  qualifiers: z.record(z.string()).nullable().optional(),      // additional context (e.g. {"round": "Series B"})
  // Reasoning traces (migration 0034)
  inferenceType: InferenceTypeSchema.nullable().optional(),
  // Inline sources — optional list of sources to create in claim_sources table
  sources: z.array(z.object({
    resourceId: z.string().max(300).nullable().optional(),
    url: z.string().max(2000).nullable().optional(),
    sourceQuote: z.string().max(10000).nullable().optional(),
    isPrimary: z.boolean().optional(),
    sourceTitle: z.string().max(1000).nullable().optional(),
    sourceType: z.string().max(100).nullable().optional(),
    sourceLocation: z.string().max(1000).nullable().optional(),
    sourceVerdict: z.string().max(100).nullable().optional(),
    sourceVerdictScore: z.number().min(0).max(1).nullable().optional(),
    sourceCheckedAt: z.string().nullable().optional(),
  })).nullable().optional(),
});
export type InsertClaim = z.infer<typeof InsertClaimSchema>;

export const InsertClaimBatchSchema = z.object({
  items: z.array(InsertClaimSchema).min(1).max(500),
});

export const ClearClaimsSchema = z.object({
  entityId: z.string().min(1).max(300),
});

/** Clear only claims for a specific entity+section combination (used by --force on resource ingestion). */
export const ClearClaimsBySectionSchema = z.object({
  entityId: z.string().min(1).max(300),
  section: z.string().min(1).max(500),
});

// -- Claims: Response types ---------------------------------------------------

export interface ClaimSourceRow {
  id: number;
  claimId: number;
  resourceId: string | null;
  url: string | null;
  sourceQuote: string | null;
  isPrimary: boolean;
  addedAt: string;
  sourceVerdict: string | null;
  sourceVerdictScore: number | null;
  sourceVerdictIssues: string | null;
  sourceCheckedAt: string | null;
  sourceTitle: string | null;
  sourceType: string | null;
  sourceLocation: string | null;
}

export interface ClaimRow {
  id: number;
  entityId: string;
  entityType: string;
  claimType: string;
  claimText: string;
  /** @deprecated Use valueNumeric/valueLow/valueHigh instead */
  value: string | null;
  /** @deprecated Use measure instead */
  unit: string | null;
  /** @deprecated Use claimVerdict instead. */
  confidence: string | null;
  /** @deprecated Use sources[] (from claim_sources table) instead. */
  sourceQuote: string | null;
  // Enhanced fields (migration 0028)
  claimCategory: string | null;
  relatedEntities: string[] | null;
  factId: string | null;
  resourceIds: string[] | null;
  section: string | null;
  /** @deprecated Use claim_page_references table instead. Kept for backward compat. */
  footnoteRefs: string | null;
  // Phase 2 fields (migration 0029)
  claimMode: string | null;       // 'endorsed' | 'attributed'
  attributedTo: string | null;    // entity_id of person/org making claim
  asOf: string | null;            // YYYY-MM or YYYY-MM-DD
  measure: string | null;         // measure ID from facts taxonomy
  valueNumeric: number | null;    // central numeric value
  valueLow: number | null;        // lower bound
  valueHigh: number | null;       // upper bound
  // Verdict fields (migration 0031)
  claimVerdict: string | null;
  claimVerdictScore: number | null;
  claimVerdictIssues: string | null;
  claimVerdictQuotes: string | null;
  claimVerdictDifficulty: string | null;
  claimVerifiedAt: string | null;
  claimVerdictModel: string | null;
  // Structured claim fields (migration 0032)
  subjectEntity: string | null;
  property: string | null;
  structuredValue: string | null;
  valueUnit: string | null;
  valueDate: string | null;
  qualifiers: Record<string, string> | null;
  // Pinned claims (migration 0034)
  isPinned: boolean;
  sources: ClaimSourceRow[];      // populated when ?includeSources=true
  createdAt: string;
  updatedAt: string;
}

export interface InsertClaimResult {
  id: number;
  entityId: string;
  claimType: string;
}

export interface InsertClaimBatchResult {
  inserted: number;
  results: Array<{ id: number; entityId: string; claimType: string }>;
}

export interface ClearClaimsResult {
  deleted: number;
}

export interface GetClaimsResult {
  claims: ClaimRow[];
}

export interface ClaimStatsResult {
  total: number;
  byClaimType: Record<string, number>;
  byEntityType: Record<string, number>;
  byClaimCategory: Record<string, number>;
  byClaimMode: Record<string, number>;
  byClaimVerdict: Record<string, number>;
  multiEntityClaims: number;
  factLinkedClaims: number;
  withSourcesClaims: number;
  attributedClaims: number;
  numericClaims?: number;
  structuredClaims?: number;
  byProperty?: Record<string, number>;
}

// -- Claims: Page References types -------------------------------------------

export interface ClaimPageReferenceRow {
  id: number;
  claimId: number;
  pageId: string;
  footnote: number | null;
  section: string | null;
  quoteText: string | null;
  referenceId: string | null;
  createdAt: string;
}

export const ClaimPageReferenceInsertSchema = z.object({
  claimId: z.number().int().positive(),
  pageId: PageIdSchema,
  footnote: z.number().int().min(0).nullable().optional(),
  section: z.string().max(1000).nullable().optional(),
  quoteText: z.string().max(10000).nullable().optional(),
  referenceId: z.string().max(500).nullable().optional(),
});
export type ClaimPageReferenceInsert = z.infer<typeof ClaimPageReferenceInsertSchema>;

export const ClaimPageReferenceBatchSchema = z.object({
  items: z.array(ClaimPageReferenceInsertSchema.omit({ claimId: true })).min(1).max(200),
});

// -- Page Citations types (non-claim footnotes) -------------------------------

export const PageCitationInsertSchema = z.object({
  referenceId: z.string().min(1).max(500),
  pageId: PageIdSchema,
  title: z.string().max(2000).optional(),
  url: z.string().max(5000).optional(),
  note: z.string().max(10000).optional(),
  resourceId: z.string().max(200).optional(),
});
export type PageCitationInsert = z.infer<typeof PageCitationInsertSchema>;

export const PageCitationBatchSchema = z.object({
  items: z.array(PageCitationInsertSchema).min(1).max(200),
});

export interface PageCitationRow {
  id: number;
  referenceId: string;
  pageId: string;
  title: string | null;
  url: string | null;
  note: string | null;
  resourceId: string | null;
  createdAt: string;
}

// -- Claims: Citation linking types ------------------------------------------

export const LinkCitationClaimSchema = z.object({
  claimId: z.number().int().positive(),
});
export type LinkCitationClaim = z.infer<typeof LinkCitationClaimSchema>;

export const LinkCitationsClaimsBatchSchema = z.object({
  items: z.array(z.object({
    quoteId: z.number().int().positive(),
    claimId: z.number().int().positive(),
  })).min(1).max(200),
});

// -- Claims: Backward propagation — REMOVED in #1310 -----------
// PropagateFromClaimsSchema was deleted. Claims are now the single source of truth.
// The old endpoint POST /quotes/propagate-from-claims no longer exists.

// ---------------------------------------------------------------------------
// Page Links
// ---------------------------------------------------------------------------

export const LinkTypeSchema = z.enum([
  "yaml_related",
  "entity_link",
  "name_prefix",
  "similarity",
  "shared_tag",
]);

export const PageLinkSchema = z.object({
  sourceId: z.string().min(1).max(300),
  targetId: z.string().min(1).max(300),
  linkType: LinkTypeSchema,
  relationship: z.string().max(100).nullable().optional(),
  weight: z.number().min(0).max(100).default(1.0),
});
export type PageLink = z.infer<typeof PageLinkSchema>;

export const SyncLinksBatchSchema = z.object({
  links: z.array(PageLinkSchema).min(1).max(5000),
  replace: z.boolean().optional().default(false),
});

export interface PageSearchResult {
  results: Array<{
    id: string;
    numericId: string | null;
    title: string;
    description: string | null;
    entityType: string | null;
    category: string | null;
    readerImportance: number | null;
    quality: number | null;
    score: number;
    snippet: string | null;
  }>;
  query: string;
  total: number;
}

export interface PageDetailRow {
  id: string;
  numericId: string | null;
  title: string;
  description: string | null;
  llmSummary: string | null;
  category: string | null;
  subcategory: string | null;
  entityType: string | null;
  tags: string | null;
  quality: number | null;
  readerImportance: number | null;
  hallucinationRiskLevel: string | null;
  hallucinationRiskScore: number | null;
  contentPlaintext: string | null;
  wordCount: number | null;
  lastUpdated: string | null;
  contentFormat: string | null;
  syncedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface RelatedEntry {
  id: string;
  type: string;
  title: string;
  score: number;
  label?: string;
}

export interface RelatedPagesResult {
  entityId: string;
  related: RelatedEntry[];
  total: number;
}

export interface BacklinkEntry {
  id: string;
  type: string;
  title: string;
  relationship?: string;
  linkType: string;
  weight: number;
}

export interface BacklinksResult {
  targetId: string;
  backlinks: BacklinkEntry[];
  total: number;
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

/** Canonical resource types — mirrors data/schema.ts ResourceType. */
export const ResourceTypeSchema = z.enum([
  "paper",
  "blog",
  "report",
  "book",
  "talk",
  "podcast",
  "government",
  "reference",
  "web",
]);
export type ResourceType = z.infer<typeof ResourceTypeSchema>;
export const RESOURCE_TYPES = ResourceTypeSchema.options;

export const UpsertResourceSchema = z.object({
  id: z.string().min(1).max(200),
  url: z.string().url().max(2000),
  title: z.string().max(1000).nullable().optional(),
  type: ResourceTypeSchema.nullable().optional(),
  summary: z.string().max(50000).nullable().optional(),
  review: z.string().max(50000).nullable().optional(),
  abstract: z.string().max(50000).nullable().optional(),
  keyPoints: z.array(z.string().max(2000)).max(50).nullable().optional(),
  publicationId: z.string().max(200).nullable().optional(),
  authors: z.array(z.string().max(500)).max(5000).nullable().optional(),
  publishedDate: DateStringSchema.nullable().optional(),
  tags: z.array(z.string().max(200)).max(50).nullable().optional(),
  localFilename: z.string().max(500).nullable().optional(),
  credibilityOverride: z.number().min(0).max(1).nullable().optional(),
  fetchedAt: z.string().datetime().nullable().optional(),
  contentHash: z.string().max(200).nullable().optional(),
  citedBy: z.array(z.string().min(1).max(200)).max(500).nullable().optional(),
});
export type UpsertResource = z.infer<typeof UpsertResourceSchema>;

export const UpsertResourceBatchSchema = z.object({
  items: z.array(UpsertResourceSchema).min(1).max(MAX_BATCH_SIZE),
});

// -- Resources: Response types ------------------------------------------------

export interface UpsertResourceResult {
  id: string;
  url: string;
}

export interface ResourceRow {
  id: string;
  url: string;
  title: string | null;
  type: string | null;
  summary: string | null;
  review: string | null;
  abstract: string | null;
  keyPoints: string[] | null;
  publicationId: string | null;
  authors: string[] | null;
  publishedDate: string | null;
  tags: string[] | null;
  localFilename: string | null;
  credibilityOverride: number | null;
  fetchedAt: string | null;
  contentHash: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResourceStatsResult {
  totalResources: number;
  totalCitations: number;
  citedPages: number;
  byType: Record<string, number>;
  /** Resources that exist in the DB but have zero citation links. */
  orphanedCount: number;
  /** Resources with a summary, review, or key_points filled in. */
  withMetadata: number;
  /** Resources that have been fetched (fetchedAt is set). */
  fetched: number;
}

export interface ResourceSearchResult {
  results: ResourceRow[];
  count: number;
  query: string;
}

export interface ResourceListResult {
  resources: ResourceRow[];
  total: number;
  limit: number;
  offset: number;
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export const SyncEntitySchema = z.object({
  id: z.string().min(1).max(300),
  numericId: z.string().max(20).nullable().optional(),
  entityType: z.string().min(1).max(100),
  title: z.string().min(1).max(500),
  description: z.string().max(50000).nullable().optional(),
  website: z.string().max(2000).nullable().optional(),
  tags: z.array(z.string().max(200)).max(100).nullable().optional(),
  clusters: z.array(z.string().max(200)).max(50).nullable().optional(),
  status: z.string().max(100).nullable().optional(),
  lastUpdated: z.string().max(50).nullable().optional(),
  customFields: z
    .array(
      z.object({
        label: z.string().max(200),
        value: z.string().max(5000),
        link: z.string().max(2000).optional(),
      })
    )
    .max(50)
    .nullable()
    .optional(),
  relatedEntries: z
    .array(
      z.object({
        id: z.string().max(300),
        type: z.string().max(100),
        relationship: z.string().max(100).optional(),
      })
    )
    .max(200)
    .nullable()
    .optional(),
  sources: z
    .array(
      z.object({
        title: z.string().max(500),
        url: z.string().max(2000).optional(),
        author: z.string().max(300).optional(),
        date: z.string().max(50).optional(),
      })
    )
    .max(100)
    .nullable()
    .optional(),
});
export type SyncEntity = z.infer<typeof SyncEntitySchema>;

export const SyncEntitiesBatchSchema = z.object({
  entities: z.array(SyncEntitySchema).min(1).max(MAX_BATCH_SIZE),
});

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

export const SyncFactSchema = z.object({
  entityId: z.string().min(1).max(300),
  factId: z.string().min(1).max(100),
  label: z.string().max(500).nullable().optional(),
  value: z.string().max(5000).nullable().optional(),
  numeric: z.number().nullable().optional(),
  low: z.number().nullable().optional(),
  high: z.number().nullable().optional(),
  asOf: z.string().max(20).nullable().optional(),
  measure: z.string().max(100).nullable().optional(),
  subject: z.string().max(300).nullable().optional(),
  note: z.string().max(5000).nullable().optional(),
  source: z.string().max(2000).nullable().optional(),
  sourceResource: z.string().max(200).nullable().optional(),
  format: z.string().max(100).nullable().optional(),
  formatDivisor: z.number().nullable().optional(),
});
export type SyncFact = z.infer<typeof SyncFactSchema>;

export const SyncFactsBatchSchema = z.object({
  facts: z.array(SyncFactSchema).min(1).max(500),
});

// -- Facts: Response types ----------------------------------------------------
// Removed in favour of Hono RPC-inferred types (PR #1004).
// Canonical response types are now derived from the server route definition
// via `InferResponseType` in crux/lib/wiki-server/facts.ts and
// apps/web/src/lib/wiki-server.ts. See FactsRoute in routes/facts.ts.

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export const VALID_JOB_STATUSES = [
  "pending",
  "claimed",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;

export type JobStatus = (typeof VALID_JOB_STATUSES)[number];

/** Maximum jobs per batch create request. */
export const JOBS_MAX_BATCH_SIZE = 50;

/** Default minutes before a stale claimed/running job is reset by sweep. */
export const STALE_JOB_TIMEOUT_MINUTES = 60;

export const CreateJobSchema = z.object({
  type: z.string().min(1).max(100),
  params: z.record(z.unknown()).nullable().optional(),
  priority: z.number().int().min(0).max(1000).default(0),
  maxRetries: z.number().int().min(0).max(10).default(3),
});
/** Output type (server-resolved, defaults applied). */
export type CreateJob = z.infer<typeof CreateJobSchema>;
/** Input type (client-side, defaults optional). */
export type CreateJobInput = z.input<typeof CreateJobSchema>;

export const CreateJobBatchSchema = z
  .array(CreateJobSchema)
  .min(1)
  .max(JOBS_MAX_BATCH_SIZE);
export type CreateJobBatch = z.infer<typeof CreateJobBatchSchema>;

export const ListJobsQuerySchema = z.object({
  status: z.enum(VALID_JOB_STATUSES).optional(),
  type: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListJobsQuery = z.infer<typeof ListJobsQuerySchema>;

export const ClaimJobSchema = z.object({
  type: z.string().min(1).max(100).optional(),
  workerId: z.string().min(1).max(200),
});
export type ClaimJob = z.infer<typeof ClaimJobSchema>;

export const CompleteJobSchema = z.object({
  result: z.record(z.unknown()).nullable().optional(),
});
export type CompleteJob = z.infer<typeof CompleteJobSchema>;

export const FailJobSchema = z.object({
  error: z.string().max(5000),
});
export type FailJob = z.infer<typeof FailJobSchema>;

export const SweepJobsSchema = z.object({
  timeoutMinutes: z
    .number()
    .int()
    .min(1)
    .max(10080)
    .default(STALE_JOB_TIMEOUT_MINUTES),
});
export type SweepJobs = z.infer<typeof SweepJobsSchema>;

// ---------------------------------------------------------------------------
// Improve Run Artifacts
// ---------------------------------------------------------------------------

export const VALID_ENGINES = ["v1", "v2"] as const;
export const VALID_IMPROVE_TIERS = ["polish", "standard", "deep"] as const;

export const SaveArtifactsSchema = z.object({
  pageId: PageIdSchema,
  engine: z.enum(VALID_ENGINES),
  tier: z.enum(VALID_IMPROVE_TIERS),
  directions: z.string().max(5000).nullable().optional(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable().optional(),
  durationS: z.number().min(0).nullable().optional(),
  totalCost: z.number().min(0).nullable().optional(),

  // Research artifacts
  sourceCache: z.array(z.object({
    id: z.string(),
    url: z.string(),
    title: z.string(),
    author: z.string().optional(),
    date: z.string().optional(),
    facts: z.array(z.string()).optional(),
  })).max(200).nullable().optional(),
  researchSummary: z.string().max(50000).nullable().optional(),

  // Citation audit artifacts
  citationAudit: z.record(z.unknown()).nullable().optional(),

  // Cost tracking
  costEntries: z.array(z.object({
    toolName: z.string(),
    estimatedCost: z.number(),
    timestamp: z.number(),
  })).max(500).nullable().optional(),
  costBreakdown: z.record(z.string(), z.number()).nullable().optional(),

  // Section-level diffs
  sectionDiffs: z.array(z.object({
    sectionId: z.string(),
    before: z.string().max(50000),
    after: z.string().max(50000),
  })).max(50).nullable().optional(),

  // Quality gate
  qualityMetrics: z.record(z.unknown()).nullable().optional(),
  qualityGatePassed: z.boolean().nullable().optional(),
  qualityGaps: z.array(z.string().max(1000)).max(50).nullable().optional(),

  // Pipeline metadata
  toolCallCount: z.number().int().min(0).nullable().optional(),
  refinementCycles: z.number().int().min(0).nullable().optional(),
  phasesRun: z.array(z.string().max(100)).max(20).nullable().optional(),
});
export type SaveArtifacts = z.infer<typeof SaveArtifactsSchema>;

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export const SyncPageSchema = z.object({
  id: z.string().min(1).max(300),
  numericId: z.string().max(20).nullable().optional(),
  title: z.string().min(1).max(500),
  description: z.string().max(5000).nullable().optional(),
  llmSummary: z.string().max(10000).nullable().optional(),
  category: z.string().max(100).nullable().optional(),
  subcategory: z.string().max(100).nullable().optional(),
  entityType: z.string().max(100).nullable().optional(),
  tags: z.string().max(5000).nullable().optional(),
  quality: z.number().int().min(0).max(100).nullable().optional(),
  readerImportance: z.number().int().min(0).max(100).nullable().optional(),
  researchImportance: z.number().int().min(0).max(100).nullable().optional(),
  tacticalValue: z.number().int().min(0).max(100).nullable().optional(),
  backlinkCount: z.number().int().min(0).nullable().optional(),
  riskCategory: z.string().max(50).nullable().optional(),
  dateCreated: z.string().max(50).nullable().optional(),
  recommendedScore: z.number().min(0).nullable().optional(),
  clusters: z.array(z.string().max(100)).nullable().optional(),
  hallucinationRiskLevel: z.string().max(50).nullable().optional(),
  hallucinationRiskScore: z.number().int().min(0).max(100).nullable().optional(),
  contentPlaintext: z.string().max(500000).nullable().optional(),
  wordCount: z.number().int().min(0).nullable().optional(),
  lastUpdated: z.string().max(50).nullable().optional(),
  contentFormat: z.string().max(50).nullable().optional(),
});
export type SyncPage = z.infer<typeof SyncPageSchema>;

export const SyncPagesBatchSchema = z.object({
  pages: z.array(SyncPageSchema).min(1).max(100),
  syncedFromBranch: z.string().max(500).nullable().optional(),
  syncedFromCommit: z.string().max(100).nullable().optional(),
});

// ---------------------------------------------------------------------------
// Agent Sessions
// ---------------------------------------------------------------------------

const VALID_SESSION_TYPES = [
  "content",
  "infrastructure",
  "bugfix",
  "refactor",
  "commands",
] as const;

export const CreateAgentSessionSchema = z.object({
  branch: z.string().min(1).max(500),
  task: z.string().min(1).max(2000),
  sessionType: z.enum(VALID_SESSION_TYPES),
  issueNumber: z.number().int().positive().nullable().optional(),
  checklistMd: z.string().min(1).max(50000),
  worktree: z.string().max(1000).nullable().optional(),
});
export type CreateAgentSession = z.infer<typeof CreateAgentSessionSchema>;

export const PR_OUTCOMES = [
  "merged",
  "merged_with_revisions",
  "reverted",
  "closed_without_merge",
] as const;
export type PrOutcome = typeof PR_OUTCOMES[number];

export const UpdateAgentSessionSchema = z.object({
  checklistMd: z.string().min(1).max(50000).optional(),
  status: z.enum(["active", "completed"]).optional(),
  prUrl: z.string().url().max(1000).nullable().optional(),
  prOutcome: z.enum(PR_OUTCOMES).nullable().optional(),
  fixesPrUrl: z.string().url().max(1000).nullable().optional(),
  /** FK to the sessions table — set when the session log is synced to the DB */
  sessionId: z.number().int().positive().nullable().optional(),
});
export type UpdateAgentSession = z.infer<typeof UpdateAgentSessionSchema>;

// ---------------------------------------------------------------------------
// Active Agents (live coordination)
// ---------------------------------------------------------------------------

export const VALID_AGENT_STATUSES = [
  "active",
  "completed",
  "errored",
  "stale",
] as const;

export const RegisterAgentSchema = z.object({
  sessionId: z.string().min(1).max(500),
  branch: z.string().max(500).nullable().optional(),
  task: z.string().min(1).max(2000),
  issueNumber: z.number().int().positive().nullable().optional(),
  model: z.string().max(200).nullable().optional(),
  worktree: z.string().max(1000).nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
});
export type RegisterAgent = z.infer<typeof RegisterAgentSchema>;

export const UpdateAgentSchema = z.object({
  status: z.enum(VALID_AGENT_STATUSES).optional(),
  currentStep: z.string().max(2000).nullable().optional(),
  branch: z.string().max(500).nullable().optional(),
  issueNumber: z.number().int().positive().nullable().optional(),
  prNumber: z.number().int().positive().nullable().optional(),
  filesTouched: z.array(z.string().max(500)).max(200).nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
});
export type UpdateAgent = z.infer<typeof UpdateAgentSchema>;

// ---------------------------------------------------------------------------
// Agent Session Events (activity timeline)
// ---------------------------------------------------------------------------

export const VALID_AGENT_EVENT_TYPES = [
  "registered",
  "checklist_check",
  "status_update",
  "error",
  "note",
  "completed",
] as const;

export const CreateAgentEventSchema = z.object({
  agentId: z.number().int().positive(),
  eventType: z.enum(VALID_AGENT_EVENT_TYPES),
  message: z.string().min(1).max(5000),
  metadata: z.record(z.unknown()).nullable().optional(),
});
export type CreateAgentEvent = z.infer<typeof CreateAgentEventSchema>;

// ---------------------------------------------------------------------------
// Groundskeeper Runs
// ---------------------------------------------------------------------------

export const VALID_GK_EVENTS = [
  "success",
  "failure",
  "error",
  "circuit_breaker_tripped",
  "circuit_breaker_reset",
  "half_open_attempt",
  "half_open_success",
  "skipped",
] as const;

export const RecordGroundskeeperRunSchema = z.object({
  taskName: z.string().min(1).max(200),
  event: z.enum(VALID_GK_EVENTS),
  success: z.boolean(),
  durationMs: z.number().int().min(0).nullable().optional(),
  summary: z.string().max(5000).nullable().optional(),
  errorMessage: z.string().max(10000).nullable().optional(),
  consecutiveFailures: z.number().int().min(0).nullable().optional(),
  circuitBreakerActive: z.boolean().optional().default(false),
  metadata: z.record(z.unknown()).nullable().optional(),
  timestamp: z.string().datetime().optional(),
});
export type RecordGroundskeeperRun = z.infer<typeof RecordGroundskeeperRunSchema>;

export const RecordGroundskeeperRunBatchSchema = z.object({
  items: z.array(RecordGroundskeeperRunSchema).min(1).max(100),
});

// ---------------------------------------------------------------------------
// Monitoring / Incident Tracking
// ---------------------------------------------------------------------------

export const VALID_SERVICES = [
  "wiki-server",
  "groundskeeper",
  "discord-bot",
  "vercel-frontend",
  "github-actions",
] as const;

export const ServiceNameSchema = z.enum(VALID_SERVICES);

export const VALID_INCIDENT_SEVERITIES = [
  "critical",
  "warning",
  "info",
] as const;

export const IncidentSeveritySchema = z.enum(VALID_INCIDENT_SEVERITIES);

export const VALID_INCIDENT_STATUSES = [
  "open",
  "acknowledged",
  "resolved",
] as const;

export const IncidentStatusSchema = z.enum(VALID_INCIDENT_STATUSES);

export const RecordIncidentSchema = z.object({
  service: ServiceNameSchema,
  severity: IncidentSeveritySchema,
  title: z.string().min(1).max(500),
  detail: z.string().max(5000).optional(),
  checkSource: z.string().max(100).optional(),
  metadata: z.record(z.unknown()).optional(),
  githubIssueNumber: z.number().int().positive().optional(),
});

export type RecordIncident = z.infer<typeof RecordIncidentSchema>;

export const UpdateIncidentSchema = z.object({
  status: IncidentStatusSchema.optional(),
  resolvedBy: z.string().max(200).optional(),
  detail: z.string().max(5000).optional(),
  metadata: z.record(z.unknown()).optional(),
  githubIssueNumber: z.number().int().positive().optional(),
});
