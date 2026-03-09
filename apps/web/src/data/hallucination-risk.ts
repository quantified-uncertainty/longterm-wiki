/**
 * Hallucination risk stats and citation quote lookups.
 */

import { getDatabase, fetchFromWikiServer, withApiFallback } from "./database";

export interface RiskStats {
  total: number;
  high: number;
  medium: number;
  low: number;
  avgScore: number;
  topFactors: Array<{ factor: string; count: number }>;
}

export async function getRiskStats(): Promise<RiskStats | null> {
  const result = await withApiFallback(
    () => fetchFromWikiServer<RiskStats>(`/api/hallucination-risk/stats`),
    () => getDatabase().riskStats ?? null
  );
  return result.data;
}

/**
 * Get build-time citation quotes for a page from database.json.
 * Returns undefined if no citation data was bundled at build time.
 */
export function getLocalCitationQuotes(pageId: string) {
  return getDatabase().citationQuotes?.[pageId];
}

/**
 * Get build-time statement citation dot data for a page from database.json.
 * Keyed by page slug (not numeric ID). Returns undefined if no data was bundled.
 * Each entry uses footnoteResourceId (e.g. "cr-abc123") instead of numeric footnote numbers;
 * callers must resolve to numeric footnotes via the referenceMap from renderMdxPage().
 */
export function getStatementCitationDots(pageId: string) {
  return getDatabase().statementCitationDots?.[pageId];
}
