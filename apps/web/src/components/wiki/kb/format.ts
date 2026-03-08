/**
 * Shared formatting utilities for KB rendering components.
 *
 * Uses the smart `formatValue` from format-value.ts for numbers with known
 * units, and falls back to PropertyDisplay (divisor/prefix/suffix) otherwise.
 */

import { formatValue as smartFormatValue } from "@lib/format-value";
import { CURRENCIES } from "@longterm-wiki/kb/currencies";
import type { Fact, FieldDef, ItemEntry, PropertyDisplay } from "@longterm-wiki/kb";

// ── Date formatting ────────────────────────────────────────────────

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Format a date string for display.
 *   "2024-06"    → "Jun 2024"
 *   "2024-06-15" → "Jun 2024"
 *   "2024"       → "2024"
 *   undefined    → "—"
 */
export function formatKBDate(dateStr: string | undefined): string {
  if (!dateStr) return "\u2014";

  const parts = dateStr.split("-");
  if (parts.length >= 2) {
    const monthIndex = parseInt(parts[1], 10) - 1;
    if (monthIndex >= 0 && monthIndex < 12) {
      return `${MONTH_NAMES[monthIndex]} ${parts[0]}`;
    }
  }

  return dateStr; // Just the year or unknown format
}

// ── Number formatting ──────────────────────────────────────────────

/**
 * Format a numeric fact value. Prefers the smart unit-aware formatter
 * from format-value.ts when a unit is available; falls back to
 * PropertyDisplay config (divisor/prefix/suffix).
 *
 * When `currency` is provided, it overrides the property's default
 * currency symbol (e.g., "GBP" → "£" instead of "$").
 */
export function formatKBNumber(
  value: number,
  unit?: string,
  display?: PropertyDisplay,
  currency?: string,
): string {
  // If the property has a known unit (USD, percent, count, tokens),
  // use the smart formatter which produces "$850 million", "40%", etc.
  if (unit) {
    return smartFormatValue(value, unit, currency);
  }

  // Fall back to PropertyDisplay config
  if (display) {
    let num = value;
    if (display.divisor && display.divisor !== 0) {
      num = num / display.divisor;
    }
    const formatted = Number.isInteger(num)
      ? num.toLocaleString()
      : num.toLocaleString(undefined, { maximumFractionDigits: 2 });
    // If currency override provided and display has a currency-like prefix, use currency symbol
    let prefix = display.prefix ?? "";
    if (currency && Object.hasOwn(CURRENCIES, currency)) {
      prefix = CURRENCIES[currency].symbol;
    }
    const suffix = display.suffix ?? "";
    return `${prefix}${formatted}${suffix}`;
  }

  // No unit, no display config — plain locale string
  return value.toLocaleString();
}

// ── Fact value formatting ──────────────────────────────────────────

/**
 * Format a full Fact value for display.
 * Handles all FactValue types (number, text, date, boolean, ref, refs, json).
 */
export function formatKBFactValue(
  fact: Fact,
  unit?: string,
  display?: PropertyDisplay,
): string {
  const v = fact.value;

  switch (v.type) {
    case "number":
      return formatKBNumber(v.value, unit ?? v.unit, display, fact.currency);
    case "boolean":
      return v.value ? "Yes" : "No";
    case "date":
      return formatKBDate(v.value);
    case "text":
      return v.value;
    case "ref":
      return v.value; // Caller should render as EntityLink
    case "refs":
      return v.value.join(", "); // Caller should render as EntityLinks
    case "range": {
      const lowStr = formatKBNumber(v.low, unit, display);
      const highStr = formatKBNumber(v.high, unit, display);
      return `${lowStr}\u2013${highStr}`;
    }
    case "min":
      return `\u2265${formatKBNumber(v.value, unit, display)}`;
    case "json":
      return JSON.stringify(v.value);
    default:
      return String((v as { value: unknown }).value);
  }
}

// ── Item cell formatting ───────────────────────────────────────────

/**
 * Format a cell value from an item collection, using the field definition
 * from the schema when available for type-aware formatting.
 *
 * Returns a string for simple values. Callers that need JSX (e.g., for
 * EntityLink rendering) should check the fieldDef.type directly.
 */
export function formatKBCellValue(
  value: unknown,
  fieldDef?: FieldDef,
): string {
  if (value === null || value === undefined) return "\u2014";

  // Use field definition for type-aware formatting
  if (fieldDef) {
    switch (fieldDef.type) {
      case "number":
        if (typeof value === "number") {
          return formatKBNumber(value, fieldDef.unit);
        }
        break;
      case "date":
        if (typeof value === "string") {
          return formatKBDate(value);
        }
        break;
      case "boolean":
        return value ? "Yes" : "No";
      case "ref":
        // Caller should handle ref rendering as EntityLink
        return String(value);
      case "text":
        return String(value);
    }
  }

  // Fallback formatting without schema info
  if (typeof value === "number") return value.toLocaleString();
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// ── Item sorting ───────────────────────────────────────────────────

/** Sort item collection entries by a field value, ascending or descending. */
export function sortKBItems(
  items: ItemEntry[],
  sortBy: string,
  ascending: boolean,
): ItemEntry[] {
  return [...items].sort((a, b) => {
    const va = a.fields[sortBy];
    const vb = b.fields[sortBy];

    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;

    let cmp = 0;
    if (typeof va === "number" && typeof vb === "number") {
      cmp = va - vb;
    } else {
      cmp = String(va).localeCompare(String(vb));
    }
    return ascending ? cmp : -cmp;
  });
}

// ── Helpers ────────────────────────────────────────────────────────

/** Check if a string looks like a URL. */
export function isUrl(s: string): boolean {
  return s.startsWith("http://") || s.startsWith("https://");
}

/** Convert a kebab/snake-case field name to a title-case header. */
export function titleCase(s: string): string {
  return s
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Try to extract a short domain name from a URL for display.
 *   "https://www.reuters.com/technology/..." → "reuters.com"
 *   "https://arxiv.org/abs/2301.12345"      → "arxiv.org"
 */
export function shortDomain(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    return hostname.replace(/^www\./, "");
  } catch {
    return "Link";
  }
}
