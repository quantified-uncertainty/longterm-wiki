/**
 * Maps grant source URLs to data source IDs.
 * Used to enrich FactBase grant records (which have source URLs)
 * with structured data source identifiers for filtering and linking.
 *
 * These patterns are derived from the grant import manifests
 * (crux/lib/grant-import/manifests/index.ts).
 */

interface DataSourcePattern {
  id: string;
  name: string;
  /** URL substrings to match against the grant's source field */
  urlPatterns: string[];
}

const DATA_SOURCE_PATTERNS: DataSourcePattern[] = [
  { id: "coefficient-giving", name: "Coefficient Giving", urlPatterns: ["coefficientgiving"] },
  { id: "ea-funds", name: "EA Funds", urlPatterns: ["effectivealtruism.org", "funds.effectivealtruism"] },
  { id: "sff", name: "SFF", urlPatterns: ["survivalandflourishing"] },
  { id: "manifund", name: "Manifund", urlPatterns: ["manifund.org"] },
  { id: "gates-foundation", name: "Gates Foundation", urlPatterns: ["gatesfoundation.org"] },
  { id: "givewell", name: "GiveWell", urlPatterns: ["givewell.org"] },
  { id: "fli", name: "FLI", urlPatterns: ["futureoflife.org"] },
  { id: "acx-grants", name: "ACX Grants", urlPatterns: ["astralcodexten"] },
  { id: "ftx-future-fund", name: "FTX Future Fund", urlPatterns: ["ftxfuturefund", "ftx.com"] },
  { id: "aria", name: "ARIA", urlPatterns: ["aria.org.uk"] },
  { id: "wellcome-trust", name: "Wellcome Trust", urlPatterns: ["wellcome.org"] },
  { id: "ford-foundation", name: "Ford Foundation", urlPatterns: ["fordfoundation.org"] },
  { id: "vipulnaik", name: "Vipul Naik", urlPatterns: ["vipulnaik.com", "donations.vipulnaik"] },
  { id: "foresight-prizes", name: "Foresight Prizes", urlPatterns: ["foresight.org"] },
];

export interface DataSourceInfo {
  id: string;
  name: string;
}

/**
 * Infer the data source from a grant's source URL.
 * Returns null if no pattern matches.
 */
export function inferDataSource(sourceUrl: string | null): DataSourceInfo | null {
  if (!sourceUrl) return null;
  const lower = sourceUrl.toLowerCase();
  for (const pattern of DATA_SOURCE_PATTERNS) {
    if (pattern.urlPatterns.some((p) => lower.includes(p))) {
      return { id: pattern.id, name: pattern.name };
    }
  }
  return null;
}

