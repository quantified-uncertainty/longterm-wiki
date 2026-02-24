/**
 * Resources API — wiki-server client module
 *
 * Input types are derived from the canonical Zod schemas in api-types.ts.
 * Response types are imported from the canonical api-types.ts definitions.
 */

import { apiRequest, type ApiResult } from './client.ts';
import type {
  UpsertResource,
  UpsertResourceResult,
} from '../../../apps/wiki-server/src/api-types.ts';

// ---------------------------------------------------------------------------
// Types — input (derived from server Zod schemas)
// ---------------------------------------------------------------------------

export type UpsertResourceItem = UpsertResource;

// ---------------------------------------------------------------------------
// Types — response (re-exported from canonical api-types.ts)
// ---------------------------------------------------------------------------

export type { UpsertResourceResult };

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export async function upsertResource(
  item: UpsertResourceItem,
): Promise<ApiResult<UpsertResourceResult>> {
  return apiRequest<UpsertResourceResult>('POST', '/api/resources', item);
}

