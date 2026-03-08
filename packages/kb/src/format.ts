/**
 * Shared formatting utilities for KB data.
 *
 * Used by CLI tools, frontend components, and any other consumer
 * that needs human-readable representations of KB values.
 */

import type { Fact, Property, ItemEntry } from "./types";
import type { Graph } from "./graph";

// ── Monetary formatting ─────────────────────────────────────────────

/**
 * Format a monetary amount in a compact human-readable form.
 * e.g. 1_500_000_000 → "$1.5B", -5_000_000_000 → "-$5.0B"
 */
export function formatMoney(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(1)}T`;
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(0)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs}`;
}

// ── Value formatting ────────────────────────────────────────────────

/**
 * Format a numeric value using a property's display config.
 * Falls back to locale-formatted number if no display config exists.
 */
export function formatValue(value: unknown, property?: Property): string {
  if (value === null || value === undefined) return "(none)";

  if (typeof value === "number" && property?.display) {
    const { divisor, prefix, suffix } = property.display;
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
    return `${prefix ?? ""}${formatted}${suffix ?? ""}`;
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
    return formatValue(val.value, property);
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
 * Resolve an entity slug to its display name, falling back to the slug.
 */
export function resolveRefName(slug: string, graph: Graph): string {
  const entity = graph.getEntity(slug);
  return entity ? entity.name : slug;
}

// ── Item formatting ─────────────────────────────────────────────────

/**
 * Format a single item entry for display.
 * Uses the collection name to apply property-specific formatting
 * (e.g., funding rounds show amount + valuation, key-people show role + dates).
 */
export function formatItemEntry(
  item: ItemEntry,
  collectionName: string,
  graph: Graph
): string {
  const f = item.fields;

  switch (collectionName) {
    case "funding-rounds": {
      const date = f.date ?? "";
      const amount =
        typeof f.amount === "number" ? formatMoney(f.amount) : "";
      const valuation =
        typeof f.valuation === "number"
          ? ` @ ${formatMoney(f.valuation)}`
          : "";
      const lead = f.lead_investor
        ? resolveRefName(String(f.lead_investor), graph)
        : "";
      const leadStr = lead ? `  lead: ${lead}` : "";
      return `${date}  ${amount}${valuation}${leadStr}`;
    }

    case "key-people": {
      const person = f.person
        ? resolveRefName(String(f.person), graph)
        : "(unknown)";
      const title = f.title ?? "";
      const start = f.start ?? "";
      const end = f.end ?? "present";
      const founder = f.is_founder ? ", founder" : "";
      return `${person} -- ${title} (${start}--${end}${founder})`;
    }

    case "products": {
      const name = f.name ?? item.key;
      const launched = f.launched ?? "";
      const desc = f.description ? ` - ${f.description}` : "";
      return `${launched}  ${name}${desc}`;
    }

    case "model-releases": {
      const name = f.name ?? item.key;
      const released = f.released ?? "";
      const safety = f.safety_level ? ` [${f.safety_level}]` : "";
      const desc = f.description ? ` - ${f.description}` : "";
      return `${released}  ${name}${safety}${desc}`;
    }

    case "board-members": {
      const name = f.name ?? item.key;
      const role = f.role ? ` -- ${f.role}` : "";
      const appointed = f.appointed ? ` (${f.appointed})` : "";
      return `${name}${role}${appointed}`;
    }

    case "strategic-partnerships": {
      const partner = f.partner ?? item.key;
      const date = f.date ?? "";
      const type = f.type ? ` [${f.type}]` : "";
      const investAmount =
        typeof f.investment_amount === "number"
          ? ` ${formatMoney(f.investment_amount)}`
          : "";
      return `${date}  ${partner}${type}${investAmount}`;
    }

    case "safety-milestones": {
      const name = f.name ?? item.key;
      const date = f.date ?? "";
      const type = f.type ? ` [${f.type}]` : "";
      return `${date}  ${name}${type}`;
    }

    case "research-areas": {
      const name = f.name ?? item.key;
      const desc = f.description ? ` - ${f.description}` : "";
      return `${name}${desc}`;
    }

    default: {
      const parts = Object.entries(f)
        .filter(([_, v]) => v !== null && v !== undefined)
        .map(([k, v]) => `${k}: ${String(v)}`);
      return parts.join(", ");
    }
  }
}
