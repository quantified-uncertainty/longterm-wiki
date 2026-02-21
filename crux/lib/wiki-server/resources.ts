/**
 * Resources API — wiki-server client module
 *
 * Input types are derived from the canonical Zod schemas in api-types.ts.
 */

import { apiRequest, type ApiResult } from './client.ts';
import type { UpsertResource } from '../../../apps/wiki-server/src/api-types.ts';

// ---------------------------------------------------------------------------
// Types — input (derived from server Zod schemas)
// ---------------------------------------------------------------------------

export type UpsertResourceItem = UpsertResource;

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

