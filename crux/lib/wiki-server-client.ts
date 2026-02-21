/**
 * Wiki Server Client — HTTP client for the wiki-server API
 *
 * Provides graceful fallback: all methods return null on failure,
 * letting callers fall back to local data (YAML files, SQLite, etc.).
 *
 * Configuration via environment variables:
 *   LONGTERMWIKI_SERVER_URL     — Base URL (e.g. "https://wiki-server.k8s.quantifieduncertainty.org")
 *   LONGTERMWIKI_SERVER_API_KEY — Bearer token for authentication
 */

const TIMEOUT_MS = 5_000;
const BATCH_TIMEOUT_MS = 30_000;
const RISK_BATCH_SIZE = 100;

export function getServerUrl(): string {
  return process.env.LONGTERMWIKI_SERVER_URL || '';
}

export function getApiKey(): string {
  return process.env.LONGTERMWIKI_SERVER_API_KEY || '';
}

export function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const apiKey = getApiKey();
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  return headers;
}

/**
 * Check if the wiki-server is reachable and healthy.
 */
export async function isServerAvailable(): Promise<boolean> {
  const serverUrl = getServerUrl();
  if (!serverUrl) return false;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const res = await fetch(`${serverUrl}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) return false;

    const body = await res.json();
    return body.status === 'healthy';
  } catch {
    return false;
  }
}

/**
 * Make a JSON request to the wiki-server API.
 * Returns the parsed JSON response or null on any failure.
 */
async function apiRequest<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T | null> {
  const serverUrl = getServerUrl();
  if (!serverUrl) return null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const options: RequestInit = {
      method,
      headers: buildHeaders(),
      signal: controller.signal,
    };

    if (body !== undefined) {
      options.body = JSON.stringify(body);
    }

    const res = await fetch(`${serverUrl}${path}`, options);
    clearTimeout(timer);

    if (!res.ok) return null;

    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Edit Logs API
// ---------------------------------------------------------------------------

export interface EditLogApiEntry {
  pageId: string;
  date: string;
  tool: string;
  agency: string;
  requestedBy?: string | null;
  note?: string | null;
}

interface AppendResult {
  id: number;
  pageId: string;
  date: string;
  createdAt: string;
}

interface BatchResult {
  inserted: number;
  results: Array<{ id: number; pageId: string }>;
}

interface GetEntriesResult {
  entries: Array<{
    id: number;
    pageId: string;
    date: string;
    tool: string;
    agency: string;
    requestedBy: string | null;
    note: string | null;
    createdAt: string;
  }>;
}

interface StatsResult {
  totalEntries: number;
  pagesWithLogs: number;
  byTool: Record<string, number>;
  byAgency: Record<string, number>;
}

/**
 * Append a single edit log entry to the database.
 */
export async function appendEditLogToServer(
  entry: EditLogApiEntry,
): Promise<AppendResult | null> {
  return apiRequest<AppendResult>('POST', '/api/edit-logs', entry);
}

/**
 * Append multiple edit log entries in a single batch.
 */
export async function appendEditLogBatch(
  items: EditLogApiEntry[],
): Promise<BatchResult | null> {
  return apiRequest<BatchResult>('POST', '/api/edit-logs/batch', { items });
}

/**
 * Get all edit log entries for a specific page.
 */
export async function getEditLogsForPage(
  pageId: string,
): Promise<GetEntriesResult | null> {
  return apiRequest<GetEntriesResult>(
    'GET',
    `/api/edit-logs?page_id=${encodeURIComponent(pageId)}`,
  );
}

/**
 * Get aggregate edit log statistics.
 */
export async function getEditLogStats(): Promise<StatsResult | null> {
  return apiRequest<StatsResult>('GET', '/api/edit-logs/stats');
}

interface LatestDatesResult {
  dates: Record<string, string>;
}

/**
 * Get the latest edit date for every page (for build-data.mjs).
 * Returns a map of pageId → YYYY-MM-DD.
 */
export async function getEditLogLatestDates(): Promise<LatestDatesResult | null> {
  return apiRequest<LatestDatesResult>('GET', '/api/edit-logs/latest-dates');
}

// ---------------------------------------------------------------------------
// Citation Quotes API
// ---------------------------------------------------------------------------

export interface UpsertCitationQuoteItem {
  pageId: string;
  footnote: number;
  url?: string | null;
  resourceId?: string | null;
  claimText: string;
  claimContext?: string | null;
  sourceQuote?: string | null;
  sourceLocation?: string | null;
  quoteVerified?: boolean;
  verificationMethod?: string | null;
  verificationScore?: number | null;
  sourceTitle?: string | null;
  sourceType?: string | null;
  extractionModel?: string | null;
}

interface UpsertCitationQuoteResult {
  id: number;
  pageId: string;
  footnote: number;
  createdAt: string;
  updatedAt: string;
}

interface UpsertCitationQuoteBatchResult {
  results: Array<{ id: number; pageId: string; footnote: number }>;
}

/**
 * Upsert a single citation quote to the wiki-server database.
 */
export async function upsertCitationQuote(
  item: UpsertCitationQuoteItem,
): Promise<UpsertCitationQuoteResult | null> {
  return apiRequest<UpsertCitationQuoteResult>('POST', '/api/citations/quotes/upsert', item);
}

/**
 * Upsert multiple citation quotes in a single batch.
 */
export async function upsertCitationQuoteBatch(
  items: UpsertCitationQuoteItem[],
): Promise<UpsertCitationQuoteBatchResult | null> {
  return apiRequest<UpsertCitationQuoteBatchResult>(
    'POST',
    '/api/citations/quotes/upsert-batch',
    { items },
  );
}

// ---------------------------------------------------------------------------
// Citation Accuracy API
// ---------------------------------------------------------------------------

export type AccuracyVerdict = 'accurate' | 'inaccurate' | 'unsupported' | 'minor_issues' | 'not_verifiable';

export interface MarkAccuracyItem {
  pageId: string;
  footnote: number;
  verdict: AccuracyVerdict;
  score: number;
  issues?: string | null;
  supportingQuotes?: string | null;
  verificationDifficulty?: 'easy' | 'moderate' | 'hard' | null;
}

interface MarkAccuracyResult {
  updated: true;
  pageId: string;
  footnote: number;
  verdict: string;
}

interface MarkAccuracyBatchResult {
  updated: number;
  results: Array<{ pageId: string; footnote: number; verdict: string }>;
}

interface SnapshotResult {
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

/**
 * Mark accuracy verdict for a single citation.
 */
export async function markCitationAccuracy(
  item: MarkAccuracyItem,
): Promise<MarkAccuracyResult | null> {
  return apiRequest<MarkAccuracyResult>('POST', '/api/citations/quotes/mark-accuracy', item);
}

/**
 * Mark accuracy verdicts for multiple citations in a single batch.
 */
export async function markCitationAccuracyBatch(
  items: MarkAccuracyItem[],
): Promise<MarkAccuracyBatchResult | null> {
  return apiRequest<MarkAccuracyBatchResult>(
    'POST',
    '/api/citations/quotes/mark-accuracy-batch',
    { items },
  );
}

/**
 * Create accuracy snapshots for all pages with accuracy data.
 */
export async function createAccuracySnapshot(): Promise<SnapshotResult | null> {
  return apiRequest<SnapshotResult>('POST', '/api/citations/accuracy-snapshot', {});
}

/**
 * Get accuracy dashboard data (replaces YAML export).
 */
export async function getAccuracyDashboard(): Promise<AccuracyDashboardData | null> {
  return apiRequest<AccuracyDashboardData>('GET', '/api/citations/accuracy-dashboard');
}

// ---------------------------------------------------------------------------
// Sessions API
// ---------------------------------------------------------------------------

export interface SessionApiEntry {
  date: string;
  branch?: string | null;
  title: string;
  summary?: string | null;
  model?: string | null;
  duration?: string | null;
  cost?: string | null;
  prUrl?: string | null;
  checksYaml?: string | null;
  issuesJson?: unknown;
  learningsJson?: unknown;
  recommendationsJson?: unknown;
  pages?: string[];
}

interface CreateSessionResult {
  id: number;
  date: string;
  title: string;
  pages: string[];
  createdAt: string;
}

interface SessionBatchResult {
  inserted: number;
  results: Array<{ id: number; title: string; pageCount: number }>;
}

export interface SessionEntry {
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

interface SessionListResult {
  sessions: SessionEntry[];
  total: number;
  limit: number;
  offset: number;
}

interface SessionByPageResult {
  sessions: SessionEntry[];
}

interface SessionStatsResult {
  totalSessions: number;
  uniquePages: number;
  totalPageEdits: number;
  byModel: Record<string, number>;
}

interface SessionPageChangesResult {
  sessions: SessionEntry[];
}

/**
 * Create a single session log entry in the database.
 */
export async function createSession(
  entry: SessionApiEntry,
): Promise<CreateSessionResult | null> {
  return apiRequest<CreateSessionResult>('POST', '/api/sessions', entry);
}

/**
 * Create multiple session log entries in a single batch.
 */
export async function createSessionBatch(
  items: SessionApiEntry[],
): Promise<SessionBatchResult | null> {
  return apiRequest<SessionBatchResult>('POST', '/api/sessions/batch', { items });
}

/**
 * List sessions (paginated, newest first).
 */
export async function listSessions(
  limit = 100,
  offset = 0,
): Promise<SessionListResult | null> {
  return apiRequest<SessionListResult>(
    'GET',
    `/api/sessions?limit=${limit}&offset=${offset}`,
  );
}

/**
 * Get sessions that modified a specific page.
 */
export async function getSessionsByPage(
  pageId: string,
): Promise<SessionByPageResult | null> {
  return apiRequest<SessionByPageResult>(
    'GET',
    `/api/sessions/by-page?page_id=${encodeURIComponent(pageId)}`,
  );
}

/**
 * Get aggregate session statistics.
 */
export async function getSessionStats(): Promise<SessionStatsResult | null> {
  return apiRequest<SessionStatsResult>('GET', '/api/sessions/stats');
}

/**
 * Get all sessions with page associations (for page-changes dashboard).
 */
export async function getSessionPageChanges(): Promise<SessionPageChangesResult | null> {
  return apiRequest<SessionPageChangesResult>('GET', '/api/sessions/page-changes');
}

// ---------------------------------------------------------------------------
// Auto-Update Runs API
// ---------------------------------------------------------------------------

export interface AutoUpdateRunResultEntry {
  pageId: string;
  status: 'success' | 'failed' | 'skipped';
  tier?: string | null;
  durationMs?: number | null;
  errorMessage?: string | null;
}

export interface RecordAutoUpdateRunInput {
  date: string;
  startedAt: string;
  completedAt?: string | null;
  trigger: 'scheduled' | 'manual';
  budgetLimit?: number | null;
  budgetSpent?: number | null;
  sourcesChecked?: number | null;
  sourcesFailed?: number | null;
  itemsFetched?: number | null;
  itemsRelevant?: number | null;
  pagesPlanned?: number | null;
  pagesUpdated?: number | null;
  pagesFailed?: number | null;
  pagesSkipped?: number | null;
  newPagesCreated?: string[];
  results?: AutoUpdateRunResultEntry[];
}

interface RecordRunResult {
  id: number;
  date: string;
  startedAt: string;
  createdAt: string;
  resultsInserted: number;
}

export interface AutoUpdateRunEntry {
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
  results: AutoUpdateRunResultEntry[];
  createdAt: string;
}

interface GetRunsResult {
  entries: AutoUpdateRunEntry[];
  total: number;
  limit: number;
  offset: number;
}

interface AutoUpdateStatsResult {
  totalRuns: number;
  totalBudgetSpent: number;
  totalPagesUpdated: number;
  totalPagesFailed: number;
  byTrigger: Record<string, number>;
}

/**
 * Record a complete auto-update run with per-page results.
 */
export async function recordAutoUpdateRun(
  run: RecordAutoUpdateRunInput,
): Promise<RecordRunResult | null> {
  return apiRequest<RecordRunResult>('POST', '/api/auto-update-runs', run);
}

/**
 * Get paginated list of auto-update runs with results.
 */
export async function getAutoUpdateRuns(
  limit = 50,
  offset = 0,
): Promise<GetRunsResult | null> {
  return apiRequest<GetRunsResult>(
    'GET',
    `/api/auto-update-runs/all?limit=${limit}&offset=${offset}`,
  );
}

/**
 * Get aggregate auto-update statistics.
 */
export async function getAutoUpdateStats(): Promise<AutoUpdateStatsResult | null> {
  return apiRequest<AutoUpdateStatsResult>('GET', '/api/auto-update-runs/stats');
}

// ---------------------------------------------------------------------------
// Auto-Update News Items API
// ---------------------------------------------------------------------------

export interface AutoUpdateNewsItem {
  title: string;
  url: string;
  sourceId: string;
  publishedAt?: string | null;
  summary?: string | null;
  relevanceScore?: number | null;
  topics?: string[];
  entities?: string[];
  routedToPageId?: string | null;
  routedToPageTitle?: string | null;
  routedTier?: string | null;
}

interface NewsItemBatchResult {
  inserted: number;
}

export interface AutoUpdateNewsItemEntry {
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

interface NewsDashboardResult {
  items: AutoUpdateNewsItemEntry[];
  runDates: string[];
}

/**
 * Insert a batch of news items for a specific run.
 */
export async function insertAutoUpdateNewsItems(
  runId: number,
  items: AutoUpdateNewsItem[],
): Promise<NewsItemBatchResult | null> {
  const serverUrl = getServerUrl();
  if (!serverUrl) return null;

  // Split into batches of 500
  let totalInserted = 0;
  const BATCH_SIZE = 500;

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const result = await apiRequest<NewsItemBatchResult>(
      'POST',
      '/api/auto-update-news/batch',
      { runId, items: batch },
    );
    if (result) {
      totalInserted += result.inserted;
    } else {
      return null;
    }
  }

  return { inserted: totalInserted };
}

/**
 * Get news dashboard data (last N runs of news items).
 */
export async function getAutoUpdateNewsDashboard(
  maxRuns = 10,
): Promise<NewsDashboardResult | null> {
  return apiRequest<NewsDashboardResult>(
    'GET',
    `/api/auto-update-news/dashboard?runs=${maxRuns}`,
  );
}

// ---------------------------------------------------------------------------
// Hallucination Risk API
// ---------------------------------------------------------------------------

export interface RiskSnapshot {
  pageId: string;
  score: number;
  level: string;
  factors: string[];
  integrityIssues?: string[];
}

/**
 * Record hallucination risk snapshots for multiple pages.
 * Splits into batches of 100 with a 30s timeout per batch.
 * Returns null on failure.
 */
export async function recordRiskSnapshots(
  snapshots: RiskSnapshot[],
): Promise<{ inserted: number } | null> {
  const serverUrl = getServerUrl();
  if (!serverUrl) return null;

  let totalInserted = 0;

  for (let i = 0; i < snapshots.length; i += RISK_BATCH_SIZE) {
    const batch = snapshots.slice(i, i + RISK_BATCH_SIZE);
    try {
      const res = await fetch(`${serverUrl}/api/hallucination-risk/batch`, {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify({ snapshots: batch }),
        signal: AbortSignal.timeout(BATCH_TIMEOUT_MS),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.warn(
          `  WARNING: Risk snapshot batch failed (${res.status}): ${text.slice(0, 200)}`,
        );
        return null;
      }

      const data = (await res.json()) as { inserted: number };
      totalInserted += data.inserted;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`  WARNING: Risk snapshot batch failed: ${message}`);
      return null;
    }
  }

  return { inserted: totalInserted };
}

// ---------------------------------------------------------------------------
// Summaries API
// ---------------------------------------------------------------------------

export interface UpsertSummaryItem {
  entityId: string;
  entityType: string;
  oneLiner?: string | null;
  summary?: string | null;
  review?: string | null;
  keyPoints?: string[] | null;
  keyClaims?: string[] | null;
  model?: string | null;
  tokensUsed?: number | null;
}

interface UpsertSummaryResult {
  entityId: string;
  entityType: string;
}

interface UpsertSummaryBatchResult {
  inserted: number;
  results: Array<{ entityId: string; entityType: string }>;
}

/**
 * Upsert a single summary to the wiki-server database.
 */
export async function upsertSummary(
  item: UpsertSummaryItem,
): Promise<UpsertSummaryResult | null> {
  return apiRequest<UpsertSummaryResult>('POST', '/api/summaries', item);
}

/**
 * Upsert multiple summaries in a single batch.
 */
export async function upsertSummaryBatch(
  items: UpsertSummaryItem[],
): Promise<UpsertSummaryBatchResult | null> {
  return apiRequest<UpsertSummaryBatchResult>(
    'POST',
    '/api/summaries/batch',
    { items },
  );
}

// ---------------------------------------------------------------------------
// Claims API
// ---------------------------------------------------------------------------

export interface InsertClaimItem {
  entityId: string;
  entityType: string;
  claimType: string;
  claimText: string;
  value?: string | null;
  unit?: string | null;
  confidence?: string | null;
  sourceQuote?: string | null;
}

interface InsertClaimResult {
  id: number;
  entityId: string;
  claimType: string;
}

interface InsertClaimBatchResult {
  inserted: number;
  results: Array<{ id: number; entityId: string; claimType: string }>;
}

interface ClearClaimsResult {
  deleted: number;
}

/**
 * Insert a single claim to the wiki-server database.
 */
export async function insertClaim(
  item: InsertClaimItem,
): Promise<InsertClaimResult | null> {
  return apiRequest<InsertClaimResult>('POST', '/api/claims', item);
}

/**
 * Insert multiple claims in a single batch.
 */
export async function insertClaimBatch(
  items: InsertClaimItem[],
): Promise<InsertClaimBatchResult | null> {
  return apiRequest<InsertClaimBatchResult>(
    'POST',
    '/api/claims/batch',
    { items },
  );
}

/**
 * Delete all claims for a given entity on the wiki-server.
 */
export async function clearClaimsForEntity(
  entityId: string,
): Promise<ClearClaimsResult | null> {
  return apiRequest<ClearClaimsResult>(
    'POST',
    '/api/claims/clear',
    { entityId },
  );
}

// ---------------------------------------------------------------------------
// Page Links API (backlinks & related-page graph)
// ---------------------------------------------------------------------------

export interface PageLinkItem {
  sourceId: string;
  targetId: string;
  linkType: 'yaml_related' | 'entity_link' | 'name_prefix' | 'similarity' | 'shared_tag';
  relationship?: string | null;
  weight: number;
}

interface SyncLinksResult {
  upserted: number;
}

const LINK_BATCH_SIZE = 2000;

/**
 * Sync page links to the wiki-server.
 * Replaces all existing links with the provided set (full sync).
 * Splits into batches for large link sets.
 */
export async function syncPageLinks(
  links: PageLinkItem[],
): Promise<SyncLinksResult | null> {
  const serverUrl = getServerUrl();
  if (!serverUrl) return null;

  let totalUpserted = 0;

  for (let i = 0; i < links.length; i += LINK_BATCH_SIZE) {
    const batch = links.slice(i, i + LINK_BATCH_SIZE);
    const isFirst = i === 0;

    try {
      const res = await fetch(`${serverUrl}/api/links/sync`, {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify({
          links: batch,
          // Only replace on the first batch to clear old data
          replace: isFirst,
        }),
        signal: AbortSignal.timeout(BATCH_TIMEOUT_MS),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.warn(
          `  WARNING: Link sync batch failed (${res.status}): ${text.slice(0, 200)}`,
        );
        return null;
      }

      const data = (await res.json()) as SyncLinksResult;
      totalUpserted += data.upserted;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`  WARNING: Link sync batch failed: ${message}`);
      return null;
    }
  }

  return { upserted: totalUpserted };
}

// Resources API (single upsert for fire-and-forget dual-write)
// ---------------------------------------------------------------------------

export interface UpsertResourceItem {
  id: string;
  url: string;
  title?: string | null;
  type?: string | null;
  summary?: string | null;
  review?: string | null;
  abstract?: string | null;
  keyPoints?: string[] | null;
  publicationId?: string | null;
  authors?: string[] | null;
  publishedDate?: string | null;
  tags?: string[] | null;
  localFilename?: string | null;
  credibilityOverride?: number | null;
  fetchedAt?: string | null;
  contentHash?: string | null;
  citedBy?: string[] | null;
}

interface UpsertResourceResult {
  id: string;
  url: string;
}

/**
 * Upsert a single resource to the wiki-server database.
 */
export async function upsertResource(
  item: UpsertResourceItem,
): Promise<UpsertResourceResult | null> {
  return apiRequest<UpsertResourceResult>('POST', '/api/resources', item);
}

// ---------------------------------------------------------------------------
// Entities API
// ---------------------------------------------------------------------------

export interface SyncEntityItem {
  id: string;
  numericId?: string | null;
  entityType: string;
  title: string;
  description?: string | null;
  website?: string | null;
  tags?: string[] | null;
  clusters?: string[] | null;
  status?: string | null;
  lastUpdated?: string | null;
  customFields?: Array<{ label: string; value: string; link?: string }> | null;
  relatedEntries?: Array<{ id: string; type: string; relationship?: string }> | null;
  sources?: Array<{ title: string; url?: string; author?: string; date?: string }> | null;
}

interface SyncEntitiesResult {
  upserted: number;
}

export interface EntityEntry {
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

interface EntityListResult {
  entities: EntityEntry[];
  total: number;
  limit: number;
  offset: number;
}

interface EntitySearchResult {
  results: EntityEntry[];
  query: string;
  total: number;
}

interface EntityStatsResult {
  total: number;
  byType: Record<string, number>;
}

const ENTITY_BATCH_SIZE = 200;

/**
 * Sync entities to the wiki-server.
 * Splits into batches for large entity sets.
 */
export async function syncEntities(
  items: SyncEntityItem[],
): Promise<SyncEntitiesResult | null> {
  const serverUrl = getServerUrl();
  if (!serverUrl) return null;

  let totalUpserted = 0;

  for (let i = 0; i < items.length; i += ENTITY_BATCH_SIZE) {
    const batch = items.slice(i, i + ENTITY_BATCH_SIZE);

    try {
      const res = await fetch(`${serverUrl}/api/entities/sync`, {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify({ entities: batch }),
        signal: AbortSignal.timeout(BATCH_TIMEOUT_MS),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.warn(
          `  WARNING: Entity sync batch failed (${res.status}): ${text.slice(0, 200)}`,
        );
        return null;
      }

      const data = (await res.json()) as SyncEntitiesResult;
      totalUpserted += data.upserted;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`  WARNING: Entity sync batch failed: ${message}`);
      return null;
    }
  }

  return { upserted: totalUpserted };
}

/**
 * Get a single entity by ID (slug or numeric ID).
 */
export async function getEntity(
  id: string,
): Promise<EntityEntry | null> {
  return apiRequest<EntityEntry>('GET', `/api/entities/${encodeURIComponent(id)}`);
}

/**
 * List entities (paginated).
 */
export async function listEntities(
  limit = 50,
  offset = 0,
  entityType?: string,
): Promise<EntityListResult | null> {
  let path = `/api/entities?limit=${limit}&offset=${offset}`;
  if (entityType) path += `&entityType=${encodeURIComponent(entityType)}`;
  return apiRequest<EntityListResult>('GET', path);
}

/**
 * Search entities by title/description.
 */
export async function searchEntities(
  q: string,
  limit = 20,
): Promise<EntitySearchResult | null> {
  return apiRequest<EntitySearchResult>(
    'GET',
    `/api/entities/search?q=${encodeURIComponent(q)}&limit=${limit}`,
  );
}

/**
 * Get entity statistics.
 */
export async function getEntityStats(): Promise<EntityStatsResult | null> {
  return apiRequest<EntityStatsResult>('GET', '/api/entities/stats');
}

// ---------------------------------------------------------------------------
// Facts API
// ---------------------------------------------------------------------------

export interface SyncFactItem {
  entityId: string;
  factId: string;
  label?: string | null;
  value?: string | null;
  numeric?: number | null;
  low?: number | null;
  high?: number | null;
  asOf?: string | null;
  measure?: string | null;
  subject?: string | null;
  note?: string | null;
  source?: string | null;
  sourceResource?: string | null;
  format?: string | null;
  formatDivisor?: number | null;
}

interface SyncFactsResult {
  upserted: number;
}

export interface FactEntry {
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

interface FactsByEntityResult {
  entityId: string;
  facts: FactEntry[];
  total: number;
  limit: number;
  offset: number;
}

interface TimeseriesResult {
  entityId: string;
  measure: string;
  points: FactEntry[];
  total: number;
}

interface StaleFactsResult {
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

interface FactStatsResult {
  total: number;
  uniqueEntities: number;
  uniqueMeasures: number;
}

const FACT_BATCH_SIZE = 500;

/**
 * Sync facts to the wiki-server.
 * Splits into batches for large fact sets.
 */
export async function syncFacts(
  items: SyncFactItem[],
): Promise<SyncFactsResult | null> {
  const serverUrl = getServerUrl();
  if (!serverUrl) return null;

  let totalUpserted = 0;

  for (let i = 0; i < items.length; i += FACT_BATCH_SIZE) {
    const batch = items.slice(i, i + FACT_BATCH_SIZE);

    try {
      const res = await fetch(`${serverUrl}/api/facts/sync`, {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify({ facts: batch }),
        signal: AbortSignal.timeout(BATCH_TIMEOUT_MS),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.warn(
          `  WARNING: Facts sync batch failed (${res.status}): ${text.slice(0, 200)}`,
        );
        return null;
      }

      const data = (await res.json()) as SyncFactsResult;
      totalUpserted += data.upserted;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`  WARNING: Facts sync batch failed: ${message}`);
      return null;
    }
  }

  return { upserted: totalUpserted };
}

/**
 * Get all facts for a specific entity.
 */
export async function getFactsByEntity(
  entityId: string,
  limit = 100,
  offset = 0,
  measure?: string,
): Promise<FactsByEntityResult | null> {
  let path = `/api/facts/by-entity/${encodeURIComponent(entityId)}?limit=${limit}&offset=${offset}`;
  if (measure) path += `&measure=${encodeURIComponent(measure)}`;
  return apiRequest<FactsByEntityResult>('GET', path);
}

/**
 * Get timeseries data for an entity and measure.
 */
export async function getFactTimeseries(
  entityId: string,
  measure: string,
  limit = 100,
): Promise<TimeseriesResult | null> {
  return apiRequest<TimeseriesResult>(
    'GET',
    `/api/facts/timeseries/${encodeURIComponent(entityId)}?measure=${encodeURIComponent(measure)}&limit=${limit}`,
  );
}

/**
 * Get stale facts (oldest asOf dates).
 */
export async function getStaleFacts(
  olderThan?: string,
  limit = 50,
  offset = 0,
): Promise<StaleFactsResult | null> {
  let path = `/api/facts/stale?limit=${limit}&offset=${offset}`;
  if (olderThan) path += `&olderThan=${encodeURIComponent(olderThan)}`;
  return apiRequest<StaleFactsResult>('GET', path);
}

/**
 * Get fact statistics.
 */
export async function getFactStats(): Promise<FactStatsResult | null> {
  return apiRequest<FactStatsResult>('GET', '/api/facts/stats');
}
