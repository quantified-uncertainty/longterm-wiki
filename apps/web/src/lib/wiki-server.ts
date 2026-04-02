/**
 * Shared utilities for fetching data from the wiki-server API
 * with automatic fallback to local data sources (YAML, database.json).
 *
 * Used by internal dashboard pages that display data from either
 * the wiki-server PostgreSQL database or local files.
 */

export type DataSource = "api" | "local";

export type ApiErrorReason =
  | { type: "not-configured" }
  | { type: "connection-error"; message: string }
  | { type: "server-error"; status: number; statusText: string };

export type FetchResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ApiErrorReason };

export interface WithSource<T> {
  data: T;
  source: DataSource;
  apiError?: ApiErrorReason;
}

/**
 * Fetch JSON from the wiki-server API with detailed error information.
 * Returns a discriminated union so callers can distinguish between
 * "not configured", "connection failed", and "server error".
 */
export async function fetchDetailed<T>(
  path: string,
  options?: { revalidate?: number; timeoutMs?: number }
): Promise<FetchResult<T>> {
  const config = getWikiServerConfig();
  if (!config) return { ok: false, error: { type: "not-configured" } };

  try {
    const res = await fetch(`${config.serverUrl}${path}`, {
      headers: config.headers,
      next: { revalidate: options?.revalidate ?? 300 },
      signal: AbortSignal.timeout(options?.timeoutMs ?? 10_000),
    });
    if (!res.ok) {
      return {
        ok: false,
        error: {
          type: "server-error",
          status: res.status,
          statusText: res.statusText,
        },
      };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch (err) {
    return {
      ok: false,
      error: {
        type: "connection-error",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * Fetch JSON from the wiki-server API.
 * Returns null if the server URL is not configured or the request fails.
 */
export async function fetchFromWikiServer<T>(
  path: string,
  options?: { revalidate?: number; timeoutMs?: number }
): Promise<T | null> {
  const result = await fetchDetailed<T>(path, options);
  return result.ok ? result.data : null;
}

/**
 * Environment prefix for wiki-server env vars.
 *
 * Set `WIKI_SERVER_ENV=prod` to read from `PROD_LONGTERMWIKI_*` env vars
 * instead of the default `LONGTERMWIKI_*`. Mirrors the same logic in
 * `crux/lib/wiki-server/client.ts`.
 */
function getEnvPrefix(): string {
  const env = process.env.WIKI_SERVER_ENV;
  if (env === "prod" || env === "production") return "PROD_";
  return "";
}

/** Returns the wiki-server base URL, respecting WIKI_SERVER_ENV prefix. */
export function getWikiServerUrl(): string {
  const prefix = getEnvPrefix();
  return process.env[`${prefix}LONGTERMWIKI_SERVER_URL`] || "";
}

/** Returns the wiki-server API key, respecting WIKI_SERVER_ENV prefix. */
export function getWikiServerApiKey(): string {
  const prefix = getEnvPrefix();
  return process.env[`${prefix}LONGTERMWIKI_SERVER_API_KEY`] || "";
}

/**
 * Returns the wiki-server URL and auth headers.
 * Used by internal dashboards and claims pages that need live data.
 * Returns null if the server URL is not configured.
 *
 * Content pages (wiki articles) always read from local database.json
 * and never call this function. Only dashboards and claims pages
 * make runtime API calls.
 */
export function getWikiServerConfig(): {
  serverUrl: string;
  headers: Record<string, string>;
} | null {
  const serverUrl = getWikiServerUrl();
  if (!serverUrl) return null;

  const headers: Record<string, string> = {};
  const apiKey = getWikiServerApiKey();
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  return { serverUrl, headers };
}

/**
 * Try loading data from the wiki-server API, falling back to a local loader.
 * Returns the data along with its source ("api" or "local").
 *
 * The apiLoader can return either:
 * - `FetchResult<T>` (error-aware) — apiError is threaded through
 * - `T | null` (legacy) — no error detail available
 */
export async function withApiFallback<T>(
  apiLoader: () => Promise<FetchResult<T> | T | null>,
  localLoader: () => T
): Promise<WithSource<T>>;
export async function withApiFallback<T>(
  apiLoader: () => Promise<FetchResult<T> | T | null>,
  localLoader: () => T | null
): Promise<WithSource<T | null>>;
export async function withApiFallback<T>(
  apiLoader: () => Promise<FetchResult<T> | T | null>,
  localLoader: () => T | null
): Promise<WithSource<T | null>> {
  const result = await apiLoader();

  // Error-aware FetchResult path
  if (result !== null && typeof result === "object" && "ok" in result) {
    const fetchResult = result as FetchResult<T>;
    if (fetchResult.ok) {
      return { data: fetchResult.data, source: "api" };
    }
    return { data: localLoader(), source: "local", apiError: fetchResult.error };
  }

  // Legacy path: T | null
  if (result !== null) {
    return { data: result as T, source: "api" };
  }
  return { data: localLoader(), source: "local" };
}

/** Human-readable label for the data source, for dashboard footers. */
export function dataSourceLabel(source: DataSource): string {
  return source === "api" ? "wiki-server API" : "local files";
}

// ============================================================================
// Hono RPC client — typed facts API (pilot)
// ============================================================================

import { hc, type InferResponseType } from "hono/client";
import type { FactsRoute } from "@wiki-server/facts-route";
import type { SourceChecksRoute } from "@wiki-server/source-checks-route";
import type { GrantsRoute } from "@wiki-server/grants-route";
import type { DivisionsRoute } from "@wiki-server/divisions-route";
import type { FundingProgramsRoute } from "@wiki-server/funding-programs-route";
import type { PersonnelRoute } from "@wiki-server/personnel-route";
import type { PredictionMarketsRoute } from "@wiki-server/prediction-markets-route";
import type { SecondaryMarketPricesRoute } from "@wiki-server/secondary-market-prices-route";
import type { DataQualityRoute } from "@wiki-server/data-quality-route";
import type { TalentFlowsRoute } from "@wiki-server/talent-flows-route";
import type { JobsRoute } from "@wiki-server/jobs-route";
import type { DataSourcesRoute } from "@wiki-server/data-sources-route";

/**
 * Create a typed Hono RPC client for the facts API.
 *
 * Supports Next.js ISR via a custom fetch wrapper that injects
 * `{ next: { revalidate } }` into every request.
 *
 * Returns null if the server URL is not configured.
 */
export function getFactsRpcClient(options?: { revalidate?: number }) {
  const config = getWikiServerConfig();
  if (!config) return null;

  const revalidate = options?.revalidate ?? 300;

  // Custom fetch that adds ISR revalidation and timeout
  const isrFetch: typeof globalThis.fetch = (input, init) => {
    return globalThis.fetch(input, {
      ...init,
      next: { revalidate },
      signal: init?.signal ?? AbortSignal.timeout(10_000),
    } as RequestInit);
  };

  return hc<FactsRoute>(`${config.serverUrl}/api/facts`, {
    headers: config.headers,
    fetch: isrFetch,
  });
}

// Typed response types for the facts API (inferred from server route)
type FactsClient = NonNullable<ReturnType<typeof getFactsRpcClient>>;

/** Inferred response type for GET /api/facts/by-entity/:entityId */
export type RpcFactsByEntityResult = InferResponseType<FactsClient['by-entity'][':entityId']['$get'], 200>;

/** Inferred response type for GET /api/facts/timeseries/:entityId */
export type RpcTimeseriesResult = InferResponseType<FactsClient['timeseries'][':entityId']['$get'], 200>;

// ============================================================================
// Hono RPC client — Unified Source-Checks API
// ============================================================================

type SourceChecksClient = ReturnType<typeof hc<SourceChecksRoute>>;

/** Inferred response type for GET /api/source-checks/stats */
export type RpcSourceChecksStatsResult = InferResponseType<SourceChecksClient['stats']['$get'], 200>;

/** Inferred response type for GET /api/source-checks/verdicts */
export type RpcSourceChecksVerdictsResult = InferResponseType<SourceChecksClient['verdicts']['$get'], 200>;

/** A single verdict row from the verdicts list */
export type RpcSourceCheckVerdictRow = RpcSourceChecksVerdictsResult['verdicts'][number];

/** Inferred response type for GET /api/source-checks/verdicts/:recordType/:recordId */
export type RpcSourceCheckDetailResult = InferResponseType<SourceChecksClient['verdicts'][':recordType'][':recordId']['$get'], 200>;

/** Inferred response type for GET /api/source-checks/resolve-names */
export type RpcSourceChecksResolveNamesResult = InferResponseType<SourceChecksClient['resolve-names']['$get'], 200>;

// ============================================================================
// Hono RPC client — Grants API
// ============================================================================

type GrantsClient = ReturnType<typeof hc<GrantsRoute>>;

/** Inferred response type for GET /api/grants/stats */
export type RpcGrantsStatsResult = InferResponseType<GrantsClient['stats']['$get'], 200>;

/** Inferred response type for GET /api/grants/all */
export type RpcGrantsAllResult = InferResponseType<GrantsClient['all']['$get'], 200>;

/** A single grant row from the all-grants list */
export type RpcGrantRow = RpcGrantsAllResult['grants'][number];

/** Inferred response type for GET /api/grants/by-entity/:entityId */
export type RpcGrantsByEntityResult = InferResponseType<GrantsClient['by-entity'][':entityId']['$get'], 200>;

/** A single grant row from the by-entity endpoint */
export type RpcGrantsByEntityRow = RpcGrantsByEntityResult['grants'][number];

/** Inferred response type for GET /api/grants/by-org-summary */
export type RpcGrantsOrgSummaryResult = InferResponseType<GrantsClient['by-org-summary']['$get'], 200>;

/** Inferred response type for GET /api/grants/by-grantee-summary */
export type RpcGrantsGranteeSummaryResult = InferResponseType<GrantsClient['by-grantee-summary']['$get'], 200>;

// ============================================================================
// Hono RPC client — Divisions API
// ============================================================================

type DivisionsClient = ReturnType<typeof hc<DivisionsRoute>>;

/** Inferred response type for GET /api/divisions/stats */
export type RpcDivisionsStatsResult = InferResponseType<DivisionsClient['stats']['$get'], 200>;

/** Inferred response type for GET /api/divisions/all */
export type RpcDivisionsAllResult = InferResponseType<DivisionsClient['all']['$get'], 200>;

/** A single division row from the all-divisions list */
export type RpcDivisionRow = RpcDivisionsAllResult['divisions'][number];

// ============================================================================
// Hono RPC client — Funding Programs API
// ============================================================================

type FundingProgramsClient = ReturnType<typeof hc<FundingProgramsRoute>>;

/** Inferred response type for GET /api/funding-programs/stats */
export type RpcFundingProgramsStatsResult = InferResponseType<FundingProgramsClient['stats']['$get'], 200>;

/** Inferred response type for GET /api/funding-programs/all */
export type RpcFundingProgramsAllResult = InferResponseType<FundingProgramsClient['all']['$get'], 200>;

/** A single funding program row from the all-programs list */
export type RpcFundingProgramRow = RpcFundingProgramsAllResult['fundingPrograms'][number];

// ============================================================================
// Hono RPC client — Personnel API
// ============================================================================

/**
 * Create a typed Hono RPC client for the personnel API.
 * Returns null if the wiki-server URL is not configured.
 */
export function getPersonnelRpcClient(options?: { revalidate?: number }) {
  const config = getWikiServerConfig();
  if (!config) return null;

  const revalidate = options?.revalidate ?? 300;

  const isrFetch: typeof globalThis.fetch = (input, init) => {
    return globalThis.fetch(input, {
      ...init,
      next: { revalidate },
      signal: init?.signal ?? AbortSignal.timeout(10_000),
    } as RequestInit);
  };

  return hc<PersonnelRoute>(`${config.serverUrl}/api/personnel`, {
    headers: config.headers,
    fetch: isrFetch,
  });
}

type PersonnelClient = NonNullable<ReturnType<typeof getPersonnelRpcClient>>;

/** Inferred response type for GET /api/personnel/by-entity/:entityId */
export type RpcPersonnelByEntityResult = InferResponseType<PersonnelClient['by-entity'][':entityId']['$get'], 200>;

/** A single personnel row from the by-entity endpoint */
export type RpcPersonnelRow = RpcPersonnelByEntityResult['personnel'][number];

// ============================================================================
// Hono RPC client — Prediction Markets API
// ============================================================================

type PredictionMarketsClient = ReturnType<typeof hc<PredictionMarketsRoute>>;

/** Inferred response type for GET /api/prediction-markets/questions/by-entity/:entityId */
export type RpcPredictionQuestionsByEntityResult = InferResponseType<PredictionMarketsClient['questions']['by-entity'][':entityId']['$get'], 200>;

/** A single prediction market question row */
export type RpcPredictionQuestion = RpcPredictionQuestionsByEntityResult['questions'][number];

/** Inferred response type for GET /api/prediction-markets/snapshots/timeseries/:questionId */
export type RpcPredictionSnapshotsTimeseriesResult = InferResponseType<PredictionMarketsClient['snapshots']['timeseries'][':questionId']['$get'], 200>;

// ============================================================================
// Hono RPC client — Secondary Market Prices API
// ============================================================================

type SecondaryMarketPricesClient = ReturnType<typeof hc<SecondaryMarketPricesRoute>>;

/** Inferred response type for GET /api/secondary-market-prices/latest/:entityId */
export type RpcSecondaryMarketLatestResult = InferResponseType<SecondaryMarketPricesClient['latest'][':entityId']['$get'], 200>;

/** Inferred response type for GET /api/secondary-market-prices/timeseries/:entityId */
export type RpcSecondaryMarketTimeseriesResult = InferResponseType<SecondaryMarketPricesClient['timeseries'][':entityId']['$get'], 200>;

// ============================================================================
// Hono RPC client — Data Quality Snapshots API
// ============================================================================

/**
 * Create a typed Hono RPC client for the data quality snapshots API.
 * Returns null if the wiki-server URL is not configured.
 */
export function getDataQualityRpcClient(options?: { revalidate?: number }) {
  const config = getWikiServerConfig();
  if (!config) return null;

  const revalidate = options?.revalidate ?? 300;

  const isrFetch: typeof globalThis.fetch = (input, init) => {
    return globalThis.fetch(input, {
      ...init,
      next: { revalidate },
      signal: init?.signal ?? AbortSignal.timeout(10_000),
    } as RequestInit);
  };

  return hc<DataQualityRoute>(`${config.serverUrl}/api/data-quality`, {
    headers: config.headers,
    fetch: isrFetch,
  });
}

type DataQualityClient = NonNullable<ReturnType<typeof getDataQualityRpcClient>>;

/** Inferred response type for GET /api/data-quality/latest */
export type RpcDataQualityLatestResult = InferResponseType<DataQualityClient['latest']['$get'], 200>;

/** Inferred response type for GET /api/data-quality/history */
export type RpcDataQualityHistoryResult = InferResponseType<DataQualityClient['history']['$get'], 200>;

/** A single data quality snapshot row */
export type RpcDataQualitySnapshot = NonNullable<RpcDataQualityLatestResult['snapshot']>;

// ============================================================================
// Hono RPC client — Talent Flows API
// ============================================================================

type TalentFlowsClient = ReturnType<typeof hc<TalentFlowsRoute>>;

/** Inferred response type for GET /api/talent-flows/ */
export type RpcTalentFlowsResult = InferResponseType<TalentFlowsClient['index']['$get'], 200>;

/** A single flow edge (org A -> org B) */
export type RpcTalentFlowEdge = RpcTalentFlowsResult['flows'][number];

/** A single org net-flow row */
export type RpcOrgNetFlow = RpcTalentFlowsResult['orgNetFlows'][number];

// ============================================================================
// Hono RPC client — Jobs API
// ============================================================================

type JobsClient = ReturnType<typeof hc<JobsRoute>>;

/** Inferred response type for GET /api/jobs/stats */
export type RpcJobsStatsResult = InferResponseType<JobsClient['stats']['$get'], 200>;

/** Inferred response type for GET /api/jobs/ (list) */
export type RpcJobsListResult = InferResponseType<JobsClient['index']['$get'], 200>;

/** A single job entry from the list endpoint */
export type RpcJobEntry = RpcJobsListResult['entries'][number];

// ============================================================================
// Hono RPC client — Data Sources API
// ============================================================================

/**
 * Create a typed Hono RPC client for the data sources API.
 * Returns null if the wiki-server URL is not configured.
 */
export function getDataSourcesRpcClient(options?: { revalidate?: number }) {
  const config = getWikiServerConfig();
  if (!config) return null;

  const revalidate = options?.revalidate ?? 60;

  const isrFetch: typeof globalThis.fetch = (input, init) => {
    return globalThis.fetch(input, {
      ...init,
      next: { revalidate },
      signal: init?.signal ?? AbortSignal.timeout(10_000),
    } as RequestInit);
  };

  return hc<DataSourcesRoute>(`${config.serverUrl}/api/data-sources`, {
    headers: config.headers,
    fetch: isrFetch,
  });
}

type DataSourcesClient = NonNullable<ReturnType<typeof getDataSourcesRpcClient>>;

/** Inferred response type for GET /api/data-sources/ (list all) */
export type RpcDataSourceListResult = InferResponseType<DataSourcesClient['index']['$get'], 200>;

/** A single data source from the list endpoint */
export type RpcDataSource = RpcDataSourceListResult['dataSources'][number];

/** Inferred response type for GET /api/data-sources/:id (used by detail page — PR 2) */
export type RpcDataSourceDetailResult = InferResponseType<DataSourcesClient[':id']['$get'], 200>;

/** Inferred response type for GET /api/data-sources/:id/snapshots (used by detail page — PR 2) */
export type RpcSnapshotListResult = InferResponseType<DataSourcesClient[':id']['snapshots']['$get'], 200>;

