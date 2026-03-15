/**
 * Hallucination risk stats and citation quote lookups.
 */

import { getDatabase, getEntityBundle, resolveId, fetchFromWikiServer, withApiFallback } from "./tablebase";

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
 * Get build-time citation quotes for a page.
 * Tries per-entity bundle first, falls back to database.json.
 * Returns undefined if no citation data was bundled at build time.
 */
export function getLocalCitationQuotes(pageId: string) {
  // Try per-entity bundle first (avoids loading full database.json)
  const bundle = getEntityBundle(pageId);
  if (bundle?.citationQuotes) return bundle.citationQuotes;
  // DB keys are slugs, so resolve numeric IDs (e.g. E123) to slugs
  return getDatabase().citationQuotes?.[resolveId(pageId)];
}

