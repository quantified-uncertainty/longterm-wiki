/**
 * Metrics Sync to Wiki-Server
 *
 * Syncs coverage, rankings, update schedule, and similarity data
 * to the wiki-server at build time. Also collects and syncs link signals
 * and refreshes the related graph materialized view.
 *
 * Extracted from build-data.mjs for modularity.
 */

import { syncCoverage, syncSchedule, syncRankings, syncSimilarity } from './build-metrics-client.mjs';
import { syncPageLinks, refreshRelatedGraph } from './links-client.mjs';

/**
 * Sync all build metrics (coverage, rankings, schedule, similarity) to wiki-server.
 * Fire-and-forget: build continues even if wiki-server is unreachable.
 *
 * @param {object} opts
 * @param {Array<object>} opts.pages - All page objects (with coverage, rankings, redundancy)
 * @param {Array<object>} opts.updateScheduleItems - Schedule items from buildUpdateSchedule
 */
export async function syncBuildMetrics({ pages, updateScheduleItems }) {
  console.log('  Syncing build metrics to wiki-server...');

  // 1. Coverage
  const coverageItems = pages
    .filter(p => p.coverage)
    .map(p => ({
      pageId: p.id,
      passing: p.coverage.passing,
      total: p.coverage.total,
      items: p.coverage.items,
    }));
  const coverageResult = await syncCoverage(coverageItems);
  if (coverageResult.ok) {
    console.log(`  coverageSync: updated ${coverageResult.data.updated} pages`);
  } else {
    console.log(`  coverageSync: skipped (${coverageResult.message || 'server unavailable'})`);
  }

  // 2. Rankings
  const rankingItems = pages
    .filter(p => p.readerRank != null || p.researchRank != null || p.recommendedScore != null)
    .map(p => ({
      pageId: p.id,
      readerRank: p.readerRank ?? null,
      researchRank: p.researchRank ?? null,
      recommendedScore: p.recommendedScore ?? null,
    }));
  const rankingsResult = await syncRankings(rankingItems);
  if (rankingsResult.ok) {
    console.log(`  rankingsSync: updated ${rankingsResult.data.updated} pages`);
  } else {
    console.log(`  rankingsSync: skipped (${rankingsResult.message || 'server unavailable'})`);
  }

  // 3. Update schedule
  const scheduleItems = updateScheduleItems.map(item => ({
    pageId: item.id,
    updateFrequency: item.updateFrequency,
    daysSinceUpdate: item.daysSinceUpdate,
    daysUntilDue: item.daysUntilDue,
    staleness: item.staleness,
    priority: item.priority,
  }));
  if (scheduleItems.length > 0) {
    const scheduleResult = await syncSchedule(scheduleItems);
    if (scheduleResult.ok) {
      console.log(`  scheduleSync: updated ${scheduleResult.data.updated} pages`);
    } else {
      console.log(`  scheduleSync: skipped (${scheduleResult.message || 'server unavailable'})`);
    }
  }

  // 4. Similarity (from redundancy data)
  const similarityPairs = [];
  for (const page of pages) {
    if (!page.redundancy?.similarPages) continue;
    for (let rank = 0; rank < page.redundancy.similarPages.length; rank++) {
      const sp = page.redundancy.similarPages[rank];
      similarityPairs.push({
        pageId: page.id,
        similarPageId: sp.id,
        similarity: sp.similarity,
        rank: rank + 1,
      });
    }
  }
  const similarityResult = await syncSimilarity(similarityPairs);
  if (similarityResult.ok) {
    console.log(`  similaritySync: upserted ${similarityResult.data.upserted} pairs`);
  } else {
    console.log(`  similaritySync: skipped (${similarityResult.message || 'server unavailable'})`);
  }
}

/**
 * Sync link signals to wiki-server and refresh the related graph materialized view.
 *
 * @param {Array<object>} linkSignals - Link signal objects from collectLinkSignals
 */
export async function syncLinksAndRefreshGraph(linkSignals) {
  console.log(`  linkSignals: ${linkSignals.length} link signals collected for server sync`);
  const linkResult = await syncPageLinks(linkSignals);
  if (linkResult.ok) {
    console.log(`  linkSync: synced ${linkResult.data.upserted} links to wiki server`);
    // Refresh the materialized view after link sync completes
    const refreshResult = await refreshRelatedGraph();
    if (refreshResult.ok) {
      console.log(`  relatedGraphRefresh: materialized view refreshed`);
    } else {
      console.log(`  relatedGraphRefresh: skipped (${refreshResult.message || 'server unavailable or error'})`);
    }
  } else {
    console.log(`  linkSync: skipped (${linkResult.message || 'server unavailable or error'})`);
  }
}
