/**
 * Generic delete-batch client factory for tablebase endpoints.
 *
 * Every tablebase route now has a /delete-batch endpoint (via the shared
 * server-side factory). This module provides client functions for all of them.
 *
 * Usage:
 *   import { deleteBatch } from './delete-batch.ts';
 *   const result = await deleteBatch('divisions', ['id1', 'id2']);
 */

import { apiRequest, type ApiResult } from './client.ts';
import { getTableConfig, canonicalTableName } from '../../tablebase/table-registry.ts';

export interface DeleteBatchResult {
  deleted: number;
}

/**
 * Delete a batch of records by ID from any tablebase entity type.
 *
 * Looks up the delete path from the table registry. Returns an error
 * if the table has no registered delete path.
 *
 * @param table - Table name (hyphenated or underscored, e.g., 'divisions' or 'division_personnel')
 * @param ids - Array of record IDs to delete
 */
export async function deleteBatch(
  table: string,
  ids: string[],
): Promise<ApiResult<DeleteBatchResult>> {
  const canonical = canonicalTableName(table);
  const config = getTableConfig(canonical);
  if (!config?.deletePath) {
    return {
      ok: false,
      error: 'bad_request',
      message: `No delete path registered for table "${table}"`,
    };
  }
  return apiRequest<DeleteBatchResult>('POST', config.deletePath, { ids });
}
