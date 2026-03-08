/**
 * Shared value formatting for structured data display.
 *
 * Ported from build-data.mjs formatFactNumber/formatFactRange and extended
 * for use by both the facts system and the claims system.
 */

import { CURRENCIES } from "@longterm-wiki/kb";

/** Remove trailing .0 from formatted numbers: 380.0 -> "380", 2.5 -> "2.5" */
function cleanDecimal(n: number): string {
  return n % 1 === 0 ? String(n) : n.toFixed(1);
}

/**
 * Resolve the currency info for a given unit/currency combination.
 * Returns null if the unit is not monetary.
 */
function resolveCurrencyInfo(unit?: string | null, currency?: string | null): { symbol: string; position: "prefix" | "suffix" } | null {
  if (currency && currency in CURRENCIES) {
    return { symbol: CURRENCIES[currency].symbol, position: CURRENCIES[currency].symbolPosition };
  }
  if (unit && unit in CURRENCIES) {
    return { symbol: CURRENCIES[unit].symbol, position: CURRENCIES[unit].symbolPosition };
  }
  return null;
}

/** Format a number with a currency symbol, respecting prefix/suffix position. */
function withCurrency(sym: string, position: "prefix" | "suffix", formatted: string): string {
  return position === "suffix" ? `${formatted} ${sym}` : `${sym}${formatted}`;
}

/**
 * Format a single number into a human-readable string based on unit.
 *
 * Examples:
 *   formatValue(850000000, "USD")              -> "$850 million"
 *   formatValue(100000000, "USD", "GBP")       -> "£100 million"
 *   formatValue(30000000000, "USD")            -> "$30 billion"
 *   formatValue(40, "percent")                 -> "40%"
 *   formatValue(1500, "count")                 -> "1,500"
 *   formatValue(200000, "tokens")              -> "200,000"
 */
export function formatValue(n: number, unit?: string | null, currency?: string | null): string {
  const cur = resolveCurrencyInfo(unit, currency);
  if (cur !== null) {
    if (Math.abs(n) >= 1e12) return withCurrency(cur.symbol, cur.position, `${cleanDecimal(n / 1e12)} trillion`);
    if (Math.abs(n) >= 1e9) return withCurrency(cur.symbol, cur.position, `${cleanDecimal(n / 1e9)} billion`);
    if (Math.abs(n) >= 1e6) return withCurrency(cur.symbol, cur.position, `${cleanDecimal(n / 1e6)} million`);
    return withCurrency(cur.symbol, cur.position, n.toLocaleString("en-US"));
  }
  if (unit === "percent") return `${cleanDecimal(n)}%`;
  if (unit === "count" || unit === "tokens") {
    if (Math.abs(n) >= 1e12) return `${cleanDecimal(n / 1e12)} trillion`;
    if (Math.abs(n) >= 1e9) return `${cleanDecimal(n / 1e9)} billion`;
    if (Math.abs(n) >= 1e6) return `${cleanDecimal(n / 1e6)} million`;
    return n.toLocaleString("en-US");
  }
  // Fallback for unknown/missing units
  if (Math.abs(n) >= 1e12) return `${cleanDecimal(n / 1e12)} trillion`;
  if (Math.abs(n) >= 1e9) return `${cleanDecimal(n / 1e9)} billion`;
  if (Math.abs(n) >= 1e6) return `${cleanDecimal(n / 1e6)} million`;
  return n.toLocaleString("en-US");
}

/**
 * Format a [low, high] range into a human-readable string.
 *
 * Examples:
 *   formatValueRange(20e9, 26e9, "USD")            -> "$20-$26 billion"
 *   formatValueRange(20e6, 30e6, "USD", "GBP")     -> "£20-£30 million"
 *   formatValueRange(20, 30, "percent")             -> "20-30%"
 */
export function formatValueRange(
  lo: number,
  hi: number,
  unit?: string | null,
  currency?: string | null,
): string {
  if (unit === "percent") return `${cleanDecimal(lo)}-${cleanDecimal(hi)}%`;
  const cur = resolveCurrencyInfo(unit, currency);
  if (cur !== null) {
    const { symbol: sym, position: pos } = cur;
    if (lo >= 1e9 && hi >= 1e9)
      return pos === "suffix"
        ? `${cleanDecimal(lo / 1e9)}-${cleanDecimal(hi / 1e9)} billion ${sym}`
        : `${sym}${cleanDecimal(lo / 1e9)}-${sym}${cleanDecimal(hi / 1e9)} billion`;
    if (lo >= 1e6 && hi >= 1e6)
      return pos === "suffix"
        ? `${cleanDecimal(lo / 1e6)}-${cleanDecimal(hi / 1e6)} million ${sym}`
        : `${sym}${cleanDecimal(lo / 1e6)}-${sym}${cleanDecimal(hi / 1e6)} million`;
    return pos === "suffix"
      ? `${lo.toLocaleString("en-US")}-${hi.toLocaleString("en-US")} ${sym}`
      : `${sym}${lo.toLocaleString("en-US")}-${sym}${hi.toLocaleString("en-US")}`;
  }
  if (unit === "count" || unit === "tokens") {
    if (lo >= 1e6 && hi >= 1e6)
      return `${cleanDecimal(lo / 1e6)}-${cleanDecimal(hi / 1e6)} million`;
    return `${lo.toLocaleString("en-US")}-${hi.toLocaleString("en-US")}`;
  }
  return `${lo.toLocaleString("en-US")}-${hi.toLocaleString("en-US")}`;
}

/**
 * Format a structured claim value (stored as a string) using its unit.
 * Parses to number, formats, falls back to the raw string if not numeric.
 *
 * Examples:
 *   formatStructuredValue("850000000", "USD")   -> "$850 million"
 *   formatStructuredValue("San Francisco", null) -> "San Francisco"
 */
export function formatStructuredValue(
  rawValue: string,
  unit: string | null,
): string {
  const n = Number(rawValue);
  if (Number.isFinite(n) && rawValue.trim() !== "") {
    return formatValue(n, unit);
  }
  return rawValue;
}
