/**
 * Resources API — wiki-server client module
 */

import { apiRequest, unwrap, type ApiResult } from './client.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UpsertResourceItem {
  id: string;
  url: string;
  title?: string | null;
  type?: string | null;
  summary?: string | null;
  review?: string | null;
  abstract?: string | null;
  keyPoints?: string[] | null;
  publicationId?: string | null;
  authors?: string[] | null;
  publishedDate?: string | null;
  tags?: string[] | null;
  localFilename?: string | null;
  credibilityOverride?: number | null;
  fetchedAt?: string | null;
  contentHash?: string | null;
  citedBy?: string[] | null;
}

export interface UpsertResourceResult {
  id: string;
  url: string;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export async function upsertResource(
  item: UpsertResourceItem,
): Promise<ApiResult<UpsertResourceResult>> {
  return apiRequest<UpsertResourceResult>('POST', '/api/resources', item);
}

// ---------------------------------------------------------------------------
// Backward-compatible wrapper
// ---------------------------------------------------------------------------

/** @deprecated Use the ApiResult-returning version and handle errors explicitly. */
export const upsertResource_compat = async (item: UpsertResourceItem) =>
  unwrap(await upsertResource(item));
