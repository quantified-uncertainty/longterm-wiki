/**
 * Client-safe compact formatting utilities for directory pages.
 * No server-only imports — safe for "use client" components.
 */

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  GBP: "\u00A3",
  EUR: "\u20AC",
  CHF: "CHF\u00A0",
  CAD: "CA$",
  AUD: "A$",
  JPY: "\u00A5",
  CNY: "CN\u00A5",
  SEK: "SEK\u00A0",
  NOK: "NOK\u00A0",
  DKK: "DKK\u00A0",
};

/** Get the currency symbol for a currency code, falling back to the code itself. */
function currencySymbol(currency: string): string {
  if (!currency) return CURRENCY_SYMBOLS.USD;
  return CURRENCY_SYMBOLS[currency] ?? `${currency}\u00A0`;
}

/** Format a number as compact currency: $1.2T, $850M, $6.6M, $42K.
 *  Accepts an optional currency code (default: USD). */
export function formatCompactCurrency(n: number | null | undefined, currency?: string): string {
  if (n == null || isNaN(n) || !isFinite(n)) return "";
  const sym = currencySymbol(currency ?? "USD");
  if (Math.abs(n) >= 1e12) return `${sym}${(n / 1e12).toFixed(1)}T`;
  if (Math.abs(n) >= 1e9) {
    const b = n / 1e9;
    const formatted = Math.abs(b) < 10 ? b.toFixed(1).replace(/\.0$/, "") : b.toFixed(0);
    return `${sym}${formatted}B`;
  }
  if (Math.abs(n) >= 1e6) {
    const m = n / 1e6;
    const formatted = Math.abs(m) < 10 ? m.toFixed(1).replace(/\.0$/, "") : m.toFixed(0);
    return `${sym}${formatted}M`;
  }
  if (Math.abs(n) >= 1e3) {
    const k = n / 1e3;
    const formatted = Math.abs(k) < 10 ? k.toFixed(1).replace(/\.0$/, "") : k.toFixed(0);
    return `${sym}${formatted}K`;
  }
  return `${sym}${n.toLocaleString()}`;
}

/** Format a number as compact: 1.2T, 850M, 6.6M, 42K (no currency symbol) */
export function formatCompactNumber(n: number | null | undefined): string {
  if (n == null || isNaN(n) || !isFinite(n)) return "";
  if (Math.abs(n) >= 1e12) return `${(n / 1e12).toFixed(1)}T`;
  if (Math.abs(n) >= 1e9) {
    const b = n / 1e9;
    const formatted = Math.abs(b) < 10 ? b.toFixed(1).replace(/\.0$/, "") : b.toFixed(0);
    return `${formatted}B`;
  }
  if (Math.abs(n) >= 1e6) {
    const m = n / 1e6;
    const formatted = Math.abs(m) < 10 ? m.toFixed(1).replace(/\.0$/, "") : m.toFixed(0);
    return `${formatted}M`;
  }
  if (Math.abs(n) >= 1e3) {
    const k = n / 1e3;
    const formatted = Math.abs(k) < 10 ? k.toFixed(1).replace(/\.0$/, "") : k.toFixed(0);
    return `${formatted}K`;
  }
  return n.toLocaleString();
}

const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * If `n` is a plausible YYYYMMDD-family timestamp encoded as a single
 * positive integer (8/12/14 digits, year 1900-2099, calendar-valid
 * month/day, valid hour/minute/second when present), return a human
 * date string; otherwise return null.
 *
 * Catches BIGINT timestamp columns surfacing on the Database tab as raw
 * integers (e.g. `20240601000000` from a `*_at` column stored as bigint
 * encoded YYYYMMDDhhmmss instead of TIMESTAMPTZ). Without this check the
 * compact-number formatter would render the value as a magnitude
 * (`"$20.2T"` / `"20.2T"`) — technically not a 10+ digit leak but a
 * misleading display. QUA-684.
 *
 * 9, 10, 11, 13 digit lengths (Unix epoch seconds/ms) are intentionally
 * NOT detected — they overlap the plausible-magnitude range for headcount
 * and revenue facts.
 */
export function formatDateShapedInteger(n: number): string | null {
  // Range gate skips String(n) allocation for the vast majority of non-date
  // numbers (small counts, sub-1900 values, magnitudes beyond Dec 31, 2099).
  if (
    !Number.isFinite(n) ||
    !Number.isInteger(n) ||
    n < 19000101 ||
    n > 20991231235959
  ) return null;
  const s = String(n);
  if (s.length !== 8 && s.length !== 12 && s.length !== 14) return null;

  const year = Number(s.slice(0, 4));
  const month = Number(s.slice(4, 6));
  const day = Number(s.slice(6, 8));
  if (year < 1900 || year > 2099) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;

  let hour = 0;
  let minute = 0;
  let second = 0;
  if (s.length >= 12) {
    hour = Number(s.slice(8, 10));
    minute = Number(s.slice(10, 12));
    if (hour > 23 || minute > 59) return null;
  }
  if (s.length === 14) {
    second = Number(s.slice(12, 14));
    if (second > 59) return null;
  }

  // Calendar-validity check (Feb 30, Feb 29 in non-leap years, etc.)
  const d = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) return null;

  const datePart = `${MONTH_ABBR[month - 1]} ${day}, ${year}`;
  if (s.length === 8) return datePart;
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  if (s.length === 12) return `${datePart} ${hh}:${mm} UTC`;
  const ss = String(second).padStart(2, "0");
  return `${datePart} ${hh}:${mm}:${ss} UTC`;
}

/**
 * Rewrite bare 10+ digit runs inside a display string as compact numbers
 * (`"Revenue: 1700000000"` → `"Revenue: 1.7B"`). 12/14-digit runs that
 * match a YYYYMMDD[hhmm[ss]] shape render as dates instead, so a stray
 * `20240601000000` in a description is rewritten as `Jun 1, 2024 ...` not
 * `20.2T`. QUA-684.
 *
 * Boundaries are tuned so embedded digit runs stay untouched:
 *   - Look-behind blocks letters, digits, underscores, and `.` so hashes
 *     (`abc1234567890def`) and decimals (`0.1700000000`, `2.1700000000`)
 *     are skipped.
 *   - Look-ahead blocks letters, digits, and `.<digit>` so decimals like
 *     `"1700000000.5"` stay intact while a sentence-ending `"1700000000. "`
 *     still matches. `-`, `$`, `:`, and whitespace stay unblocked so
 *     signed / currency-prefixed / `Label: N` strings format as expected.
 */
export function sanitizeRawLargeNumbers(s: string): string {
  return s.replace(
    /(?<![a-zA-Z_\d.])(\d{10,})(?![a-zA-Z\d]|\.\d)/g,
    (m) => {
      const n = Number(m);
      if (!Number.isFinite(n) || Math.abs(n) < 1000) return m;
      const dateShape = formatDateShapedInteger(n);
      if (dateShape) return dateShape;
      return formatCompactNumber(n);
    },
  );
}

/** Return href only if it is a safe HTTP(S) URL; otherwise "#". Prevents XSS via javascript: URIs. */
export function safeHref(url: string): string {
  return /^https?:\/\//i.test(url) ? url : "#";
}

/**
 * Format a legislation `introduced` date string with appropriate precision:
 * - Year-only ("2021")        → "2021"
 * - Year-month ("2021-04")    → "Apr 2021"
 * - Full ISO ("2021-04-15")   → "Apr 15, 2021"
 * Returns the raw value as-is if it does not match any of these patterns.
 */
export function formatIntroducedDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();

  // Full ISO date: YYYY-MM-DD
  const fullMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (fullMatch) {
    const year = fullMatch[1];
    const month = parseInt(fullMatch[2], 10);
    const day = parseInt(fullMatch[3], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${MONTH_ABBR[month - 1]} ${day}, ${year}`;
    }
  }

  // Year-month: YYYY-MM
  const ymMatch = /^(\d{4})-(\d{2})$/.exec(trimmed);
  if (ymMatch) {
    const year = ymMatch[1];
    const month = parseInt(ymMatch[2], 10);
    if (month >= 1 && month <= 12) {
      return `${MONTH_ABBR[month - 1]} ${year}`;
    }
  }

  // Year-only: YYYY
  if (/^\d{4}$/.test(trimmed)) {
    return trimmed;
  }

  // Unknown format: return as-is
  return trimmed;
}
