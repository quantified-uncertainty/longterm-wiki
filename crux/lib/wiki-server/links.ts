/**
 * Page Links API — wiki-server client module
 *
 * Input types are derived from the canonical Zod schemas in api-types.ts.
 */

import type { z } from 'zod';
import { batchedRequest, getServerUrl, type ApiResult } from './client.ts';
import type { PageLinkSchema } from '../../../apps/wiki-server/src/api-types.ts';

// ---------------------------------------------------------------------------
// Types — input (derived from server Zod schemas)
// ---------------------------------------------------------------------------

/** Uses z.input (not z.infer) because the schema has .default(1.0) on weight. */
export type PageLinkItem = z.input<typeof PageLinkSchema>;

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

