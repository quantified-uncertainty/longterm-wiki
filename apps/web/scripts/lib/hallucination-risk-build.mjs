/**
 * Hallucination Risk Builder
 *
 * Computes per-page risk scores and aggregated risk stats.
 * Optionally records snapshots to wiki-server.
 *
 * Extracted from build-data.mjs for modularity.
 */

import { recordRiskSnapshots } from './risk-client.mjs';

/**
 * Compute hallucination risk for all pages and build aggregated stats.
 * Mutates pages in-place (adds hallucinationRisk, entityType).
 *
 * @param {object} opts
 * @param {Array<object>} opts.pages
 * @param {Map<string, object>} opts.entityMap
 * @param {(page: object, entityMap: Map) => object} opts.computeRisk - Risk computation function
 * @param {(type: string) => string} opts.resolveEntityType - Entity type resolver
 * @returns {{ riskHigh: number, riskMedium: number, riskLow: number, riskStats: object }}
 */
export function computeAllHallucinationRisks({ pages, entityMap, computeRisk, resolveEntityType }) {
  console.log('  Computing hallucination risk scores...');
  let riskHigh = 0, riskMedium = 0, riskLow = 0;

  for (const page of pages) {
    const risk = computeRisk(page, entityMap);
    page.hallucinationRisk = risk;

    // Attach resolved entityType for frontend use
    const entity = entityMap.get(page.id);
    if (entity?.type) {
      page.entityType = resolveEntityType(entity.type);
    } else if (page.category === 'internal') {
      page.entityType = 'internal';
    }

    if (risk.level === 'high') riskHigh++;
    else if (risk.level === 'medium') riskMedium++;
    else riskLow++;
  }

  console.log(`  hallucinationRisk: ${riskHigh} high, ${riskMedium} medium, ${riskLow} low`);

  // Pre-aggregate risk stats for the dashboard
  const riskFactorCounts = {};
  let riskScoreSum = 0;
  const riskTotal = riskHigh + riskMedium + riskLow;

  for (const page of pages) {
    if (!page.hallucinationRisk) continue;
    riskScoreSum += page.hallucinationRisk.score;
    for (const f of page.hallucinationRisk.factors || []) {
      riskFactorCounts[f] = (riskFactorCounts[f] || 0) + 1;
    }
  }

  const riskStats = {
    total: riskTotal,
    high: riskHigh,
    medium: riskMedium,
    low: riskLow,
    avgScore: riskTotal > 0 ? Math.round(riskScoreSum / riskTotal) : 0,
    topFactors: Object.entries(riskFactorCounts)
      .sort(([, a], [, b]) => /** @type {number} */ (b) - /** @type {number} */ (a))
      .slice(0, 10)
      .map(([factor, count]) => ({ factor, count })),
  };

  return { riskHigh, riskMedium, riskLow, riskStats };
}

/**
 * Record risk snapshots to wiki-server (optional).
 * @param {Array<object>} pages
 * @param {boolean} contentOnly
 */
export async function syncRiskSnapshots(pages, contentOnly) {
  if (contentOnly) {
    console.log('  riskSnapshots: skipped (content-only scope)');
    return;
  }

  if (!process.env.LONGTERMWIKI_SERVER_URL) return;

  const snapshots = pages
    .filter(p => p.hallucinationRisk)
    .map(p => ({
      pageId: p.id,
      score: p.hallucinationRisk.score,
      level: p.hallucinationRisk.level,
      factors: p.hallucinationRisk.factors,
      integrityIssues: p.hallucinationRisk.integrityIssues || null,
    }));

  const result = await recordRiskSnapshots(snapshots);
  if (result) {
    console.log(`  riskSnapshots: recorded ${result.inserted} snapshots to wiki server`);
  } else {
    console.log('  riskSnapshots: skipped (server unavailable or error)');
  }
}
