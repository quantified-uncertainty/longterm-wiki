/**
 * Shared formatting utilities for KB data. Contains the canonical, property-driven
 * `formatValue` (takes a Property definition for display config). For raw
 * unit-tagged numbers without a Property, see `formatNumberWithUnit` in
 * apps/web/src/lib/format-value.ts.
 *
 * Used by CLI tools, frontend components, and any other consumer
 * that needs human-readable representations of KB values.
 */

import type { Fact, Property } from "./types";
import type { Graph } from "./graph";
import { CURRENCIES, resolveCurrency } from "./currencies";

// ── Fact label fallback ─────────────────────────────────────────────

/**
 * Return a safe human-readable label for a fact row, never falling back
 * to the raw fact ID. QUA-397: a `|| f.factId` fallback in multiple sites
 * was baking `f_xxx` / legacy hex strings into user-visible strings in
 * the `things` table and CLI output. Centralized here so the unsafe
 * fallback chain cannot be reintroduced piecemeal.
 *
 * Fallback chain: `label` → `measure` (propertyId slug) → `"fact"`.
 * Duck-typed to accept both `Fact` and wiki-server response DTOs.
 */
export function formatFactLabel(f: {
  label?: string | null;
  measure?: string | null;
}): string {
  return f.label || f.measure || "fact";
}

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

// ── Adaptive divisor helpers ─────────────────────────────────────────

/** Scale steps: each entry is [divisor, suffix]. Order: largest first. */
const SCALE_STEPS: [number, string][] = [
  [1e12, "T"],
  [1e9, "B"],
  [1e6, "M"],
  [1e3, "K"],
];

/**
 * When the configured divisor produces a value that rounds to 0,
 * step down to a smaller scale that produces a meaningful number.
 *
 * Only steps down through standard scales (T/B/M/K). If the suffix
 * isn't a recognized scale suffix, returns the original values unchanged
 * (non-standard display configs should not be silently rewritten).
 */
function adaptiveDivisor(
  value: number,
  originalDivisor: number,
  originalSuffix: string,
): { divided: number; suffix: string } {
  const trimmedSuffix = originalSuffix.trim();

  // Only adapt for recognized scale suffixes
  const isScaleSuffix = SCALE_STEPS.some(([, s]) => s === trimmedSuffix);
  if (!isScaleSuffix) {
    return { divided: value / originalDivisor, suffix: originalSuffix };
  }

  // Find the first scale that produces a non-zero formatted value
  for (const [div, suf] of SCALE_STEPS) {
    if (div >= originalDivisor) continue; // skip same or larger scales
    const divided = value / div;
    if (Math.abs(divided) >= 0.1) {
      return { divided, suffix: suf };
    }
  }

  // No scale worked — return raw value with no suffix
  return { divided: value, suffix: "" };
}

/** Format a divided numeric value with appropriate decimal places. */
function formatDivided(divided: number): string {
  if (Math.abs(divided) >= 100) {
    return divided.toLocaleString("en-US", { maximumFractionDigits: 0 });
  }
  return divided.toLocaleString("en-US", { maximumFractionDigits: 1 });
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
    let effectiveSuffix = suffix ?? "";
    if (divisor && Number.isFinite(divisor)) {
      const divided = value / divisor;
      // If the divided value is too small to display meaningfully, fall back
      // to a smaller scale. Threshold 0.1 catches both the "$0B" bug (values
      // that round to zero) and marginal "$0.1B" cases that read better as "$50M".
      const wouldBeZero = Math.abs(divided) > 0 && Math.abs(divided) < 0.1;
      if (wouldBeZero) {
        const result = adaptiveDivisor(value, divisor, effectiveSuffix);
        formatted = formatDivided(result.divided);
        effectiveSuffix = result.suffix;
      } else {
        formatted = formatDivided(divided);
      }
    } else {
      // No divisor: use raw number without locale grouping separators.
      // This handles cases like "born-year: 1983" where commas would be wrong.
      formatted = String(value);
    }
    return `${effectivePrefix}${formatted}${effectiveSuffix}`;
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
 * Resolve an entity ID to its display name, falling back to the input.
 */
export function resolveRefName(entityId: string, graph: Graph): string {
  const entity = graph.getEntity(entityId);
  return entity ? entity.name : entityId;
}

