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

/**
 * Optional sourcing data submitted alongside any record on a /sync endpoint.
 *
 * Defined here (the canonical source) rather than in
 * `./routes/tablebase/sourcing-schema.js` because `api-types.ts` is bundled
 * by `apps/web/`, which webpack cannot resolve from a deep relative `.js`
 * path under `apps/wiki-server/src/routes/`. The tablebase `sourcing-schema.ts`
 * now re-exports from here so existing route imports keep working.
 */
export const InlineSourcingSchema = z.object({
  verdict: z.enum([
    "confirmed",
    "contradicted",
    "outdated",
    "partial",
    "unverifiable",
  ]),
  evidence: z.string().max(5000).optional(),
  confidence: z.number().min(0).max(1).optional(),
  sourceContentHash: z.string().max(100).optional(),
  checkedAt: z.string().datetime().optional(),
  checkedBy: z.string().max(100).optional(),
});

export type InlineSourcing = z.infer<typeof InlineSourcingSchema>;

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
// Record Source-Checks
// ---------------------------------------------------------------------------

/**
 * Allowed lifecycle states for a URL suggestion.
 * Mirrored in the PG CHECK constraint — migrations 0176 (initial set) and
 * 0198 (added 'applied'). Keep in sync.
 *
 * Lives here (not next to the route) because the worker container only
 * COPIES this file from apps/wiki-server/, and the apply-suggestions
 * CLI imports the constant as a runtime value (not type-only).
 */
export const VALID_SUGGESTION_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "auto_verified",
  "applied",
] as const;
export type SuggestionStatus = (typeof VALID_SUGGESTION_STATUSES)[number];

/**
 * Files in `apps/wiki-server/src/routes/tablebase/` that are NOT mounted
 * routes — helpers, schemas, test-d files. Consumed by the route detector
 * and the two tablebase validators. Mirrors the worker-container reality
 * (only `api-types.ts` is copied out of `apps/wiki-server/`) so the lazy
 * route detector + the validators load without ERR_MODULE_NOT_FOUND.
 *
 * Keep in sync with `apps/wiki-server/src/routes/tablebase/mount-registry.ts`.
 */
export const TABLEBASE_NON_ROUTE_FILES: readonly string[] = [
  "index.ts",
  "mount-registry.ts",
  "sync-factory.ts",
  "sync-factory.test-d.ts",
  "sourcing-schema.ts",
  "audit-log.ts",
  "write-inline-verdicts.ts",
  "entity-profile-descriptions.ts",
  "system-card-benchmark-linker.ts",
  "benchmark-shared.ts",
  "policy-stakeholders-schema.ts",
];

/**
 * Risk-domain enum for the third-party-evaluation tablebase route.
 * Mirrors the CHECK constraint in migration 0206. Lives here so the
 * crux third-party-eval extractor (which imports this as a value, not
 * type) loads inside the worker container.
 *
 * Keep in sync with `apps/wiki-server/src/routes/tablebase/third-party-evaluations.ts`.
 */
export const VALID_RISK_DOMAINS = [
  "cbrn",
  "biological",
  "chemical",
  "radiological",
  "nuclear",
  "cyber",
  "autonomy",
  "agent-security",
  "persuasion",
  "scheming",
  "deception",
  "jailbreak",
  "safeguard-efficacy",
  "evaluation-awareness",
  "misuse",
  "misc",
] as const;
export type RiskDomain = (typeof VALID_RISK_DOMAINS)[number];

export const VALID_RECORD_TYPES = [
  "grant",
  "personnel",
  "division",
  "funding-program",
  "funding-round",
  "investment",
  "equity-position",
  "policy-stakeholder",
  "publication",
  "benchmark-result",
  "entity-event",
  "entity-assessment",
  "secondary-market-price",
  "citation",
  "wiki-page",
  "fact",
  // QUA-685: ai-model is an entity type whose scalar fields (inputPrice,
  // outputPrice, contextWindow, safetyLevel, releaseDate) are sourceable
  // against the model's release announcement / docs page. Records are
  // collected from `/api/entities/export?entityType=ai-model` rather than
  // a dedicated /api/<type>/all endpoint — see crux/lib/sourcing/item-collectors.ts.
  "ai-model",
  // QUA-864: each scorecard_grades row asserts "publisher X scored entity Y
  // as Z on dimension D in wave W". The grade's own sourceUrl (when present)
  // or the parent snapshot's sourceUrl is the evidence URL. Underscored to
  // match the route's existing SCORECARD_GRADE_RECORD_TYPE constant
  // (apps/wiki-server/src/routes/tablebase/scorecard-grades.ts), which is
  // already what the LEFT JOIN against source_check_verdicts uses for the
  // QUA-839 rendering layer on /scorecards and the org scorecards tab.
  "scorecard_grade",
] as const;

export type RecordType = (typeof VALID_RECORD_TYPES)[number];

/**
 * Record types that are exempt from sourcing verification.
 *
 * These are data classes where the ingestion source IS the canonical reference,
 * so running sourcing verification against them produces noise rather than signal.
 * They are excluded from coverage metrics, recheck queues, and the sourcing
 * pipeline. The exemption is explicit — without this list, nothing prevents
 * someone from accidentally running sourcing on these types and polluting
 * the verdicts table.
 *
 * Criteria for exemption:
 *   1. Data is ingested directly from an authoritative API (Manifold, arXiv, etc.)
 *   2. The source URL in the record IS the canonical reference — re-checking it
 *      against external sources is circular
 *   3. Data is computed/derived from other already-verified records
 *
 * When adding a new exempt type, document the reason inline.
 */
export const SOURCING_EXEMPT_TYPES = [
  // Ingested directly from benchmark provider APIs (e.g., provider docs, eval harnesses).
  // The benchmark scores ARE the canonical data — no external source to verify against.
  "benchmark-result",

  // Computed by the citation accuracy system, not manually entered data.
  // Citation accuracy has its own separate verification pipeline.
  "citation",

  // LLM-generated or editorial assessments (importance, risk, etc.).
  // These are opinions/judgments, not factual claims that can be sourcing-checked.
  "entity-assessment",

  // Time-series pricing data ingested from secondary market APIs.
  // The API response IS the canonical price — re-checking it is circular.
  "secondary-market-price",
] as const;

export type SourcingExemptType = (typeof SOURCING_EXEMPT_TYPES)[number];

/**
 * Check whether a record type is exempt from sourcing verification.
 * Use this instead of manual array checks to ensure consistency.
 */
export function isSourcingExempt(recordType: string): boolean {
  return (SOURCING_EXEMPT_TYPES as readonly string[]).includes(recordType);
}

/**
 * Narrowing type guard: is this string one of the registered record types?
 *
 * Useful at FE boundaries (URL params, API responses) so a typo or unregistered
 * type fails at the guard rather than silently building a 404 URL or missing a
 * verdict lookup.
 */
export function isValidRecordType(recordType: string): recordType is RecordType {
  return (VALID_RECORD_TYPES as readonly string[]).includes(recordType);
}

/**
 * Is this record type both registered AND non-exempt — i.e. would have stored
 * verdicts worth linking to from a dot? Equivalent to:
 *   isValidRecordType(t) && !isSourcingExempt(t)
 */
export function isLinkableSourcingType(
  recordType: string,
): recordType is Exclude<RecordType, SourcingExemptType> {
  return isValidRecordType(recordType) && !isSourcingExempt(recordType);
}

// `not_applicable` (QUA-426) marks evidence rows where the pre-LLM relevance
// gate determined the source content doesn't mention the record's subject at
// all, so neither confirmation nor contradiction is possible from this source.
// Rollup / display logic treats `not_applicable` as "no signal" — it does not
// count toward any severity bucket and renders as a neutral "skipped" state.
export const VALID_SOURCE_CHECK_VERDICTS = [
  "confirmed",
  "contradicted",
  "unverifiable",
  "outdated",
  "partial",
  "not_applicable",
] as const;

export type SourcingVerdict = (typeof VALID_SOURCE_CHECK_VERDICTS)[number];

// ── Branded record IDs (QUA-423) ──────────────────────────────────────────
//
// A `RecordId<T>` is a string tagged with a record-type literal at the type
// level. The only way to obtain one is through `asRecordId()`, which performs
// runtime checks for obvious misuse — empty string, excessive length, or the
// composite-key shape that shipped in QUA-417 (`${ownerEntityId}-${record.key}`
// passed where the raw record PK was expected).
//
// Why brands, not `type RecordId<T> = string`? A raw string alias accepts any
// string, including composite React keys. The QUA-417 bug class only surfaces
// in code review, not the type checker. With brands, the only way to get a
// `RecordId<T>` is to wrap via `asRecordId()` — which runs the shape guards.

/**
 * Opaque, type-tagged record ID. Construct only via `asRecordId()`.
 *
 * `RecordId<"grant">` is not assignable to `RecordId<"personnel">` or vice
 * versa — the compile-time distinction makes mixed-up record types a type
 * error rather than a runtime miss.
 */
export type RecordId<T extends RecordType = RecordType> = string & {
  readonly __brand: "RecordId";
  readonly __type: T;
};

/**
 * Thrown by `asRecordId()` when the input clearly isn't a raw record PK.
 * Carries structured fields (`recordType`, `rawId`) so callers can handle
 * programmatically vs. log as a generic error.
 */
export class InvalidRecordIdError extends Error {
  constructor(
    public readonly recordType: string,
    public readonly rawId: string,
    reason: string,
  ) {
    super(
      `asRecordId(${JSON.stringify(recordType)}, ${JSON.stringify(rawId)}): ${reason}`,
    );
    this.name = "InvalidRecordIdError";
  }
}

/**
 * Heuristic: does this look like a composite React key rather than a raw PK?
 *
 * The QUA-417 bug was `conn.key = \`${ownerEntityId}-${record.key}\``. The
 * ownerEntityId was a `sid_`-prefixed stableId and record.key was a 10-char
 * alphanumeric grant PK — e.g. `sid_ULjDXpSLCI-8NUnVSueLS`.
 *
 * Shapes caught:
 *   - `sid_X-<alphanumRight>`   → stableId + anything (the QUA-417 shape)
 *   - `<multi-digit>-<multi-digit>`  → two numeric PKs joined
 *
 * Does NOT flag legitimate hyphenated IDs (`some-name-2024`, `arxiv-2310-12345`).
 * Intentionally narrow — false negatives are fine (real PKs don't match this);
 * false positives on real PKs would break legitimate callers.
 */
function looksLikeCompositeKey(rawId: string): boolean {
  // `sid_...-...` — stableIds themselves don't contain hyphens, so anything
  // starting with `sid_` followed by `-` is always a composite.
  if (/^sid_[A-Za-z0-9]+-[A-Za-z0-9]+/.test(rawId)) return true;
  // Two multi-digit numeric IDs joined, but NOT `1-2` / `a-b` (legit slugs).
  if (/^\d{3,}-\d{3,}$/.test(rawId)) return true;
  return false;
}

/**
 * Construct a `RecordId<T>` from a raw string.
 *
 * Runtime guards catch obvious mistakes at dev/test time:
 *   - Empty strings (caller passed undefined/null by mistake)
 *   - Excessive length (caller passed a display name or URL)
 *   - Composite-key shapes (the QUA-417 bug)
 *
 * Throws `InvalidRecordIdError` on rejection. For a non-throwing boundary
 * check use `isCandidateRecordId()`.
 *
 * NOTE: Does not validate `recordType` — use `isValidRecordType()` for that.
 * The `T extends RecordType` type param is compile-time only; at runtime a
 * caller could still hand in an unregistered string.
 */
export function asRecordId<T extends RecordType>(
  recordType: T,
  rawId: string,
): RecordId<T> {
  if (typeof rawId !== "string") {
    throw new InvalidRecordIdError(
      recordType,
      String(rawId),
      `rawId must be string, got ${typeof rawId}`,
    );
  }
  if (rawId.length === 0) {
    throw new InvalidRecordIdError(recordType, rawId, "empty string");
  }
  if (rawId.length > 200) {
    throw new InvalidRecordIdError(
      recordType,
      rawId.slice(0, 50) + "...",
      `length ${rawId.length} exceeds 200 — likely a URL or display name`,
    );
  }
  if (looksLikeCompositeKey(rawId)) {
    throw new InvalidRecordIdError(
      recordType,
      rawId,
      "looks like a composite React key (e.g. `${owner}-${record}`); " +
        "pass the raw PK instead. QUA-417 shipped exactly this bug on " +
        "funding-connections.tsx.",
    );
  }
  return rawId as RecordId<T>;
}

/**
 * Non-throwing check: does this value pass the same runtime guards as
 * `asRecordId()`? Useful at system boundaries (URL params, API responses)
 * where you'd want to render a 404 rather than crash.
 */
export function isCandidateRecordId(rawId: unknown): rawId is string {
  return (
    typeof rawId === "string" &&
    rawId.length > 0 &&
    rawId.length <= 200 &&
    !looksLikeCompositeKey(rawId)
  );
}

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
  fullTextPreview: z.string().max(CITATION_CONTENT_PREVIEW_MAX).nullable().optional().transform(v => v?.replace(/\0/g, '') ?? v),
  fullText: z.string().max(CITATION_CONTENT_FULL_TEXT_MAX).nullable().optional().transform(v => v?.replace(/\0/g, '') ?? v),
  contentLength: z.number().int().nullable().optional(),
  contentHash: z.string().max(64).nullable().optional(),
  /** How content was fetched: firecrawl, built-in, youtube-transcript, abstract */
  fetchMethod: z.string().max(50).nullable().optional(),
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
  fetchMethod: string | null;
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
// Page Citations (used by references.ts and citations.ts routes)
// ---------------------------------------------------------------------------

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
    wikiId: string | null;
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
  wikiId: string | null;
  title: string;
  description: string | null;
  summary: string | null;
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
  stableId: z.string().max(20).nullable().optional(),
  citedBy: z.array(z.string().min(1).max(200)).max(500).nullable().optional(),
  /** Wayback Machine archive URL */
  archiveUrl: z.string().url().max(2000).nullable().optional(),
  /** Stance for legislation coverage */
  stance: z.enum(["support", "oppose", "neutral", "mixed", "analysis"]).nullable().optional(),
  // Enrichment fields (Phase 1)
  contextNote: z.string().max(500).nullable().optional(),
  resourcePurpose: z.string().max(100).nullable().optional(),
  resourceSubtype: z.string().max(100).nullable().optional(),
  typeMetadata: z.record(z.unknown()).nullable().optional(),
  publisherEntityId: z.string().max(200).nullable().optional(),
  relatedEntityIds: z.array(z.string().max(200)).max(50).nullable().optional(),
  enrichmentStatus: z.string().max(50).nullable().optional(),
  importanceScore: z.number().min(0).max(1).nullable().optional(),
  /** How content behaves over time: immutable | versioned | evergreen | ephemeral */
  contentLifecycle: z.enum(["immutable", "versioned", "evergreen", "ephemeral"]).nullable().optional(),
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
  /** HTTP reachability of the URL. Distinct from enrichmentStatus (LLM pipeline stage). */
  fetchStatus: "ok" | "dead" | "soft_404" | "not_found" | "timeout" | "unreachable" | "paywall" | "error" | null;
  lastFetchedAt: string | null;
  archiveUrl: string | null;
  contextNote: string | null;
  resourcePurpose: string | null;
  resourceSubtype: string | null;
  typeMetadata: Record<string, unknown> | null;
  publisherEntityId: string | null;
  relatedEntityIds: string[] | null;
  /** LLM enrichment pipeline stage. Distinct from fetchStatus (HTTP reachability). */
  enrichmentStatus: string | null;
  enrichmentDate: string | null;
  importanceScore: number | null;
  createdAt: string;
  updatedAt: string;
}

// -- Resources: Sub-table schemas -----------------------------------------------

export const UpsertResourcePaperSchema = z.object({
  arxivId: z.string().max(50).nullable().optional(),
  doi: z.string().max(200).nullable().optional(),
  semanticScholarId: z.string().max(200).nullable().optional(),
  abstract: z.string().max(50000).nullable().optional(),
  citationCount: z.number().int().min(0).nullable().optional(),
  influentialCitationCount: z.number().int().min(0).nullable().optional(),
  categories: z.array(z.string().max(50)).max(20).nullable().optional(),
  methodology: z.string().max(100).nullable().optional(),
  year: z.number().int().min(1900).max(2100).nullable().optional(),
});
export type UpsertResourcePaper = z.infer<typeof UpsertResourcePaperSchema>;

export const UpsertResourceForumPostSchema = z.object({
  forum: z.enum(["lesswrong", "alignmentforum", "eaforum"]),
  forumPostId: z.string().max(200).nullable().optional(),
  forumSlug: z.string().max(500).nullable().optional(),
  karma: z.number().int().nullable().optional(),
  commentCount: z.number().int().min(0).nullable().optional(),
  authorUsername: z.string().max(200).nullable().optional(),
  forumTags: z.array(z.string().max(200)).max(50).nullable().optional(),
  sequenceTitle: z.string().max(500).nullable().optional(),
  curated: z.boolean().nullable().optional(),
  crossPostedFrom: z.string().max(200).nullable().optional(),
  canonicalForum: z.string().max(50).nullable().optional(),
});
export type UpsertResourceForumPost = z.infer<typeof UpsertResourceForumPostSchema>;

export const UpsertResourcePolicyDocSchema = z.object({
  documentType: z.string().max(100).nullable().optional(),
  jurisdictionEntityId: z.string().max(200).nullable().optional(),
  agencyEntityId: z.string().max(200).nullable().optional(),
  policyEntityId: z.string().max(200).nullable().optional(),
  effectiveDate: z.string().max(100).nullable().optional(),
  documentStatus: z.string().max(100).nullable().optional(),
  referenceNumber: z.string().max(200).nullable().optional(),
});
export type UpsertResourcePolicyDoc = z.infer<typeof UpsertResourcePolicyDocSchema>;

// -- Resources: Sub-table response types ----------------------------------------

export interface ResourcePaperRow {
  arxivId: string | null;
  doi: string | null;
  semanticScholarId: string | null;
  abstract: string | null;
  citationCount: number | null;
  influentialCitationCount: number | null;
  categories: string[] | null;
  methodology: string | null;
  year: number | null;
}

export interface ResourceForumPostRow {
  forum: string;
  forumPostId: string | null;
  forumSlug: string | null;
  karma: number | null;
  commentCount: number | null;
  authorUsername: string | null;
  forumTags: string[] | null;
  sequenceTitle: string | null;
  curated: boolean | null;
  crossPostedFrom: string | null;
  canonicalForum: string | null;
}

export interface ResourcePolicyDocRow {
  documentType: string | null;
  jurisdictionEntityId: string | null;
  agencyEntityId: string | null;
  policyEntityId: string | null;
  effectiveDate: string | null;
  documentStatus: string | null;
  referenceNumber: string | null;
}

/** Resource with all sub-table data merged in. */
export interface ResourceDetailRow extends ResourceRow {
  paper: ResourcePaperRow | null;
  forumPost: ResourceForumPostRow | null;
  policyDoc: ResourcePolicyDocRow | null;
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
  /** Breakdown by enrichment_status (LLM pipeline stage; null → "none"). */
  byEnrichmentStatus: Record<string, number>;
  /** Content cache (citation_content) population stats. */
  contentCacheStats: {
    withFullText: number;
    withMetadataOnly: number;
    uncached: number;
  };
}

// -- Resources: Fetch status (HTTP reachability) ----------------------------
//
// fetch_status tracks whether the resource URL is reachable. It is written by
// resource-ingest (job handler) and source-fetcher after each HTTP fetch attempt.
// This is distinct from enrichment_status (LLM pipeline stage).
//
// Fine-grained statuses: soft_404, not_found, timeout, unreachable are subtypes
// of the legacy "dead" bucket. Stored as-is in the text column for richer
// retry logic and analytics. UI code should treat them as "dead" for display.
export const DEAD_FETCH_STATUSES = ["dead", "soft_404", "not_found", "timeout", "unreachable"] as const;

/** Check if a fetch_status value indicates a dead/unreachable resource. */
export function isDeadFetchStatus(status: string | null | undefined): boolean {
  return status != null && (DEAD_FETCH_STATUSES as readonly string[]).includes(status);
}

export const UpdateResourceFetchStatusSchema = z.object({
  fetchStatus: z.enum(["ok", "dead", "soft_404", "not_found", "timeout", "unreachable", "paywall", "error"]),
  lastFetchedAt: z.string().datetime(),
  fetchedTitle: z.string().max(1000).optional(),
  /**
   * SHA-256 prefix (lowercase hex) of the freshly-fetched content. When
   * provided, persisted to `resources.content_hash` so subsequent re-ingest
   * jobs can pass it as `previousContentHash` and detect content drift via
   * the QUA-312 Phase 2 skip-guard bypass. Null/empty content (dead links,
   * paywalls) skips this update. Soft-404 / cookie-wall responses also
   * skip — see resource-ingest.ts persistedHash logic.
   *
   * Length cap of 64 accommodates any prefix of SHA-256 (production today
   * uses the first 16 hex via CONTENT_HASH_PREFIX_LENGTH).
   */
  contentHash: z.string().regex(/^[0-9a-f]+$/, "must be lowercase hex").min(1).max(64).optional(),
});
export type UpdateResourceFetchStatus = z.infer<typeof UpdateResourceFetchStatusSchema>;

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

// -- Resources: Suggest endpoint ------------------------------------------------

export const SUGGEST_RESOURCES_MAX_URLS = 50;
export const SUGGEST_RESOURCES_DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export const SuggestResourcesSchema = z.object({
  urls: z.array(z.string().url().max(2000)).min(1).max(SUGGEST_RESOURCES_MAX_URLS),
  entityId: z.string().max(200).optional(),
  agentSessionId: z.string().max(200).optional(),
  maxContentAgeMs: z.number().int().positive().optional(),
});
export type SuggestResources = z.infer<typeof SuggestResourcesSchema>;

export const CONTENT_STATUS_VALUES = [
  "fresh",
  "stale",
  "missing",
] as const;
export type ContentStatus = (typeof CONTENT_STATUS_VALUES)[number];

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/**
 * Editorial status values for entities. Matches the EntityStatus Zod enum in
 * data/schema.ts and the CHECK constraint chk_entities_status added in
 * migration 0218 (QUA-526). Update all three together if values change.
 */
export const ENTITY_STATUS_VALUES = ["stub", "draft", "published", "verified"] as const;

export const SyncEntitySchema = z.object({
  id: z.string().min(1).max(300),
  wikiId: z.string().max(20).nullable().optional(),
  stableId: z.string().min(1).max(20), // Required — PK of entities table
  entityType: z.string().min(1).max(100),
  title: z.string().min(1).max(500),
  description: z.string().max(50000).nullable().optional(),
  website: z.string().max(2000).nullable().optional(),
  tags: z.array(z.string().max(200)).max(100).nullable().optional(),
  clusters: z.array(z.string().max(200)).max(50).nullable().optional(),
  status: z.enum(ENTITY_STATUS_VALUES).nullable().optional(),
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
  metadata: z.record(z.unknown()).nullable().optional(),
});
export type SyncEntity = z.infer<typeof SyncEntitySchema>;

export const SyncEntitiesBatchSchema = z.object({
  entities: z.array(SyncEntitySchema).min(1).max(MAX_BATCH_SIZE),
});

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

export const SyncFactSchema = z
  .object({
    entityId: z.string().min(1).max(300),
    factId: z.string().min(1).max(100),
    label: z.string().max(500).nullable().optional(),
    value: z.string().max(5000).nullable().optional(),
    numeric: z.number().nullable().optional(),
    low: z.number().nullable().optional(),
    high: z.number().nullable().optional(),
    asOf: z.string().max(20).nullable().optional(),
    validEnd: z.string().max(20).nullable().optional(),
    currency: z.string().max(10).nullable().optional(),
    measure: z.string().max(100).nullable().optional(),
    subject: z.string().max(300).nullable().optional(),
    note: z.string().max(5000).nullable().optional(),
    source: z.string().max(2000).nullable().optional(),
    format: z.string().max(100).nullable().optional(),
    formatDivisor: z.number().nullable().optional(),
    sourceQuote: z.string().max(5000).nullable().optional(),
    usdEquivalent: z.number().nullable().optional(),
    exchangeRate: z.number().nullable().optional(),
    exchangeRateDate: z.string().max(20).nullable().optional(),
    dollarYear: z.number().int().nullable().optional(),
    /**
     * QUA-729 Phase A: optional inline sourcing verdict. When present, the
     * /sync route writes a `source_check_verdicts` row in the same transaction.
     * Backwards-compatible — fail-open when absent.
     */
    sourcing: InlineSourcingSchema.optional(),
  })
  // Numeric formats must have populated numeric/low/high columns. Otherwise the
  // read path silently coerced NULL → 0, masking missing data as legitimate
  // zeros (e.g. "0 employees" indistinguishable from "unknown"). Issue #4017.
  .superRefine((fact, ctx) => {
    if (fact.format === "number" || fact.format === "min") {
      if (fact.numeric == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["numeric"],
          message: `format='${fact.format}' requires numeric to be a number, got null/undefined (factId=${fact.factId})`,
        });
      }
    }
    if (fact.format === "range") {
      if (fact.low == null || fact.high == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["low"],
          message: `format='range' requires both low and high to be numbers (factId=${fact.factId}, low=${fact.low}, high=${fact.high})`,
        });
      }
    }
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
  dedupKey: z.string().max(200).optional(),
  parentJobId: z.number().int().positive().optional(),
  runAfter: z.string().datetime().optional(),
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
  types: z.array(z.string().min(1).max(100)).optional(),
  workerId: z.string().min(1).max(200),
});
export type ClaimJob = z.infer<typeof ClaimJobSchema>;

export const CompleteJobSchema = z.object({
  result: z.record(z.unknown()).nullable().optional(),
  cost: z.number().nonnegative().finite().max(999999.9999).optional(),
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
  /** The page slug (e.g., "anthropic"). Maps to wiki_pages.slug in the DB. */
  id: z.string().min(1).max(300),
  wikiId: z.string().max(20).nullable().optional(),
  title: z.string().min(1).max(500),
  description: z.string().max(5000).nullable().optional(),
  summary: z.string().max(10000).nullable().optional(),
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

/**
 * Canonical Linear issue identifier format — one or more uppercase letters
 * (team key), a hyphen, one or more digits. Enforced at the DB level by
 * `chk_agent_sessions_linear_id_format` and validated at the API boundary
 * here so bad writes get rejected before they hit PG.
 */
export const LINEAR_ID_PATTERN = /^[A-Z]+-\d+$/;
/** Required, non-nullable variant — used for path params where the value must be present. */
export const LinearIdParamSchema = z
  .string()
  .regex(LINEAR_ID_PATTERN, "Linear ID must match /^[A-Z]+-\\d+$/")
  .max(50);
const LinearIdSchema = LinearIdParamSchema.nullable().optional();

/**
 * Agent slot number (a0..a99). Matches the CHECK constraint on
 * agent_sessions.slot_number.
 */
const SlotNumberSchema = z
  .number()
  .int()
  .min(0)
  .max(99)
  .nullable()
  .optional();

export const CreateAgentSessionSchema = z.object({
  branch: z.string().min(1).max(500),
  task: z.string().min(1).max(2000),
  sessionType: z.enum(VALID_SESSION_TYPES),
  issueNumber: z.number().int().positive().nullable().optional(),
  linearId: LinearIdSchema,
  slotNumber: SlotNumberSchema,
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
  // QUA-440: allow late-binding linearId/slotNumber in case init is run with
  // --no-linear-start and the caller backfills later.
  linearId: LinearIdSchema,
  slotNumber: SlotNumberSchema,
  // Session log fields — written at session end (replaces separate sessions table for agent workflow)
  date: DateStringSchema.optional(),
  title: z.string().min(1).max(1000).nullable().optional(),
  summary: z.string().max(10000).nullable().optional(),
  model: z.string().max(100).nullable().optional(),
  duration: z.string().max(100).nullable().optional(),
  cost: z.string().max(100).nullable().optional(),
  costCents: z.number().int().min(0).nullable().optional(),
  durationMinutes: z.number().min(0).nullable().optional(),
  checksYaml: z.string().max(10000).nullable().optional(),
  issuesJson: z.array(z.unknown()).nullable().optional(),
  learningsJson: z.array(z.unknown()).nullable().optional(),
  recommendationsJson: z.array(z.unknown()).nullable().optional(),
  reviewed: z.boolean().nullable().optional(),
  /** Page IDs touched in this session — replaces agent_session_pages when provided */
  pages: z.array(z.string().min(1).max(200)).optional(),
  /** Entity stableIds touched in this session — replaces agent_session_entities when provided */
  entities: z.array(z.string().length(10)).optional(),
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
// Pipeline Runs (QUA-954)
// ---------------------------------------------------------------------------

/**
 * v1 status enum. Mirrors the CHECK constraint on `pipeline_runs.status`.
 * Widening requires a follow-up migration that enumerates prod row
 * distribution first — see `.claude/rules/database-migrations.md`.
 */
export const VALID_PIPELINE_RUN_STATUSES = [
  "running",
  "committed",
  "aborted",
  "oscillation",
  "partial_failure",
] as const;

export const PipelineRunStatusSchema = z.enum(VALID_PIPELINE_RUN_STATUSES);
export type PipelineRunStatus = z.infer<typeof PipelineRunStatusSchema>;

/** End-state set: the four statuses callers may move to from `running`. */
export const VALID_PIPELINE_RUN_END_STATUSES = [
  "committed",
  "aborted",
  "oscillation",
  "partial_failure",
] as const;

export const PipelineRunEndStatusSchema = z.enum(VALID_PIPELINE_RUN_END_STATUSES);
export type PipelineRunEndStatus = z.infer<typeof PipelineRunEndStatusSchema>;

// Format constraint: alphanumeric + dash + underscore only. Matches
// nanoid / uuid v4 / hex tokens but rejects whitespace, control chars,
// and JSON/SQL/HTML injection vectors slipping through `.max(128)`.
const PIPELINE_RUN_ID_RE = /^[A-Za-z0-9_-]+$/;

// Cap structured payload size — `errorPayload` and `followupActions`
// are JSONB columns and a buggy or malicious caller could otherwise
// post a 100MB blob, blowing up audit log row size and dashboard
// rendering. Bounds on the JSON-serialized form are checked via a
// Zod refinement; the array also has an item count cap.
const MAX_ERROR_PAYLOAD_BYTES = 32_768; // 32 KiB
const MAX_FOLLOWUPS_COUNT = 50;
const MAX_FOLLOWUP_BYTES = 4_096; // per item

function jsonByteSize(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    // Circular or non-serializable — reject as oversize.
    return Number.POSITIVE_INFINITY;
  }
}

const BoundedJsonObjectSchema = z
  .record(z.unknown())
  .refine((v) => jsonByteSize(v) <= MAX_ERROR_PAYLOAD_BYTES, {
    message: `errorPayload must serialize to <= ${MAX_ERROR_PAYLOAD_BYTES} bytes`,
  });

const BoundedFollowupSchema = z
  .record(z.unknown())
  .refine((v) => jsonByteSize(v) <= MAX_FOLLOWUP_BYTES, {
    message: `followupActions item must serialize to <= ${MAX_FOLLOWUP_BYTES} bytes`,
  });

export const StartPipelineRunSchema = z.object({
  // The caller mints the run_id (typically nanoid/uuid v4 from
  // crux/lib/pipeline-runs/lifecycle.ts) so the helper can return it
  // synchronously without waiting for the server response.
  runId: z.string().min(1).max(128).regex(PIPELINE_RUN_ID_RE),
  pipelineName: z.string().min(1).max(200),
  agentSessionId: z.number().int().positive().nullable().optional(),
  entityId: z.string().max(200).nullable().optional(),
  shape: z.string().max(100).nullable().optional(),
});
export type StartPipelineRun = z.infer<typeof StartPipelineRunSchema>;

// QUA-1012: cost-telemetry caps. costUsd is bounded well above any
// realistic single-run spend ($10k) so a buggy CostTracker can't post
// a billion-dollar value into prod; token counts are bounded below
// signed-int32 max so the integer column never overflows.
//
// Exported so the typed client (and any other caller) can reference the
// canonical cap rather than re-stating the literal in JSDoc, where it
// silently drifts when the cap moves.
export const MAX_COST_USD = 10_000;
export const MAX_TOKENS = 2_000_000_000;

// Shared chain so a refactor that drops `.int()` from one field can't
// silently weaken validation on the other three.
const TokenCountSchema = z
  .number()
  .int()
  .nonnegative()
  .finite()
  .max(MAX_TOKENS)
  .nullable()
  .optional();

export const EndPipelineRunSchema = z.object({
  status: PipelineRunEndStatusSchema,
  failureReason: z.string().max(200).nullable().optional(),
  errorCode: z.string().max(200).nullable().optional(),
  errorPayload: BoundedJsonObjectSchema.nullable().optional(),
  snapshotPath: z.string().max(500).nullable().optional(),
  followupActions: z.array(BoundedFollowupSchema).max(MAX_FOLLOWUPS_COUNT).optional(),
  // `0` is a valid cost (the caller tracked spend and it really was zero).
  // `null` / omitted means "not tracked" — distinct semantics. Aggregates in
  // the dashboard use `SUM(cost_usd)` which treats both NULL and 0 as 0, but
  // count-of-tracked-runs queries should filter `WHERE cost_usd IS NOT NULL`.
  // `.multipleOf(0.0001)` rejects values with more precision than the
  // numeric(10,4) column can store, so what the caller submits is what gets
  // persisted (no silent PG-side rounding that returns a different value).
  costUsd: z
    .number()
    .nonnegative()
    .finite()
    .max(MAX_COST_USD)
    .multipleOf(0.0001)
    .nullable()
    .optional(),
  tokensInput: TokenCountSchema,
  tokensOutput: TokenCountSchema,
  tokensCacheRead: TokenCountSchema,
  tokensCacheWrite: TokenCountSchema,
});
export type EndPipelineRun = z.infer<typeof EndPipelineRunSchema>;

// Model-swap eval step 1b: captured LLM request/response bodies. Stored whole
// — no size cap. Postgres text/jsonb handle multi-MB values fine, and a clipped
// prompt is useless for replay. Capture is sampled + off by default, so volume
// is bounded by the sample rate rather than a per-row size limit.
export const RecordLlmPayloadSchema = z.object({
  // Soft reference to the pipeline_runs row (no FK). Null when the call ran
  // outside any withPipelineRun lifecycle.
  runId: z.string().min(1).max(128).regex(PIPELINE_RUN_ID_RE).nullable().optional(),
  flow: z.string().max(200).nullable().optional(),
  label: z.string().max(200).nullable().optional(),
  model: z.string().min(1).max(200),
  viaOpenrouter: z.boolean().optional(),
  request: z.record(z.unknown()),
  response: z.string(),
  tokensInput: TokenCountSchema,
  tokensOutput: TokenCountSchema,
});
export type RecordLlmPayload = z.infer<typeof RecordLlmPayloadSchema>;

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

// ---------------------------------------------------------------------------
// Page Assessments
// ---------------------------------------------------------------------------

export const VALID_ASSESSORS = [
  "structural",
  "llm-grading",
  "editorial",
  "frontmatter-sync",
] as const;

export type Assessor = (typeof VALID_ASSESSORS)[number];

export const PageAssessmentSchema = z.object({
  pageId: PageIdSchema,
  assessor: z.enum(VALID_ASSESSORS),
  method: z.string().max(200).nullable().optional(),
  model: z.string().max(200).nullable().optional(),
  quality: z.number().int().min(0).max(100).nullable().optional(),
  readerImportance: z.number().min(0).max(100).nullable().optional(),
  researchImportance: z.number().min(0).max(100).nullable().optional(),
  tacticalValue: z.number().min(0).max(100).nullable().optional(),
  ratingFocus: z.number().min(0).max(10).nullable().optional(),
  ratingNovelty: z.number().min(0).max(10).nullable().optional(),
  ratingRigor: z.number().min(0).max(10).nullable().optional(),
  ratingCompleteness: z.number().min(0).max(10).nullable().optional(),
  ratingConcreteness: z.number().min(0).max(10).nullable().optional(),
  ratingActionability: z.number().min(0).max(10).nullable().optional(),
  ratingObjectivity: z.number().min(0).max(10).nullable().optional(),
  structuralScore: z.number().int().min(0).max(15).nullable().optional(),
  wordCount: z.number().int().min(0).nullable().optional(),
  note: z.string().max(5000).nullable().optional(),
  assessedAt: z.string().datetime().optional(),
});
export type PageAssessment = z.infer<typeof PageAssessmentSchema>;

export const PageAssessmentBatchSchema = z.object({
  items: z.array(PageAssessmentSchema).min(1).max(MAX_BATCH_SIZE),
});

// ---------------------------------------------------------------------------
// QA Page Checks
// ---------------------------------------------------------------------------

export const RecordQaCheckSchema = z.object({
  thingId: z.string().nullable().optional(),
  pageUrl: z.string().min(1).max(500),
  directory: z.string().max(100).nullable().optional(),
  checkType: z
    .enum(["index", "detail", "cross-consistency"])
    .default("detail"),
  result: z.enum(["clean", "issues_found", "error", "404"]),
  findings: z
    .array(
      z.object({
        severity: z.enum(["P0", "P1", "P2"]),
        description: z.string(),
        githubIssue: z.number().optional(),
      })
    )
    .nullable()
    .optional(),
  depth: z
    .enum(["quick", "standard", "deep", "exhaustive"])
    .nullable()
    .optional(),
  sweepId: z.string().max(100).nullable().optional(),
  checkedAt: z.string().datetime().optional(),
});

export const RecordQaCheckBatchSchema = z.object({
  items: z.array(RecordQaCheckSchema).min(1).max(200),
});

// ---------------------------------------------------------------------------
// Claims: Proposed Claims schemas (issue #3253)
// ---------------------------------------------------------------------------

export const VALID_CLAIM_STATUSES = [
  "pending",
  "verifying",
  "verified",
  "contradicted",
  "unverifiable",
  "expired",
] as const;
export type ClaimStatus = (typeof VALID_CLAIM_STATUSES)[number];

export const ProposeClaimsSchema = z.object({
  // entityId is required: claims for "unknown entity" become orphan rows that
  // verification jobs cannot resolve, leaving them stuck in pending forever.
  // Issue #4017.
  entityId: z.string().min(1).max(200),
  targetTable: z.string().min(1).max(100),
  agentSessionId: z.string().max(200).optional(),
  claims: z
    .array(
      z.object({
        claimText: z.string().min(1).max(5000),
        targetField: z.string().max(200).optional(),
        proposedValue: z.string().max(5000).optional(),
        proposedData: z.record(z.unknown()).optional(),
        resourceId: z.string().min(1).max(200).optional(),
        sourceUrl: z.string().url().max(2000),
        agentEvidence: z.string().min(1).max(5000).optional(),
      })
    )
    .min(1)
    .max(100),
});
export type ProposeClaims = z.infer<typeof ProposeClaimsSchema>;

export const ClaimVerdictSchema = z.object({
  claimId: z.coerce.number().int().positive(),
  status: z.enum(["verified", "contradicted", "unverifiable"]),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().max(5000),
  extractedValue: z.string().max(5000).optional(),
  checkerModel: z.string().max(100).optional(),
});
export type ClaimVerdict = z.infer<typeof ClaimVerdictSchema>;

export const ClaimVerdictBatchSchema = z.object({
  verdicts: z.array(ClaimVerdictSchema).min(1).max(100).refine(
    (arr) => new Set(arr.map((v) => v.claimId)).size === arr.length,
    "Duplicate claimIds are not allowed",
  ),
});
export type ClaimVerdictBatch = z.infer<typeof ClaimVerdictBatchSchema>;

// -- Claims read query schemas --

export const ClaimsAllQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
  status: z.enum(VALID_CLAIM_STATUSES).optional(),
  target_table: z.string().max(100).optional(),
  entity_id: z.string().max(200).optional(),
});

export const ClaimsByEntityQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

// ---------------------------------------------------------------------------
// Data Quality — ID Format Audit (QUA-407 / QUA-439)
// ---------------------------------------------------------------------------
//
// Surfaces coexisting ID formats in the `things` table so the
// /internal/data-quality dashboard can show sprawl at a glance.
// Classifier source: apps/wiki-server/src/routes/operational/data-quality.ts
// (ID_FORMAT_REGEXES). Keep in sync — grep for IdFormatAuditSchema on rename.

export const ID_FORMAT_BUCKET_NAMES = [
  "canonical_f",
  "canonical_sid",
  "legacy_hex8",
  "legacy_alnum10",
  "legacy_hex16",
  "other",
] as const;

export const ID_FORMAT_SOURCE_TABLES = ["facts", "resources"] as const;

const IdFormatBucketCountsSchema = z.object({
  canonical_f: z.number().int().nonnegative(),
  canonical_sid: z.number().int().nonnegative(),
  legacy_hex8: z.number().int().nonnegative(),
  legacy_alnum10: z.number().int().nonnegative(),
  legacy_hex16: z.number().int().nonnegative(),
  other: z.number().int().nonnegative(),
});

export const IdFormatAuditSchema = z.object({
  scannedAt: z.string(),
  totals: IdFormatBucketCountsSchema,
  bySourceTable: z.object({
    facts: IdFormatBucketCountsSchema,
    resources: IdFormatBucketCountsSchema,
  }),
});

export type IdFormatAudit = z.infer<typeof IdFormatAuditSchema>;
export type IdFormatBucketName = (typeof ID_FORMAT_BUCKET_NAMES)[number];
export type IdFormatSourceTableName = (typeof ID_FORMAT_SOURCE_TABLES)[number];
