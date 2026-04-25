/**
 * Pure aggregation helpers for the matrix view. Extracted so they can be
 * unit-tested independently of fetch / render.
 */

import {
  CANONICAL_RISK_DOMAINS,
  type CanonicalRiskDomain,
} from "@/app/frontier-safety-frameworks/risk-domain-constants";
import type { ThresholdRow } from "@/app/frontier-safety-frameworks/frameworks-data";

export interface MatrixCell {
  /** Highest tier_label found for (framework version × domain). */
  tierLabel: string;
  /** tier_sort_order of that highest tier (1-5). Drives color. */
  tierSortOrder: number;
  /** Total threshold rows in this cell (≥1). */
  count: number;
  /** Whether at least one row in this cell is human-reviewed. */
  reviewed: boolean;
}

/**
 * Reduces a flat list of threshold rows for a single version into
 * (canonicalDomain → most-severe MatrixCell). The "most severe" cell is the
 * one with the highest `tier_sort_order`. Ties resolve to the row with
 * `human_reviewed=true` first, then to first occurrence in the input.
 */
export function rowsToCellsForVersion(
  rows: readonly ThresholdRow[],
): Partial<Record<CanonicalRiskDomain, MatrixCell>> {
  const cells: Partial<Record<CanonicalRiskDomain, MatrixCell>> = {};

  for (const row of rows) {
    const domain = row.riskDomainCanonical;
    const existing = cells[domain];
    if (!existing) {
      cells[domain] = {
        tierLabel: row.tierLabel,
        tierSortOrder: row.tierSortOrder,
        count: 1,
        reviewed: row.humanReviewed,
      };
      continue;
    }
    const priorReviewed = existing.reviewed;
    existing.count += 1;
    existing.reviewed = priorReviewed || row.humanReviewed;
    if (
      row.tierSortOrder > existing.tierSortOrder ||
      (row.tierSortOrder === existing.tierSortOrder &&
        row.humanReviewed &&
        !priorReviewed)
    ) {
      existing.tierLabel = row.tierLabel;
      existing.tierSortOrder = row.tierSortOrder;
    }
  }

  return cells;
}

/**
 * Returns the ordered list of canonical domains that appear in any of the
 * provided cell maps. Uses CANONICAL_RISK_DOMAINS order and drops empty
 * columns to keep the matrix compact when only a few domains are populated.
 */
export function activeDomains(
  cellsByVersion: Iterable<Partial<Record<CanonicalRiskDomain, MatrixCell>>>,
): CanonicalRiskDomain[] {
  const seen = new Set<CanonicalRiskDomain>();
  for (const cells of cellsByVersion) {
    for (const domain of CANONICAL_RISK_DOMAINS) {
      if (cells[domain]) seen.add(domain);
    }
  }
  return CANONICAL_RISK_DOMAINS.filter((d) => seen.has(d));
}
