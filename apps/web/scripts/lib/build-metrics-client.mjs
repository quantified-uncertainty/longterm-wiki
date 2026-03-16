/**
 * build-metrics-client.mjs — Thin wrapper re-exporting from the shared wiki-server client.
 *
 * Used by build-data.mjs to sync coverage, rankings, schedule, and similarity
 * data to the wiki-server. Gracefully skips if server is unavailable.
 */

export {
  syncCoverage,
  syncSchedule,
  syncRankings,
  syncSimilarity,
} from '../../../../crux/lib/wiki-server-client.ts';
