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
  /** Resource ID for linking to /resources/:id (from resource_tabular_sources) */
  resourceId?: string;
}

const DATA_SOURCE_PATTERNS: DataSourcePattern[] = [
  { id: "coefficient-giving", name: "Coefficient Giving", urlPatterns: ["coefficientgiving"], resourceId: "28c67bc404f6c25d" },
  { id: "ea-funds", name: "EA Funds", urlPatterns: ["effectivealtruism.org", "funds.effectivealtruism"], resourceId: "5184e8852ca7d7ca" },
  { id: "sff", name: "SFF", urlPatterns: ["survivalandflourishing"], resourceId: "aebe92781f2a19fb" },
  { id: "manifund", name: "Manifund", urlPatterns: ["manifund.org"], resourceId: "730c915c44d4b0ac" },
  { id: "gates-foundation", name: "Gates Foundation", urlPatterns: ["gatesfoundation.org"], resourceId: "cc984fc131dd1da7" },
  { id: "givewell", name: "GiveWell", urlPatterns: ["givewell.org"], resourceId: "dc7030557c848c8e" },
  { id: "fli", name: "FLI", urlPatterns: ["futureoflife.org"], resourceId: "c68ee9dfc25974f5" },
  { id: "acx-grants", name: "ACX Grants", urlPatterns: ["astralcodexten"], resourceId: "ad3e2027a89d9818" },
  { id: "ftx-future-fund", name: "FTX Future Fund", urlPatterns: ["ftxfuturefund", "ftx.com"], resourceId: "51d2d9250927456f" },
  { id: "aria", name: "ARIA", urlPatterns: ["aria.org.uk"], resourceId: "2cc177984ead7389" },
  { id: "wellcome-trust", name: "Wellcome Trust", urlPatterns: ["wellcome.org"], resourceId: "fc1380b4b0518984" },
  { id: "ford-foundation", name: "Ford Foundation", urlPatterns: ["fordfoundation.org"], resourceId: "d46dc33faca63684" },
  { id: "vipulnaik", name: "Vipul Naik", urlPatterns: ["vipulnaik.com", "donations.vipulnaik"], resourceId: "6e463743cbca7db9" },
  { id: "foresight-prizes", name: "Foresight Prizes", urlPatterns: ["foresight.org"], resourceId: "ac3eb94ecd5ab914" },
];

export interface DataSourceInfo {
  id: string;
  name: string;
  resourceId?: string;
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
      return { id: pattern.id, name: pattern.name, resourceId: pattern.resourceId };
    }
  }
  return null;
}

