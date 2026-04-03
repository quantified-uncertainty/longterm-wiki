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
  CNY: "\u00A5",
  SEK: "SEK\u00A0",
  NOK: "NOK\u00A0",
  DKK: "DKK\u00A0",
};

/** Get the currency symbol for a currency code, falling back to the code itself. */
function currencySymbol(currency: string): string {
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
  if (Math.abs(n) >= 1e3) return `${sym}${(n / 1e3).toFixed(0)}K`;
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
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return n.toLocaleString();
}

/** Return href only if it is a safe HTTP(S) URL; otherwise "#". Prevents XSS via javascript: URIs. */
export function safeHref(url: string): string {
  return /^https?:\/\//i.test(url) ? url : "#";
}

const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

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
