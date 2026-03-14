/**
 * Shared utilities for /risks routes.
 * Delegates to generic directory-utils for entity resolution.
 */
import { resolveEntityBySlug, getEntitySlugs } from "@/lib/directory-utils";
import type { Entity } from "@longterm-wiki/kb";
import { titleCase } from "@/components/wiki/kb/format";
import type { RiskEntity } from "@/data/entity-schemas";

/** Resolve a URL slug to a KB risk entity. */
export function resolveRiskBySlug(slug: string): Entity | undefined {
  return resolveEntityBySlug(slug, "risk");
}

/** Get all risk slugs for generateStaticParams. */
export function getRiskSlugs(): string[] {
  return getEntitySlugs("risk");
}

/**
 * Extract a display string from a likelihood field (string or object).
 *
 * Returns the most complete representation, including status in parentheses
 * when present (e.g. "High (increasing)").
 */
export function getLikelihoodDisplay(
  likelihood: RiskEntity["likelihood"],
): string | null {
  if (!likelihood) return null;
  if (typeof likelihood === "string") return titleCase(likelihood);
  if (likelihood.display) return likelihood.display;
  const parts: string[] = [];
  if (likelihood.level) parts.push(titleCase(likelihood.level));
  if (likelihood.status) parts.push(`(${likelihood.status})`);
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * Extract a display string from a timeframe field (string or object).
 *
 * Returns the most complete representation, including both range and median
 * when available (e.g. "2025-2030 (median 2028)").
 */
export function getTimeframeDisplay(
  timeframe: RiskEntity["timeframe"],
): string | null {
  if (!timeframe) return null;
  if (typeof timeframe === "string") return timeframe;
  if (timeframe.display) return timeframe.display;
  const parts: string[] = [];
  if (timeframe.earliest && timeframe.latest) {
    parts.push(`${timeframe.earliest}\u2013${timeframe.latest}`);
  }
  if (timeframe.median) {
    if (parts.length > 0) {
      parts.push(`(median ${timeframe.median})`);
    } else {
      parts.push(`~${timeframe.median}`);
    }
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * Extract the earliest numeric year from a timeframe string for sorting.
 *
 * Examples:
 *   "~2030" → 2030
 *   "2025-2030" → 2025
 *   "2025–2030" → 2025 (en-dash)
 *   "By 2040" → 2040
 *   "unknown" → null
 */
// extractEarliestYear moved to risk-constants.ts (client-safe)
export { extractEarliestYear } from "./risk-constants";
