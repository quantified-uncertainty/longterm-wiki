/**
 * API Response Types — Inferred from Hono RPC route types.
 *
 * This file re-exports response types derived via InferResponseType<> from the
 * server route handlers, which are the single source of truth. These types are
 * consumed by the frontend (apps/web/) via the @wiki-server/api-response-types
 * path alias.
 *
 * Input types (Zod schemas, request body shapes) remain in api-types.ts.
 * Runtime constants (ACCURACY_VERDICTS, etc.) remain in api-types.ts.
 *
 * All imports here are type-only — zero runtime cost.
 */

import type { hc, InferResponseType } from 'hono/client';

// Route type imports
import type { CitationsRoute } from './routes/citations.js';
import type { SessionsRoute } from './routes/sessions.js';
import type { AgentSessionsRoute } from './routes/agent-sessions.js';
import type { ActiveAgentsRoute } from './routes/active-agents.js';
import type { AgentSessionEventsRoute } from './routes/agent-session-events.js';
import type { ArtifactsRoute } from './routes/artifacts.js';
import type { AutoUpdateRunsRoute } from './routes/auto-update-runs.js';
import type { AutoUpdateNewsRoute } from './routes/auto-update-news.js';
import type { LinksRoute } from './routes/links.js';
import type { HallucinationRiskRoute } from './routes/hallucination-risk.js';
import type { ExploreRoute } from './routes/explore.js';
import type { FactsRoute } from './routes/facts.js';
import type { EntitiesRoute } from './routes/entities.js';
import type { PagesRoute } from './routes/pages.js';
import type { GroundskeeperRunsRoute } from './routes/groundskeeper-runs.js';
import type { MonitoringRoute } from './routes/monitoring.js';
import type { GithubPullsRoute } from './routes/github-pulls.js';

// ---------------------------------------------------------------------------
// RPC client phantom types (compile-time only)
// ---------------------------------------------------------------------------

type CitationsRpc = ReturnType<typeof hc<CitationsRoute>>;
type SessionsRpc = ReturnType<typeof hc<SessionsRoute>>;
type AgentSessionsRpc = ReturnType<typeof hc<AgentSessionsRoute>>;
type ActiveAgentsRpc = ReturnType<typeof hc<ActiveAgentsRoute>>;
type AgentSessionEventsRpc = ReturnType<typeof hc<AgentSessionEventsRoute>>;
type ArtifactsRpc = ReturnType<typeof hc<ArtifactsRoute>>;
type AutoUpdateRunsRpc = ReturnType<typeof hc<AutoUpdateRunsRoute>>;
type AutoUpdateNewsRpc = ReturnType<typeof hc<AutoUpdateNewsRoute>>;
type LinksRpc = ReturnType<typeof hc<LinksRoute>>;
type HallucinationRiskRpc = ReturnType<typeof hc<HallucinationRiskRoute>>;
type ExploreRpc = ReturnType<typeof hc<ExploreRoute>>;
type FactsRpc = ReturnType<typeof hc<FactsRoute>>;
type EntitiesRpc = ReturnType<typeof hc<EntitiesRoute>>;
type PagesRpc = ReturnType<typeof hc<PagesRoute>>;
type GroundskeeperRunsRpc = ReturnType<typeof hc<GroundskeeperRunsRoute>>;
type MonitoringRpc = ReturnType<typeof hc<MonitoringRoute>>;
type GithubPullsRpc = ReturnType<typeof hc<GithubPullsRoute>>;

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

/** Citation health response for a page. */
export type CitationHealthResult = InferResponseType<CitationsRpc['health'][':pageId']['$get'], 200>;

/** Accuracy dashboard data. */
export type AccuracyDashboardData = InferResponseType<CitationsRpc['accuracy-dashboard']['$get'], 200>;

/** Citation content list response. */
export type CitationContentListResult = InferResponseType<CitationsRpc['content']['list']['$get'], 200>;

/** A single citation content list entry. */
export type CitationContentListEntry = CitationContentListResult['entries'][number];

/** Citation content stats response. */
export type CitationContentStatsResult = InferResponseType<CitationsRpc['content']['stats']['$get'], 200>;

/** Citation quotes for a page. */
export type CitationQuotesResult = InferResponseType<CitationsRpc['quotes']['$get'], 200>;

/** A single citation quote row (full DB shape). */
export type CitationQuoteDbRow = CitationQuotesResult['quotes'][number];

/** Citation quotes grouped by URL. */
export type CitationQuotesByUrlResult = InferResponseType<CitationsRpc['quotes-by-url']['$get'], 200>;

/** Single citation content record. */
export type CitationContentResult = InferResponseType<CitationsRpc['content']['$get'], 200>;

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** Session list response. */
type SessionListResult = InferResponseType<SessionsRpc['index']['$get'], 200>;

/** A single session row. */
export type SessionRow = SessionListResult['sessions'][number];

// ---------------------------------------------------------------------------
// Agent Sessions
// ---------------------------------------------------------------------------

/** A single agent session row. */
export type AgentSessionRow = InferResponseType<AgentSessionsRpc['by-branch'][':branch']['$get'], 200>;

// ---------------------------------------------------------------------------
// Active Agents
// ---------------------------------------------------------------------------

/** Active agents list response. */
type ActiveAgentsListResult = InferResponseType<ActiveAgentsRpc['index']['$get'], 200>;

/** A single active agent row. */
export type ActiveAgentRow = ActiveAgentsListResult['agents'][number];

/** Conflict warning from the active agents list. */
export type ActiveAgentConflict = ActiveAgentsListResult['conflicts'][number];

// ---------------------------------------------------------------------------
// Agent Session Events
// ---------------------------------------------------------------------------

/** Agent session events list response. */
type AgentSessionEventsListResult = InferResponseType<AgentSessionEventsRpc['by-agent'][':agentId']['$get'], 200>;

/** A single agent session event row. */
export type AgentSessionEventRow = AgentSessionEventsListResult['events'][number];

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

/** A single artifact row (from by-ID endpoint). */
export type ArtifactRow = InferResponseType<ArtifactsRpc[':id']['$get'], 200>;

// ---------------------------------------------------------------------------
// Auto-Update
// ---------------------------------------------------------------------------

/** Auto-update runs list response. */
type AutoUpdateRunsListResult = InferResponseType<AutoUpdateRunsRpc['all']['$get'], 200>;

/** A single auto-update run row. */
export type AutoUpdateRunRow = AutoUpdateRunsListResult['entries'][number];

/** Auto-update news dashboard response. */
type AutoUpdateNewsDashboardResult = InferResponseType<AutoUpdateNewsRpc['dashboard']['$get'], 200>;

/** A single auto-update news row. */
export type AutoUpdateNewsRow = AutoUpdateNewsDashboardResult['items'][number];

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/** Backlinks response. */
type BacklinksResult = InferResponseType<LinksRpc['backlinks'][':id']['$get'], 200>;

/** A single backlink entry. */
export type BacklinkEntry = BacklinksResult['backlinks'][number];

/** Related pages response. */
type RelatedPagesResult = InferResponseType<LinksRpc['related'][':id']['$get'], 200>;

/** A single related entry. */
export type RelatedEntry = RelatedPagesResult['related'][number];

// ---------------------------------------------------------------------------
// Hallucination Risk
// ---------------------------------------------------------------------------

/** Hallucination risk latest response. */
type RiskLatestResult = InferResponseType<HallucinationRiskRpc['latest']['$get'], 200>;

/** A single risk page row. */
export type RiskPageRow = RiskLatestResult['pages'][number];

// ---------------------------------------------------------------------------
// Explore
// ---------------------------------------------------------------------------

/** Explore page response. */
export type ExploreResult = InferResponseType<ExploreRpc['index']['$get'], 200>;

/** A single explore item. */
export type ExploreItem = ExploreResult['items'][number];

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

/** Facts by entity response. */
export type FactsByEntityResult = InferResponseType<FactsRpc['by-entity'][':entityId']['$get'], 200>;

/** A single fact entry. */
export type FactEntry = FactsByEntityResult['facts'][number];

/** Facts stats response. */
export type FactsStatsResult = InferResponseType<FactsRpc['stats']['$get'], 200>;

/** Facts timeseries response. */
export type FactsTimeseriesResult = InferResponseType<FactsRpc['timeseries'][':entityId']['$get'], 200>;

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/** Entity search response. */
export type EntitySearchResult = InferResponseType<EntitiesRpc['search']['$get'], 200>;

/** A single entity search row. */
export type EntitySearchRow = EntitySearchResult['results'][number];

/** Entity detail response. */
export type EntityDetailResult = InferResponseType<EntitiesRpc[':id']['$get'], 200>;

/** Entities stats response. */
export type EntitiesStatsResult = InferResponseType<EntitiesRpc['stats']['$get'], 200>;

/** Entity list response. */
export type EntityListResult = InferResponseType<EntitiesRpc['index']['$get'], 200>;

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/** Page search response. */
export type PageSearchResult = InferResponseType<PagesRpc['search']['$get'], 200>;

/** A single page search row. */
export type PageSearchRow = PageSearchResult['results'][number];

/** Page detail response. */
export type PageDetailResult = InferResponseType<PagesRpc[':id']['$get'], 200>;

/** Page list response. */
export type PageListResult = InferResponseType<PagesRpc['index']['$get'], 200>;

// ---------------------------------------------------------------------------
// Groundskeeper Runs
// ---------------------------------------------------------------------------

/** Groundskeeper runs list response. */
type GroundskeeperRunsListResult = InferResponseType<GroundskeeperRunsRpc['index']['$get'], 200>;

/** A single groundskeeper run row. */
export type GroundskeeperRunRow = GroundskeeperRunsListResult['runs'][number];

/** Groundskeeper stats response. */
export type GroundskeeperStatsResult = InferResponseType<GroundskeeperRunsRpc['stats']['$get'], 200>;

// ---------------------------------------------------------------------------
// Monitoring / System Health
// ---------------------------------------------------------------------------

/** Aggregated system health status response. */
export type MonitoringStatusResult = InferResponseType<MonitoringRpc['status']['$get'], 200>;

/** Service status entry from the status endpoint. */
export type ServiceStatusEntry = MonitoringStatusResult['services'][number];

/** Recent incident from the status endpoint. */
export type RecentIncident = MonitoringStatusResult['recentIncidents'][number];

/** Incidents list response. */
export type MonitoringIncidentsResult = InferResponseType<MonitoringRpc['incidents']['$get'], 200>;

/** A single incident row from the incidents list. */
export type IncidentRow = MonitoringIncidentsResult['incidents'][number];

// ---------------------------------------------------------------------------
// GitHub Pull Requests
// ---------------------------------------------------------------------------

/** Open pull requests response. */
export type GithubPullsResult = InferResponseType<GithubPullsRpc['index']['$get'], 200>;

/** A single open PR entry. */
export type OpenPRRow = GithubPullsResult['pulls'][number];
