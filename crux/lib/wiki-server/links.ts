/**
 * Page Links API — wiki-server client module
 */

import { batchedRequest, getServerUrl, unwrap, type ApiResult } from './client.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PageLinkItem {
  sourceId: string;
  targetId: string;
  linkType: 'yaml_related' | 'entity_link' | 'name_prefix' | 'similarity' | 'shared_tag';
  relationship?: string | null;
  weight: number;
}

export interface SyncLinksResult {
  upserted: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LINK_BATCH_SIZE = 2000;

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Sync page links to the wiki-server.
 * Replaces all existing links with the provided set (full sync).
 * Splits into batches for large link sets.
 */
export async function syncPageLinks(
  links: PageLinkItem[],
): Promise<ApiResult<SyncLinksResult>> {
  const serverUrl = getServerUrl();
  if (!serverUrl) return { ok: false, error: 'unavailable', message: 'LONGTERMWIKI_SERVER_URL not set' };

  let totalUpserted = 0;

  for (let i = 0; i < links.length; i += LINK_BATCH_SIZE) {
    const batch = links.slice(i, i + LINK_BATCH_SIZE);
    const isFirst = i === 0;

    const result = await batchedRequest<SyncLinksResult>(
      'POST',
      '/api/links/sync',
      { links: batch, replace: isFirst },
    );

    if (!result.ok) {
      console.warn(`  WARNING: Link sync batch failed: ${result.message}`);
      return result;
    }

    totalUpserted += result.data.upserted;
  }

  return { ok: true, data: { upserted: totalUpserted } };
}

// ---------------------------------------------------------------------------
// Backward-compatible wrapper
// ---------------------------------------------------------------------------

/** @deprecated Use the ApiResult-returning version and handle errors explicitly. */
export const syncPageLinks_compat = async (links: PageLinkItem[]) =>
  unwrap(await syncPageLinks(links));
