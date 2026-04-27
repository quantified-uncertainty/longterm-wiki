/**
 * Unit-tagged number formatting (hardcoded million/billion/trillion thresholds
 * and CURRENCIES lookup). Prefer `formatValue` from `@longterm-wiki/factbase/format`
 * when a Property definition is available -- it's property.display-driven.
 *
 * Ported from build-data.mjs formatFactNumber/formatFactRange and extended
 * for use by both the facts system and the claims system.
 */

import { CURRENCIES } from "@longterm-wiki/factbase/currencies";

/** Remove trailing .0 from formatted numbers: 380.0 -> "380", 2.5 -> "2.5" */
function cleanDecimal(n: number): string {
  return n % 1 === 0 ? String(n) : n.toFixed(1);
}

/**
 * Scale a positive number into compact K/M/B/T form with the matching suffix,
 * returning `{ formatted, scaled }` where `scaled < 10 ? one decimal : integer`.
 *
 * Below 1000 returns the locale-grouped number with no suffix.
 */
function compactScale(abs: number): { formatted: string; suffix: "" | "K" | "M" | "B" | "T" } {
  const tiers: { min: number; divisor: number; suffix: "K" | "M" | "B" | "T" }[] = [
    { min: 1e12, divisor: 1e12, suffix: "T" },
    { min: 1e9, divisor: 1e9, suffix: "B" },
    { min: 1e6, divisor: 1e6, suffix: "M" },
    { min: 1e3, divisor: 1e3, suffix: "K" },
  ];
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i];
    if (abs < t.min) continue;
    const v = abs / t.divisor;
    // < 10 of a unit keeps one decimal ("$1.5B"); at or above, drop decimals ("$30B").
    const formatted = v < 10 ? v.toFixed(1).replace(/\.0$/, "") : v.toFixed(0);
    // Promote: "999.999 / 1e3 -> 1000K" should become "$1M".
    if (i > 0 && Number(formatted) >= 1000) {
      const promoted = tiers[i - 1];
      const pv = abs / promoted.divisor;
      return {
        formatted: pv < 10 ? pv.toFixed(1).replace(/\.0$/, "") : pv.toFixed(0),
        suffix: promoted.suffix,
      };
    }
    return { formatted, suffix: t.suffix };
  }
  return { formatted: abs.toLocaleString("en-US"), suffix: "" };
}

/** Compact-format a signed number as "-$1.5K" / "$380B" / "$500" with the given
 *  currency symbol and position. Used for currency-tagged values. */
function compactCurrency(n: number, sym: string, position: "prefix" | "suffix"): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  const { formatted, suffix } = compactScale(abs);
  return withCurrency(sym, position, `${sign}${formatted}${suffix}`);
}

/**
 * Resolve the currency info for a given unit/currency combination.
 * Returns null if the unit is not monetary.
 */
function resolveCurrencyInfo(unit?: string | null, currency?: string | null): { symbol: string; position: "prefix" | "suffix" } | null {
  if (currency && Object.hasOwn(CURRENCIES, currency)) {
    // Only apply currency override if unit is absent or itself monetary.
    // Prevents e.g. unit="percent" + currency="GBP" from formatting as £40.
    if (!unit || Object.hasOwn(CURRENCIES, unit)) {
      return { symbol: CURRENCIES[currency].symbol, position: CURRENCIES[currency].symbolPosition };
    }
  }
  if (unit && Object.hasOwn(CURRENCIES, unit)) {
    return { symbol: CURRENCIES[unit].symbol, position: CURRENCIES[unit].symbolPosition };
  }
  return null;
}

/** Format a number with a currency symbol, respecting prefix/suffix position and negative sign. */
function withCurrency(sym: string, position: "prefix" | "suffix", formatted: string): string {
  if (position === "suffix") return `${formatted} ${sym}`;
  // For prefix currencies, put the negative sign before the symbol: -$1,234 not $-1,234
  if (formatted.startsWith("-")) return `-${sym}${formatted.slice(1)}`;
  return `${sym}${formatted}`;
}

/**
 * Format a single number into a human-readable string based on unit.
 *
 * Currency values use compact short form so stat cards, chart captions, and
 * inline MDX fact values all render the same way (QUA-681 / QUA-82 / QUA-673).
 *
 * Examples:
 *   formatNumberWithUnit(850000000, "USD")              -> "$850M"
 *   formatNumberWithUnit(100000000, "USD", "GBP")       -> "£100M"
 *   formatNumberWithUnit(30000000000, "USD")            -> "$30B"
 *   formatNumberWithUnit(22060, "USD")                  -> "$22K"
 *   formatNumberWithUnit(40, "percent")                 -> "40%"
 *   formatNumberWithUnit(1500, "count")                 -> "1,500"
 *   formatNumberWithUnit(200000, "tokens")              -> "200,000"
 */
export function formatNumberWithUnit(n: number | null | undefined, unit?: string | null, currency?: string | null): string {
  if (n == null) return "";
  const cur = resolveCurrencyInfo(unit, currency);
  if (cur !== null) {
    return compactCurrency(n, cur.symbol, cur.position);
  }
  if (unit === "percent") return `${cleanDecimal(n)}%`;
  if (unit === "count" || unit === "tokens") {
    if (Math.abs(n) >= 1e12) return `${cleanDecimal(n / 1e12)} trillion`;
    if (Math.abs(n) >= 1e9) return `${cleanDecimal(n / 1e9)} billion`;
    if (Math.abs(n) >= 1e6) return `${cleanDecimal(n / 1e6)} million`;
    return n.toLocaleString("en-US");
  }
  // Fallback for unknown/missing units
  // Use scientific notation for extremely large numbers (>= 1e15) where
  // "trillion" labels produce unreadable results like "100000000000000 trillion"
  if (Math.abs(n) >= 1e15) {
    const exp = Math.floor(Math.log10(Math.abs(n)));
    const mantissa = n / Math.pow(10, exp);
    const mantissaStr = Math.abs(mantissa - 1) < 0.01 ? "" : `${cleanDecimal(mantissa)} × `;
    return `${mantissaStr}10^${exp}`;
  }
  if (Math.abs(n) >= 1e12) return `${cleanDecimal(n / 1e12)} trillion`;
  if (Math.abs(n) >= 1e9) return `${cleanDecimal(n / 1e9)} billion`;
  if (Math.abs(n) >= 1e6) return `${cleanDecimal(n / 1e6)} million`;
  return n.toLocaleString("en-US");
}

/**
 * Format a [low, high] range into a human-readable string.
 *
 * Currency ranges use the same compact short form as `formatNumberWithUnit`
 * so stat cards and chart captions line up.
 *
 * Examples:
 *   formatValueRange(20e9, 26e9, "USD")            -> "$20B-$26B"
 *   formatValueRange(20e6, 30e6, "USD", "GBP")     -> "£20M-£30M"
 *   formatValueRange(20, 30, "percent")            -> "20-30%"
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
    return `${compactCurrency(lo, cur.symbol, cur.position)}-${compactCurrency(hi, cur.symbol, cur.position)}`;
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
 *   formatStructuredValue("850000000", "USD")   -> "$850M"
 *   formatStructuredValue("San Francisco", null) -> "San Francisco"
 */
export function formatStructuredValue(
  rawValue: string,
  unit: string | null,
): string {
  const n = Number(rawValue);
  if (Number.isFinite(n) && rawValue.trim() !== "") {
    return formatNumberWithUnit(n, unit);
  }
  return rawValue;
}
