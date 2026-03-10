/**
 * Shared formatting utilities for KB data.
 *
 * Used by CLI tools, frontend components, and any other consumer
 * that needs human-readable representations of KB values.
 */

import type { Fact, Property } from "./types";
import type { Graph } from "./graph";
import { CURRENCIES, resolveCurrency } from "./currencies";

// ── Monetary formatting ─────────────────────────────────────────────

/**
 * Format a monetary amount in a compact human-readable form.
 * e.g. formatMoney(1_500_000_000) → "$1.5B"
 *      formatMoney(100_000_000, "GBP") → "£100M"
 *      formatMoney(-5_000_000_000) → "-$5.0B"
 */
export function formatMoney(value: number, currencyCode: string = "USD"): string {
  const cur = CURRENCIES[currencyCode] ?? CURRENCIES.USD;
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  let num: string;
  if (abs >= 1e12) num = `${(abs / 1e12).toFixed(1)}T`;
  else if (abs >= 1e9) num = `${(abs / 1e9).toFixed(1)}B`;
  else if (abs >= 1e6) num = `${(abs / 1e6).toFixed(0)}M`;
  else if (abs >= 1e3) num = `${(abs / 1e3).toFixed(0)}K`;
  else num = `${abs}`;

  if (cur.symbolPosition === "suffix") {
    return `${sign}${num} ${cur.symbol}`;
  }
  return `${sign}${cur.symbol}${num}`;
}

// ── Value formatting ────────────────────────────────────────────────

/**
 * Format a numeric value using a property's display config.
 * Falls back to locale-formatted number if no display config exists.
 *
 * When `currency` is provided and the property is financial (unit: USD),
 * the currency's symbol replaces the property's display prefix.
 */
export function formatValue(value: unknown, property?: Property, currency?: string): string {
  if (value === null || value === undefined) return "(none)";

  if (typeof value === "number" && property?.display) {
    const { divisor, prefix, suffix } = property.display;
    // If a currency override is provided and the property's default unit is a currency,
    // use the override currency's symbol instead of the hardcoded prefix.
    let effectivePrefix = prefix ?? "";
    if (currency && property.unit && Object.hasOwn(CURRENCIES, property.unit)) {
      const cur = CURRENCIES[currency] ?? CURRENCIES[property.unit];
      effectivePrefix = cur.symbol;
    }

    let formatted: string;
    if (divisor && Number.isFinite(divisor)) {
      const divided = value / divisor;
      if (divided >= 100) {
        formatted = divided.toLocaleString("en-US", {
          maximumFractionDigits: 0,
        });
      } else {
        formatted = divided.toLocaleString("en-US", {
          maximumFractionDigits: 1,
        });
      }
    } else {
      // No divisor: use raw number without locale grouping separators.
      // This handles cases like "born-year: 1983" where commas would be wrong.
      formatted = String(value);
    }
    return `${effectivePrefix}${formatted}${suffix ?? ""}`;
  }

  if (typeof value === "number") {
    return value.toLocaleString("en-US");
  }

  return String(value);
}

/**
 * Format a fact value for display, resolving refs to entity names when possible.
 */
export function formatFactValue(
  fact: Fact,
  property: Property | undefined,
  graph: Graph
): string {
  const val = fact.value;

  if (val.type === "ref") {
    const entity = graph.getEntity(val.value);
    return entity ? `${entity.name} (${val.value})` : val.value;
  }

  if (val.type === "refs") {
    return val.value
      .map((refId: string) => {
        const entity = graph.getEntity(refId);
        return entity ? `${entity.name} (${refId})` : refId;
      })
      .join(", ");
  }

  if (val.type === "number") {
    return formatValue(val.value, property, fact.currency);
  }

  if (val.type === "range") {
    const lowStr = formatValue(val.low, property);
    const highStr = formatValue(val.high, property);
    return `${lowStr}\u2013${highStr}`;
  }

  if (val.type === "min") {
    const valStr = formatValue(val.value, property);
    return `\u2265${valStr}`;
  }

  return String(val.value);
}

// ── Ref resolution ──────────────────────────────────────────────────

/**
 * Resolve an entity ID or slug to its display name, falling back to the input.
 */
export function resolveRefName(idOrSlug: string, graph: Graph): string {
  const entity = graph.getEntity(idOrSlug);
  return entity ? entity.name : idOrSlug;
}

