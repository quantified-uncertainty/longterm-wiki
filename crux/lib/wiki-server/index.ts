/**
 * Wiki Server Client — barrel re-export for backward compatibility
 *
 * This index re-exports the old `T | null` API from the split modules so that
 * existing `import { ... } from './wiki-server-client.ts'` statements keep
 * working without changes. New code should import from the specific sub-module
 * (e.g. `./wiki-server/edit-logs.ts`) and use the `ApiResult<T>` return type.
 *
 * The _compat wrappers call `unwrap()` on the new typed results, preserving
 * the original behavior of returning `null` on any failure.
 *
 * ## Migration note (tech-debt #540)
 *
 * The _compat wrappers in this barrel are slated for removal once all call
 * sites are updated to use the `ApiResult<T>`-returning functions directly.
 * Until then they remain exported here under their original names so existing
 * callers do not need to change import paths.
 *
 * Migration steps for any _compat function:
 *   1. Import the typed function from its sub-module instead of this barrel.
 *   2. Unwrap the result explicitly: check `result.ok` rather than `!= null`.
 *   3. Delete the corresponding `_compat` wrapper and its re-export here.
 */

// ---------------------------------------------------------------------------
// Core client — always re-exported directly (no compat needed)
// ---------------------------------------------------------------------------

export { getServerUrl, getApiKey, buildHeaders, isServerAvailable } from './client.ts';
export type { ApiResult, ApiError } from './client.ts';
export { apiOk, apiErr, unwrap } from './client.ts';

// ---------------------------------------------------------------------------
// Types — re-export all public types from each module
// ---------------------------------------------------------------------------

export type { EditLogApiEntry } from './edit-logs.ts';
export type { UpsertCitationQuoteItem, AccuracyVerdict, MarkAccuracyItem, AccuracyDashboardData } from './citations.ts';
export type { SessionApiEntry, SessionEntry } from './sessions.ts';
export type {
  AutoUpdateRunResultEntry,
  RecordAutoUpdateRunInput,
  AutoUpdateRunEntry,
  AutoUpdateNewsItem,
  AutoUpdateNewsItemEntry,
} from './auto-update.ts';
export type { RiskSnapshot } from './risk.ts';
export type { UpsertSummaryItem } from './summaries.ts';
export type { InsertClaimItem } from './claims.ts';
export type { PageLinkItem } from './links.ts';
export type { UpsertResourceItem } from './resources.ts';
export type { SyncEntityItem, EntityEntry } from './entities.ts';
export type { SyncFactItem, FactEntry } from './facts.ts';

// ---------------------------------------------------------------------------
// Backward-compatible function re-exports (T | null return type)
//
// These use the _compat wrappers which call unwrap() internally.
// ---------------------------------------------------------------------------

// Edit Logs
export {
  appendEditLogToServer_compat as appendEditLogToServer,
  appendEditLogBatch_compat as appendEditLogBatch,
  getEditLogsForPage_compat as getEditLogsForPage,
  getEditLogStats_compat as getEditLogStats,
} from './edit-logs.ts';

// Citations
export {
  upsertCitationQuote_compat as upsertCitationQuote,
  upsertCitationQuoteBatch_compat as upsertCitationQuoteBatch,
  markCitationAccuracy_compat as markCitationAccuracy,
  markCitationAccuracyBatch_compat as markCitationAccuracyBatch,
  createAccuracySnapshot_compat as createAccuracySnapshot,
  getAccuracyDashboard_compat as getAccuracyDashboard,
} from './citations.ts';

// Sessions
export {
  createSession_compat as createSession,
  createSessionBatch_compat as createSessionBatch,
  listSessions_compat as listSessions,
  getSessionsByPage_compat as getSessionsByPage,
  getSessionStats_compat as getSessionStats,
  getSessionPageChanges_compat as getSessionPageChanges,
} from './sessions.ts';

// Auto-Update
export {
  recordAutoUpdateRun_compat as recordAutoUpdateRun,
  getAutoUpdateRuns_compat as getAutoUpdateRuns,
  getAutoUpdateStats_compat as getAutoUpdateStats,
  insertAutoUpdateNewsItems_compat as insertAutoUpdateNewsItems,
} from './auto-update.ts';

// Hallucination Risk
export { recordRiskSnapshots_compat as recordRiskSnapshots } from './risk.ts';

// Summaries
export {
  upsertSummary_compat as upsertSummary,
  upsertSummaryBatch_compat as upsertSummaryBatch,
} from './summaries.ts';

// Claims
export {
  insertClaim_compat as insertClaim,
  insertClaimBatch_compat as insertClaimBatch,
  clearClaimsForEntity_compat as clearClaimsForEntity,
} from './claims.ts';

// Page Links
export { syncPageLinks_compat as syncPageLinks } from './links.ts';

// Entities
export {
  syncEntities_compat as syncEntities,
  getEntity_compat as getEntity,
  listEntities_compat as listEntities,
  searchEntities_compat as searchEntities,
  getEntityStats_compat as getEntityStats,
} from './entities.ts';

// Facts
export {
  syncFacts_compat as syncFacts,
  getFactsByEntity_compat as getFactsByEntity,
  getFactTimeseries_compat as getFactTimeseries,
  getStaleFacts_compat as getStaleFacts,
  getFactStats_compat as getFactStats,
} from './facts.ts';
