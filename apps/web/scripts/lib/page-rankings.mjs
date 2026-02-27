/**
 * Page Rankings & Schedule Builder
 *
 * Computes page rankings (reader/research), recommended scores,
 * and update schedule items. Pure functions — no I/O.
 *
 * Extracted from build-data.mjs for modularity.
 */

/**
 * Compute readerRank and researchRank for each page.
 * Mutates pages in-place.
 * @param {Array<{readerImportance?: number, researchImportance?: number, readerRank?: number, researchRank?: number}>} pages
 * @returns {{ readerRanked: number, researchRanked: number }}
 */
export function computePageRankings(pages) {
  const rankedPages = pages.filter(p => p.readerImportance != null || p.researchImportance != null);

  const byReader = rankedPages
    .filter(p => p.readerImportance != null)
    .sort((a, b) => (b.readerImportance ?? 0) - (a.readerImportance ?? 0));
  byReader.forEach((page, idx) => { page.readerRank = idx + 1; });

  const byResearch = rankedPages
    .filter(p => p.researchImportance != null)
    .sort((a, b) => (b.researchImportance ?? 0) - (a.researchImportance ?? 0));
  byResearch.forEach((page, idx) => { page.researchRank = idx + 1; });

  return { readerRanked: byReader.length, researchRanked: byResearch.length };
}

/**
 * Compute recommended score for each page.
 * Mutates pages in-place.
 * @param {Array<{lastUpdated?: string, quality?: number, readerImportance?: number, wordCount?: number, recommendedScore?: number}>} pages
 * @param {number} buildNow - Date.now() at build time
 * @returns {void}
 */
export function computeRecommendedScores(pages, buildNow) {
  for (const page of pages) {
    let recency = 0;
    if (page.lastUpdated) {
      const daysAgo = (buildNow - new Date(page.lastUpdated).getTime()) / 86_400_000;
      recency = 10 * Math.exp(-daysAgo / 120);
    }
    const quality = page.quality || 0;
    const importance = page.readerImportance || 0;
    const wordBonus = page.wordCount ? Math.min(2, Math.log10(page.wordCount + 1) - 1.5) : 0;
    page.recommendedScore = Math.round((recency * 2 + quality * 2 + importance * 0.5 + wordBonus) * 100) / 100;
  }
}

/**
 * Build the update schedule — per-page staleness, priority, daysSince/daysUntil.
 * @param {Array<object>} pages
 * @param {Record<string, string>} slugToNumericId
 * @param {number} buildNow - Date.now() at build time
 * @returns {Array<object>} Sorted by priority (descending)
 */
export function buildUpdateSchedule(pages, slugToNumericId, buildNow) {
  const items = [];

  for (const page of pages) {
    if (!page.updateFrequency) continue;
    if (page.evergreen === false) continue;

    const lastUpdated = page.lastUpdated;
    const daysSince = lastUpdated
      ? Math.floor((buildNow - new Date(lastUpdated).getTime()) / (1000 * 60 * 60 * 24))
      : 999;
    const daysUntil = page.updateFrequency - daysSince;
    const staleness = daysSince / page.updateFrequency;
    const readerImp = page.readerImportance ?? 50;
    const tv = page.tacticalValue ?? 0;
    const effectiveImportance = tv > readerImp ? (readerImp + tv) / 2 : readerImp;
    const priority = staleness * (effectiveImportance / 100);

    items.push({
      id: page.id,
      numericId: slugToNumericId[page.id] || page.id,
      title: page.title,
      quality: page.quality ?? null,
      readerImportance: page.readerImportance ?? null,
      lastUpdated,
      updateFrequency: page.updateFrequency,
      daysSinceUpdate: daysSince,
      daysUntilDue: daysUntil,
      staleness: Math.round(staleness * 100) / 100,
      priority: Math.round(priority * 100) / 100,
      category: page.category,
    });
  }

  items.sort((a, b) => b.priority - a.priority);
  return items;
}
