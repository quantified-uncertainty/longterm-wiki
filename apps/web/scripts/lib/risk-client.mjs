/**
 * risk-client.mjs — Thin wrapper re-exporting from the shared wiki-server client.
 *
 * Used by build-data.mjs to record risk score snapshots after computing
 * hallucination risk. Gracefully skips if server is unavailable.
 */

export { recordRiskSnapshots } from '../../../../crux/lib/wiki-server-client.ts';
