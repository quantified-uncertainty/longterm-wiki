/**
 * Record field access utilities — safe accessors for untyped API response objects.
 *
 * Used by factbase-source-check and source-check-orchestrate to extract typed values
 * from raw API response rows without runtime type assertions.
 */

/** Get a string field value, falling back to String() or empty string */
export function str(item: Record<string, unknown>, key: string): string {
  const v = item[key];
  return typeof v === 'string' ? v : String(v ?? '');
}

/** Get a string field value or null if the field is null/undefined */
export function strOrNull(item: Record<string, unknown>, key: string): string | null {
  const v = item[key];
  return v == null ? null : String(v);
}

/** Get a numeric field value or null if the field is not a number */
export function numOrNull(item: Record<string, unknown>, key: string): number | null {
  const v = item[key];
  return typeof v === 'number' ? v : null;
}

/**
 * Resolve a human-readable name from multiple possible field names.
 * Returns the first non-empty string value found, or '(unknown)'.
 */
export function resolveName(item: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const v = item[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '(unknown)';
}
