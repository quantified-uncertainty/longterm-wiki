/**
 * Shared date parsing utilities for grant import sources.
 *
 * Each grant source encodes dates differently. These helpers normalize
 * the most common formats into ISO-style strings (YYYY, YYYY-MM, or YYYY-MM-DD).
 */

/** Quarter number (1-4) to the month string for the quarter's start. */
export const QUARTER_TO_MONTH: Record<string, string> = {
  "1": "01",
  "2": "04",
  "3": "07",
  "4": "10",
};

const MONTH_NAMES: Record<string, string> = {
  January: "01",
  February: "02",
  March: "03",
  April: "04",
  May: "05",
  June: "06",
  July: "07",
  August: "08",
  September: "09",
  October: "10",
  November: "11",
  December: "12",
};

/**
 * Parse "Month Year" format.
 * @example parseMonthYear("February 2016") // "2016-02"
 * @example parseMonthYear("December 2023") // "2023-12"
 */
export function parseMonthYear(input: string): string | null {
  const parts = input.trim().split(" ");
  if (parts.length !== 2) return null;

  const monthNum = MONTH_NAMES[parts[0]];
  if (!monthNum || !parts[1]) return null;

  return `${parts[1]}-${monthNum}`;
}

/**
 * Parse "YYYY QN" format (year followed by quarter).
 * @example parseQuarterYear("2025 Q3") // "2025-07"
 * @example parseQuarterYear("2024 Q1") // "2024-01"
 */
export function parseQuarterYear(input: string): string | null {
  const m = input.trim().match(/^(\d{4})\s+Q(\d)$/);
  if (!m) return null;

  const month = QUARTER_TO_MONTH[m[2]];
  if (!month) return null;

  return `${m[1]}-${month}`;
}

/**
 * Extract an ISO date prefix (YYYY-MM-DD) from a longer string.
 * Useful for ISO 8601 timestamps like "2023-05-15T12:00:00Z".
 * @example extractISODate("2023-05-15T12:00:00Z") // "2023-05-15"
 * @example extractISODate("2022-03-15") // "2022-03-15"
 */
export function extractISODate(input: string): string | null {
  const m = input.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/**
 * Truncate a date string to month precision (YYYY-MM).
 * Accepts YYYY-MM-DD or YYYY-MM input.
 * @example truncateToMonth("2022-03-15") // "2022-03"
 * @example truncateToMonth("2022-03") // "2022-03"
 */
export function truncateToMonth(isoDate: string): string | null {
  const m = isoDate.match(/^(\d{4}-\d{2})/);
  return m ? m[1] : null;
}
