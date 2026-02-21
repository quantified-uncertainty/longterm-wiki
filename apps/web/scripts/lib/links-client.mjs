/**
 * links-client.mjs — Thin wrapper re-exporting from the shared wiki-server client.
 *
 * Used by build-data.mjs to sync page links (backlinks, related-page signals)
 * to the wiki-server. Gracefully skips if server is unavailable.
 */

export { syncPageLinks } from '../../../../crux/lib/wiki-server-client.ts';
