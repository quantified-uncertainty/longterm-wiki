/**
 * Auto-Update System — Public API
 *
 * Re-exports from internal modules for use by CLI commands and workflows.
 */

export { fetchAllSources, loadSources, loadFetchTimes } from './feed-fetcher.ts';
export { buildDigest } from './digest.ts';
export { routeDigest } from './page-router.ts';
export { runPipeline } from './orchestrator.ts';
export type {
  NewsSource, SourcesConfig,
  FeedItem, DigestItem, NewsDigest,
  PageUpdate, NewPageSuggestion, UpdatePlan,
  RunReport, RunResult,
  AutoUpdateOptions,
} from './types.ts';
