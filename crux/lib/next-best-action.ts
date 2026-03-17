/**
 * Next Best Action — Priority scoring for wiki pages.
 *
 * Combines importance, quality deficit, staleness, and hallucination risk
 * into a single actionable ranking that identifies which pages would
 * benefit most from editorial attention.
 *
 * Formula:
 *   priority = importance × qualityDeficit × stalenessFactor × hallucinationRiskFactor
 *
 * Where:
 *   importance = max(readerImportance, researchImportance) / 100, clamped [0, 1]
 *   qualityDeficit = 1 - (quality / 100), clamped [0, 1]
 *   stalenessFactor = 1 + min(daysSinceUpdate / 365, 1.0)
 *   hallucinationRiskFactor = 1 + (high: 0.5, medium: 0.25, low: 0)
 */

export interface NextBestActionScore {
  id: string;
  numericId: string;
  title: string;
  entityType: string | null;
  priority: number;
  // Component values for transparency
  importance: number;
  qualityDeficit: number;
  stalenessFactor: number;
  hallucinationRiskFactor: number;
  // Raw inputs
  quality: number | null;
  readerImportance: number | null;
  researchImportance: number | null;
  daysSinceUpdate: number;
  riskLevel: 'low' | 'medium' | 'high' | null;
  wordCount: number;
  // Human-readable reason
  reasons: string[];
}

export interface PageInput {
  id: string;
  numericId?: string;
  title: string;
  entityType?: string | null;
  quality: number | null;
  readerImportance: number | null;
  researchImportance: number | null;
  lastUpdated: string | null;
  hallucinationRisk?: {
    level: 'low' | 'medium' | 'high';
    score: number;
    factors: string[];
  } | null;
  wordCount?: number;
  contentFormat?: string;
  subcategory?: string | null;
}

function daysSince(dateStr: string | null): number {
  if (!dateStr) return 999;
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? 999 : Math.round((Date.now() - d.getTime()) / 86400000);
}

/**
 * Compute the Next Best Action priority score for a single page.
 */
export function computeNBA(page: PageInput): NextBestActionScore {
  const quality = page.quality ?? 0;
  const readerImp = page.readerImportance ?? 0;
  const researchImp = page.researchImportance ?? 0;
  const days = daysSince(page.lastUpdated);
  const riskLevel = page.hallucinationRisk?.level ?? null;
  const wc = page.wordCount ?? 0;

  // importance: max of reader and research importance, normalized 0-1
  const importance = Math.min(Math.max(readerImp, researchImp) / 100, 1);

  // qualityDeficit: how far quality is from 100, normalized 0-1
  const qualityDeficit = 1 - Math.min(quality / 100, 1);

  // stalenessFactor: 1.0 for just-updated, up to 2.0 for 365+ days stale
  const stalenessFactor = 1 + Math.min(days / 365, 1.0);

  // hallucinationRiskFactor: boost for risky pages
  const riskBoost = riskLevel === 'high' ? 0.5 : riskLevel === 'medium' ? 0.25 : 0;
  const hallucinationRiskFactor = 1 + riskBoost;

  const priority = importance * qualityDeficit * stalenessFactor * hallucinationRiskFactor;

  // Build human-readable reasons
  const reasons: string[] = [];
  if (importance >= 0.7) reasons.push('high importance');
  else if (importance >= 0.4) reasons.push('moderate importance');
  if (quality < 30) reasons.push(`low quality (${quality})`);
  else if (quality < 50) reasons.push(`quality ${quality}`);
  if (days > 365) reasons.push(`${days}d stale`);
  else if (days > 180) reasons.push(`${days}d since update`);
  if (riskLevel === 'high') reasons.push('high hallucination risk');
  else if (riskLevel === 'medium') reasons.push('medium hallucination risk');
  if (wc < 200 && wc > 0) reasons.push(`stub (${wc}w)`);

  return {
    id: page.id,
    numericId: page.numericId ?? page.id,
    title: page.title,
    entityType: page.entityType ?? null,
    priority: Math.round(priority * 1000) / 1000,
    importance,
    qualityDeficit,
    stalenessFactor,
    hallucinationRiskFactor,
    quality: page.quality,
    readerImportance: page.readerImportance,
    researchImportance: page.researchImportance,
    daysSinceUpdate: days,
    riskLevel,
    wordCount: wc,
    reasons,
  };
}

/**
 * Compute NBA scores for a batch of pages, sorted by priority descending.
 * Filters out dashboards, index pages, and pages with no importance data.
 */
export function computeNBABatch(
  pages: PageInput[],
  opts?: { includeNoImportance?: boolean; entityType?: string }
): NextBestActionScore[] {
  const results: NextBestActionScore[] = [];

  for (const page of pages) {
    // Skip dashboards and index pages
    if (page.contentFormat === 'dashboard' || page.contentFormat === 'index') continue;
    if (page.subcategory === 'dashboards') continue;

    // Filter by entity type if specified
    if (opts?.entityType && page.entityType !== opts.entityType) continue;

    // Skip pages with zero importance unless opted in
    if (!opts?.includeNoImportance) {
      if ((page.readerImportance ?? 0) === 0 && (page.researchImportance ?? 0) === 0) continue;
    }

    results.push(computeNBA(page));
  }

  return results.sort((a, b) => b.priority - a.priority);
}
