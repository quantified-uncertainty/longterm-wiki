/**
 * Shared utility for stripping internal/noisy columns from Drizzle query results.
 * Used by entity-profile and record-lookup routes.
 */

const EXCLUDED_COLUMNS = new Set([
  "synced_at",
  "created_at",
  "updated_at",
  "content_plaintext",
  "search_vector",
  "synced_from_branch",
  "synced_from_commit",
]);

const EXCLUDED_CAMEL = new Set(
  [...EXCLUDED_COLUMNS].map((k) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()))
);

/** Strip internal columns from an array of Drizzle query result rows. */
export function stripInternalColumns(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => stripInternalColumnsFromRow(row));
}

/** Strip internal columns from a single row. */
export function stripInternalColumnsFromRow(row: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!EXCLUDED_CAMEL.has(key)) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}
