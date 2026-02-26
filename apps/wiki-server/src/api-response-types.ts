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
import type { ClaimsRoute } from './routes/claims.js';
import type { CitationsRoute } from './routes/citations.js';
import type { SessionsRoute } from './routes/sessions.js';
import type { AgentSessionsRoute } from './routes/agent-sessions.js';
import type { ArtifactsRoute } from './routes/artifacts.js';
import type { AutoUpdateRunsRoute } from './routes/auto-update-runs.js';
import type { AutoUpdateNewsRoute } from './routes/auto-update-news.js';
import type { LinksRoute } from './routes/links.js';
import type { HallucinationRiskRoute } from './routes/hallucination-risk.js';

// ---------------------------------------------------------------------------
// RPC client phantom types (compile-time only)
// ---------------------------------------------------------------------------

type ClaimsRpc = ReturnType<typeof hc<ClaimsRoute>>;
type CitationsRpc = ReturnType<typeof hc<CitationsRoute>>;
type SessionsRpc = ReturnType<typeof hc<SessionsRoute>>;
type AgentSessionsRpc = ReturnType<typeof hc<AgentSessionsRoute>>;
type ArtifactsRpc = ReturnType<typeof hc<ArtifactsRoute>>;
type AutoUpdateRunsRpc = ReturnType<typeof hc<AutoUpdateRunsRoute>>;
type AutoUpdateNewsRpc = ReturnType<typeof hc<AutoUpdateNewsRoute>>;
type LinksRpc = ReturnType<typeof hc<LinksRoute>>;
type HallucinationRiskRpc = ReturnType<typeof hc<HallucinationRiskRoute>>;

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

/** Full claims-by-entity response. */
export type GetClaimsResult = InferResponseType<ClaimsRpc['by-entity'][':entityId']['$get'], 200>;

/** A single claim row from the by-entity endpoint. */
export type ClaimRow = GetClaimsResult['claims'][number];

/** Claim stats response. */
export type ClaimStatsResult = InferResponseType<ClaimsRpc['stats']['$get'], 200>;

/** A single claim source row. */
export type ClaimSourceRow = InferResponseType<ClaimsRpc[':id']['sources']['$get'], 200>['sources'][number];

/** Similar claims response from /:id/similar. */
export type SimilarClaimsResult = InferResponseType<ClaimsRpc[':id']['similar']['$get'], 200>;

/** A single similar claim item. */
export type SimilarClaimItem = SimilarClaimsResult['claims'][number];

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
