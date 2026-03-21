/**
 * Hallucination risk stats and citation quote lookups.
 */

import { getTableBase, getEntityBundle, fetchFromWikiServer, withApiFallback } from "./tablebase";

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
    () => getTableBase().riskStats ?? null
  );
  return result.data;
}

/**
 * Get build-time citation quotes for a page.
 * Reads from per-entity bundle only — no longer in main database.json.
 * Returns undefined if no citation data was bundled at build time.
 */
export function getLocalCitationQuotes(pageId: string) {
  const bundle = getEntityBundle(pageId);
  return bundle?.citationQuotes;
}

