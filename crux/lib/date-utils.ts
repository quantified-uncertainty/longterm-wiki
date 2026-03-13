/**
 * Date normalization utilities.
 *
 * These helpers convert loose date/timestamp values (strings, Date objects,
 * undefined) into canonical string formats suitable for database storage.
 *
 * - normalizeDate   → "YYYY-MM-DD" or null
 * - normalizeTimestamp → ISO 8601 timestamp or null
 */

/**
 * Normalize a date value to "YYYY-MM-DD" format.
 * Returns null for missing or unparseable values.
 */
export function normalizeDate(d: string | Date | undefined): string | null {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString().split("T")[0];
  const dateStr = String(d).split(" ")[0];
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  return null;
}

/**
 * Normalize a timestamp value to ISO 8601 format.
 * Handles "YYYY-MM-DD HH:MM:SS", "YYYY-MM-DD", Date objects, and
 * other parseable date strings. Returns null for missing or unparseable values.
 */
export function normalizeTimestamp(d: string | Date | undefined): string | null {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString();
  const str = String(d);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(str)) {
    return str.replace(" ", "T") + "Z";
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return str + "T00:00:00Z";
  }
  try {
    const parsed = new Date(str);
    if (isNaN(parsed.getTime())) return null;
    return parsed.toISOString();
  } catch {
    return null;
  }
}
