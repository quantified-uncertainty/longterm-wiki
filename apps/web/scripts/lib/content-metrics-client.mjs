/**
 * content-metrics-client.mjs — Thin wrapper re-exporting from the shared wiki-server client.
 *
 * Used by build-data.mjs to sync content metrics (coverage, schedule, structural,
 * similarity) to the wiki-server after computing them. Gracefully skips if server
 * is unavailable.
 *
 * Part of the PG-First Migration (Epic #2428, Issue #2434).
 */

export { syncContentMetrics, syncSimilarity } from '../../../../crux/lib/wiki-server-client.ts';
