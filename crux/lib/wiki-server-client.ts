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

function getServerUrl(): string {
  return process.env.LONGTERMWIKI_SERVER_URL || '';
}

function getApiKey(): string {
  return process.env.LONGTERMWIKI_SERVER_API_KEY || '';
}

function buildHeaders(): Record<string, string> {
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
