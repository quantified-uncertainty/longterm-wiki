/**
 * Wiki Server Client — barrel re-export
 *
 * Re-exports all public API functions and types from the split modules.
 * All functions return `ApiResult<T>` with typed error handling.
 *
 * For targeted imports, prefer importing from the specific sub-module:
 *   import { appendEditLogToServer } from './wiki-server/edit-logs.ts';
 */

// ---------------------------------------------------------------------------
// Core client
// ---------------------------------------------------------------------------

export { getServerUrl, getApiKey, buildHeaders, isServerAvailable } from './client.ts';
export type { ApiResult, ApiError, ApiKeyScope } from './client.ts';
export { apiOk, apiErr, unwrap } from './client.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { EditLogApiEntry } from './edit-logs.ts';
export type { UpsertCitationQuoteItem, AccuracyVerdict, MarkAccuracyItem, AccuracyDashboardData } from './citations.ts';
export type { SessionApiEntry, SessionEntry, SessionPageChangesResult } from './sessions.ts';
export type {
  AutoUpdateRunResultEntry,
  RecordAutoUpdateRunInput,
  AutoUpdateRunEntry,
  AutoUpdateNewsItem,
  AutoUpdateNewsItemEntry,
} from './auto-update.ts';
export type { RiskSnapshot, RiskLatestResult } from './risk.ts';
export type { UpsertSummaryItem } from './summaries.ts';
export type { PageLinkItem } from './links.ts';
export type {
  PageSearchResult,
  PageDetail,
  RelatedResult,
  BacklinksResult,
  CitationQuote,
  CitationQuotesResult,
} from './pages.ts';
export type { UpsertResourceItem } from './resources.ts';
export type { SyncEntityItem, EntityEntry } from './entities.ts';
export type { SyncFactItem, FactEntry } from './facts.ts';
export type { AgentSessionEntry } from './agent-sessions.ts';
export type {
  JobEntry,
  CreateJobInput,
  ListJobsResult,
  ClaimResult,
  JobStatsResult,
  SweepResult,
} from './jobs.ts';
export type {
  SaveArtifactsInput,
  ArtifactEntry,
  ArtifactStatsResult,
} from './artifacts.ts';

// ---------------------------------------------------------------------------
// API functions (all return ApiResult<T>)
// ---------------------------------------------------------------------------

// Edit Logs
export {
  appendEditLogToServer,
  appendEditLogBatch,
  getEditLogsForPage,
  getEditLogStats,
  getEditLogLatestDates,
} from './edit-logs.ts';

// Citations
export {
  upsertCitationQuote,
  upsertCitationQuoteBatch,
  markCitationAccuracy,
  markCitationAccuracyBatch,
  createAccuracySnapshot,
  getAccuracyDashboard,
} from './citations.ts';

// Sessions
export {
  createSession,
  createSessionBatch,
  listSessions,
  getSessionsByPage,
  getSessionStats,
  getSessionPageChanges,
} from './sessions.ts';

// Auto-Update
export {
  recordAutoUpdateRun,
  getAutoUpdateRuns,
  getAutoUpdateStats,
  insertAutoUpdateNewsItems,
  getAutoUpdateNewsDashboard,
} from './auto-update.ts';

// Hallucination Risk
export { recordRiskSnapshots } from './risk.ts';

// Summaries
export {
  upsertSummary,
  upsertSummaryBatch,
} from './summaries.ts';

// Page Links
export { syncPageLinks } from './links.ts';

// Pages
export {
  searchPages,
  getPage,
  getRelatedPages,
  getBacklinks,
  getCitationQuotes,
} from './pages.ts';

// Resources
export { upsertResource } from './resources.ts';

// References
export {
  getPageReferences,
  createClaimReference,
  createCitation,
  createCitationsBatch,
} from './references.ts';
export type {
  GetPageReferencesResult,
  ClaimPageReferenceRow,
  PageCitationRow,
} from './references.ts';


// Entities
export {
  syncEntities,
  getEntity,
  listEntities,
  searchEntities,
  getEntityStats,
} from './entities.ts';

// Facts
export {
  syncFacts,
  getFactsByEntity,
  getFactTimeseries,
  getStaleFacts,
  getFactStats,
} from './facts.ts';

// Agent Sessions
export {
  upsertAgentSession,
  getAgentSessionByBranch,
  updateAgentSession,
  listAgentSessions,
} from './agent-sessions.ts';

// Jobs
export {
  createJob,
  createJobBatch,
  listJobs,
  getJob,
  claimJob,
  startJob,
  completeJob,
  failJob,
  cancelJob,
  getJobStats,
  sweepJobs,
} from './jobs.ts';

// Artifacts
export {
  saveArtifacts,
  getArtifactsByPage,
  getArtifacts,
  getArtifact,
  getArtifactStats,
} from './artifacts.ts';

// Entity IDs
export {
  allocateId,
  allocateBatch,
  allocateIds,
  getIdBySlug,
  listIds,
  isConfigured as isIdServerConfigured,
} from './ids.ts';
export type { AllocatedId, IdListResult } from './ids.ts';