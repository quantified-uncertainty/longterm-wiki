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

// -- Edit Logs: Response types ------------------------------------------------

export interface EditLogAppendResult {
  id: number;
  pageId: string;
  date: string;
  createdAt: string;
}

export interface EditLogBatchResult {
  inserted: number;
  results: Array<{ id: number; pageId: string }>;
}

export interface EditLogRow {
  id: number;
  pageId: string;
  date: string;
  tool: string;
  agency: string;
  requestedBy: string | null;
  note: string | null;
  createdAt: string;
}

export interface EditLogEntriesResult {
  entries: EditLogRow[];
}

export interface EditLogStatsResult {
  totalEntries: number;
  pagesWithLogs: number;
  byTool: Record<string, number>;
  byAgency: Record<string, number>;
}

export interface EditLogLatestDatesResult {
  dates: Record<string, string>;
}

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

// -- Citation Quotes: Response types ------------------------------------------

export interface CitationQuoteRow {
  id: number;
  pageId: string;
  footnote: number;
  url: string | null;
  resourceId: string | null;
  claimText: string;
  claimContext: string | null;
  sourceQuote: string | null;
  sourceLocation: string | null;
  quoteVerified: boolean;
  verificationScore: number | null;
  sourceTitle: string | null;
  sourceType: string | null;
  accuracyVerdict: string | null;
  accuracyScore: number | null;
}

export interface UpsertCitationQuoteResult {
  id: number;
  pageId: string;
  footnote: number;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertCitationQuoteBatchResult {
  results: Array<{ id: number; pageId: string; footnote: number }>;
}

export interface CitationQuotesResult {
  quotes: CitationQuoteRow[];
  pageId: string;
  total: number;
}

// -- Citation Health: per-page summary ----------------------------------------

export interface CitationHealthResult {
  pageId: string;
  total: number;
  withQuotes: number;
  verified: number;
  accuracyChecked: number;
  accurate: number;
  inaccurate: number;
  unsupported: number;
  minorIssues: number;
  notVerifiable: number;
  avgScore: number | null;
}

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

// -- Citation Accuracy: Response types ----------------------------------------

export interface MarkAccuracyResult {
  updated: true;
  pageId: string;
  footnote: number;
  verdict: string;
}

export interface MarkAccuracyBatchResult {
  updated: number;
  results: Array<{ pageId: string; footnote: number; verdict: string }>;
}

export interface AccuracySnapshotResult {
  snapshotCount: number;
  pages: string[];
}

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
  prUrl: z.string().max(1000).nullable().optional(),
  checksYaml: z.string().max(10000).nullable().optional(),
  issuesJson: z.unknown().nullable().optional(),
  learningsJson: z.unknown().nullable().optional(),
  recommendationsJson: z.unknown().nullable().optional(),
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

// -- Sessions: Response types -------------------------------------------------

export interface SessionRow {
  id: number;
  date: string;
  branch: string | null;
  title: string;
  summary: string | null;
  model: string | null;
  duration: string | null;
  cost: string | null;
  prUrl: string | null;
  checksYaml: string | null;
  issuesJson: unknown;
  learningsJson: unknown;
  recommendationsJson: unknown;
  pages: string[];
  createdAt: string;
}

export interface CreateSessionResult {
  id: number;
  date: string;
  title: string;
  pages: string[];
  createdAt: string;
}

export interface SessionBatchResult {
  upserted: number;
  results: Array<{ id: number; title: string; pageCount: number }>;
}

export interface SessionListResult {
  sessions: SessionRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface SessionByPageResult {
  sessions: SessionRow[];
}

export interface SessionStatsResult {
  totalSessions: number;
  uniquePages: number;
  totalPageEdits: number;
  byModel: Record<string, number>;
}

export interface SessionPageChangesResult {
  sessions: SessionRow[];
}

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

// -- Auto-Update Runs: Response types -----------------------------------------

export interface RecordAutoUpdateRunResult {
  id: number;
  date: string;
  startedAt: string;
  createdAt: string;
  resultsInserted: number;
}

export interface AutoUpdateRunRow {
  id: number;
  date: string;
  startedAt: string;
  completedAt: string | null;
  trigger: string;
  budgetLimit: number | null;
  budgetSpent: number | null;
  sourcesChecked: number | null;
  sourcesFailed: number | null;
  itemsFetched: number | null;
  itemsRelevant: number | null;
  pagesPlanned: number | null;
  pagesUpdated: number | null;
  pagesFailed: number | null;
  pagesSkipped: number | null;
  newPagesCreated: string[];
  results: AutoUpdateResult[];
  createdAt: string;
}

export interface AutoUpdateRunsListResult {
  entries: AutoUpdateRunRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface AutoUpdateStatsResult {
  totalRuns: number;
  totalBudgetSpent: number;
  totalPagesUpdated: number;
  totalPagesFailed: number;
  byTrigger: Record<string, number>;
}

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

// -- Auto-Update News: Response types -----------------------------------------

export interface AutoUpdateNewsRow {
  id: number;
  runId: number;
  title: string;
  url: string;
  sourceId: string;
  publishedAt: string | null;
  summary: string | null;
  relevanceScore: number | null;
  topics: string[];
  entities: string[];
  routedToPageId: string | null;
  routedToPageTitle: string | null;
  routedTier: string | null;
  runDate?: string | null;
  createdAt: string;
}

export interface AutoUpdateNewsBatchResult {
  inserted: number;
}

export interface AutoUpdateNewsDashboardResult {
  items: AutoUpdateNewsRow[];
  runDates: string[];
}

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

// -- Hallucination Risk: Response types ---------------------------------------

export interface RiskBatchResult {
  inserted: number;
}

export interface RiskPageRow {
  pageId: string;
  score: number;
  level: "low" | "medium" | "high";
  factors: string[] | null;
  integrityIssues: string[] | null;
  computedAt: string;
}

export interface RiskLatestResult {
  pages: RiskPageRow[];
}

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

// -- Summaries: Response types ------------------------------------------------

export interface UpsertSummaryResult {
  entityId: string;
  entityType: string;
}

export interface UpsertSummaryBatchResult {
  upserted: number;
  results: Array<{ entityId: string; entityType: string }>;
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

export const InsertClaimSchema = z.object({
  entityId: z.string().min(1).max(300),
  entityType: z.string().min(1).max(100),
  claimType: z.string().min(1).max(100),
  claimText: z.string().min(1).max(10000),
  value: z.string().max(1000).nullable().optional(),
  unit: z.string().max(100).nullable().optional(),
  confidence: z.string().max(100).nullable().optional(),
  sourceQuote: z.string().max(10000).nullable().optional(),
});
export type InsertClaim = z.infer<typeof InsertClaimSchema>;

export const InsertClaimBatchSchema = z.object({
  items: z.array(InsertClaimSchema).min(1).max(500),
});

export const ClearClaimsSchema = z.object({
  entityId: z.string().min(1).max(300),
});

// -- Claims: Response types ---------------------------------------------------

export interface ClaimRow {
  id: number;
  entityId: string;
  entityType: string;
  claimType: string;
  claimText: string;
  value: string | null;
  unit: string | null;
  confidence: string | null;
  sourceQuote: string | null;
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

// -- Page Links: Response types -----------------------------------------------

export interface SyncLinksResult {
  upserted: number;
}

export interface LinksStatsResult {
  total: number;
  uniqueSources: number;
  uniqueTargets: number;
  byType: Array<{
    linkType: string;
    count: number;
    avgWeight: number;
  }>;
}

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

// -- Entities: Response types -------------------------------------------------

export interface SyncEntitiesResult {
  upserted: number;
}

export interface EntityRow {
  id: string;
  numericId: string | null;
  entityType: string;
  title: string;
  description: string | null;
  website: string | null;
  tags: string[] | null;
  clusters: string[] | null;
  status: string | null;
  lastUpdated: string | null;
  customFields: Array<{ label: string; value: string; link?: string }> | null;
  relatedEntries: Array<{ id: string; type: string; relationship?: string }> | null;
  sources: Array<{ title: string; url?: string; author?: string; date?: string }> | null;
  syncedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface EntityListResult {
  entities: EntityRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface EntitySearchResult {
  results: EntityRow[];
  query: string;
  total: number;
}

export interface EntityStatsResult {
  total: number;
  byType: Record<string, number>;
}

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

export interface SyncFactsResult {
  upserted: number;
}

export interface FactRow {
  id: number;
  entityId: string;
  factId: string;
  label: string | null;
  value: string | null;
  numeric: number | null;
  low: number | null;
  high: number | null;
  asOf: string | null;
  measure: string | null;
  subject: string | null;
  note: string | null;
  source: string | null;
  sourceResource: string | null;
  format: string | null;
  formatDivisor: number | null;
  syncedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface FactsByEntityResult {
  entityId: string;
  facts: FactRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface FactTimeseriesResult {
  entityId: string;
  measure: string;
  points: FactRow[];
  total: number;
}

export interface StaleFactsResult {
  facts: Array<{
    entityId: string;
    factId: string;
    label: string | null;
    asOf: string | null;
    measure: string | null;
    value: string | null;
    numeric: number | null;
  }>;
  total: number;
  limit: number;
  offset: number;
}

export interface FactStatsResult {
  total: number;
  uniqueEntities: number;
  uniqueMeasures: number;
}

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

// -- Jobs: Response types -----------------------------------------------------

export interface JobRow {
  id: number;
  type: string;
  status: string;
  params: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error: string | null;
  priority: number;
  retries: number;
  maxRetries: number;
  createdAt: string;
  claimedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  workerId: string | null;
}

export interface ListJobsResult {
  entries: JobRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface ClaimJobResult {
  job: JobRow | null;
}

export interface JobStatsResult {
  totalJobs: number;
  byType: Record<
    string,
    {
      byStatus: Record<string, number>;
      avgDurationMs?: number;
      failureRate?: number;
    }
  >;
}

export interface SweepJobsResult {
  swept: number;
  jobs: Array<{ id: number; type: string }>;
}

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

// -- Artifacts: Response types ------------------------------------------------

export interface SaveArtifactsResult {
  id: number;
  pageId: string;
  engine: string;
  startedAt: string;
  createdAt: string;
}

export interface ArtifactRow {
  id: number;
  pageId: string;
  engine: string;
  tier: string;
  directions: string | null;
  startedAt: string;
  completedAt: string | null;
  durationS: number | null;
  totalCost: number | null;
  sourceCache: unknown;
  researchSummary: string | null;
  citationAudit: unknown;
  costEntries: unknown;
  costBreakdown: Record<string, number> | null;
  sectionDiffs: unknown;
  qualityMetrics: unknown;
  qualityGatePassed: boolean | null;
  qualityGaps: string[] | null;
  toolCallCount: number | null;
  refinementCycles: number | null;
  phasesRun: string[] | null;
  createdAt: string;
}

export interface GetArtifactsResult {
  entries: ArtifactRow[];
}

export interface GetArtifactsPagedResult {
  entries: ArtifactRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface ArtifactStatsResult {
  totalRuns: number;
  byEngine: Record<string, number>;
  byTier: Record<string, number>;
}

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
});
export type CreateAgentSession = z.infer<typeof CreateAgentSessionSchema>;

export const UpdateAgentSessionSchema = z.object({
  checklistMd: z.string().min(1).max(50000).optional(),
  status: z.enum(["active", "completed"]).optional(),
});
export type UpdateAgentSession = z.infer<typeof UpdateAgentSessionSchema>;

// -- Agent Sessions: Response types -------------------------------------------

export interface AgentSessionRow {
  id: number;
  branch: string;
  task: string;
  sessionType: "content" | "infrastructure" | "bugfix" | "refactor" | "commands";
  issueNumber: number | null;
  checklistMd: string;
  status: "active" | "completed";
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
