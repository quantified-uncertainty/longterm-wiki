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

/** Default maximum items per batch request. Individual endpoints may override. */
export const MAX_BATCH_SIZE = 200;

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

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export const UpsertResourceSchema = z.object({
  id: z.string().min(1).max(200),
  url: z.string().url().max(2000),
  title: z.string().max(1000).nullable().optional(),
  type: z.string().max(50).nullable().optional(),
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
});
