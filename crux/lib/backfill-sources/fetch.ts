/**
 * Wiki-server I/O for the backfill-sources command.
 *
 * The two endpoints used here both live in
 * apps/wiki-server/src/routes/sourcing/missing-sources/route.ts, mounted at
 * /api/sourcing/missing-sources in app.ts:
 *   GET  /api/sourcing/missing-sources                — records lacking a source URL
 *   POST /api/sourcing/missing-sources/update-source  — write a source URL to one record
 *
 * The update endpoint knows which column holds the source per table (e.g.
 * `source_url` vs `source` vs `evidence_url`) so callers don't need to.
 */

import { apiRequest } from '../wiki-server/client.ts';
import type { MissingSourceRecord, MissingSourcesResponse } from './types.ts';

export interface FetchOptions {
  limit: number;
  table?: string;
}

/**
 * Fetch records that are missing a source URL across all tracked tables, then
 * flatten the per-table buckets into a single list (the order of tables is
 * preserved). On endpoint failure returns `{ error: string }` so the caller
 * can surface the message; on success returns `{ records, totalMissing }`.
 */
export async function fetchMissingSources(
  options: FetchOptions,
): Promise<{ records: MissingSourceRecord[]; totalMissing: number } | { error: string }> {
  const qs = new URLSearchParams({ limit: String(options.limit) });
  if (options.table) qs.set('table', options.table);

  const response = await apiRequest<MissingSourcesResponse>(
    'GET',
    `/api/sourcing/missing-sources?${qs.toString()}`,
  );

  if (!response.ok) {
    return { error: response.message };
  }

  const records: MissingSourceRecord[] = [];
  for (const { records: bucket } of Object.values(response.data.tables)) {
    records.push(...bucket);
  }
  return { records, totalMissing: response.data.totalMissing };
}

/**
 * Persist `url` as the source for one record. Returns true on a successful
 * write (response.updated >= 1), false on any failure (API error or 0 rows
 * affected). Logs a warning on each failure so the operator sees it inline.
 */
export async function updateRecordSource(
  record: MissingSourceRecord,
  url: string,
): Promise<boolean> {
  const response = await apiRequest<{ updated?: number; error?: string }>(
    'POST',
    '/api/sourcing/missing-sources/update-source',
    {
      table: record.record_table,
      recordId: record.record_id,
      url,
    },
  );
  if (!response.ok) {
    console.warn(`  Update API error: ${response.message}`);
    return false;
  }
  const updated = response.data.updated ?? 0;
  if (updated === 0) {
    console.warn(`  Update wrote 0 rows (record may have been deleted): ${record.record_table}/${record.record_id}`);
    return false;
  }
  return true;
}
