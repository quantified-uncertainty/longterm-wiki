/**
 * Auto-Update Orchestrator
 *
 * End-to-end pipeline: fetch feeds → build digest → route to pages → execute updates.
 *
 * This is the main entry point for both CLI and GitHub Actions usage.
 * Designed for unattended operation with budget controls and error recovery.
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { stringify as stringifyYaml } from 'yaml';
import { PROJECT_ROOT, loadPages } from '../lib/content-types.ts';
import { fetchAllSources, loadSeenItems, saveSeenItems } from './feed-fetcher.ts';
import { buildDigest, normalizeTitle } from './digest.ts';
import { routeDigest } from './page-router.ts';
import { getDueWatchlistUpdates, markWatchlistUpdated } from './watchlist.ts';
import type { AutoUpdateOptions, RunReport, RunResult, NewsDigest, UpdatePlan } from './types.ts';

const RUNS_DIR = join(PROJECT_ROOT, 'data/auto-update/runs');

// ── Entity ID Loading ───────────────────────────────────────────────────────

function loadEntityIds(): string[] {
  // Uses centralized loader which auto-builds the data layer if missing
  const pages = loadPages();
  return pages.map(p => p.id).filter((id): id is string => Boolean(id));
}

// ── Run Report Persistence ──────────────────────────────────────────────────

function saveRunReport(report: RunReport): string {
  mkdirSync(RUNS_DIR, { recursive: true });
  // Use date + time to avoid overwriting if run multiple times per day
  const timestamp = report.startedAt.replace(/[:.]/g, '-').slice(0, 19);
  const filename = `${timestamp}.yaml`;
  const filepath = join(RUNS_DIR, filename);
  writeFileSync(filepath, stringifyYaml(report, { lineWidth: 120 }));
  return filepath;
}

/**
 * Save digest + plan details alongside the run report for dashboard display.
 * These are larger files but essential for browsing news items and routing decisions.
 */
function saveRunDetails(startedAt: string, digest: NewsDigest, plan: UpdatePlan): void {
  const timestamp = startedAt.replace(/[:.]/g, '-').slice(0, 19);
  const filepath = join(RUNS_DIR, `${timestamp}-details.yaml`);
  writeFileSync(filepath, stringifyYaml({ digest, plan }, { lineWidth: 120 }));
}

// ── Page Improvement Execution ──────────────────────────────────────────────

function executePageImprove(
  pageId: string,
  tier: string,
  directions: string,
  verbose = false,
): RunResult {
  const start = Date.now();

  try {
    const args = [
      '--import', 'tsx/esm', '--no-warnings',
      'crux/authoring/page-improver/index.ts',
      '--', pageId,
      '--tier', tier,
      '--apply',
    ];

    if (directions) {
      args.push('--directions', directions);
    }

    if (verbose) {
      console.log(`    Running: node ${args.slice(0, 5).join(' ')} ... --tier ${tier}`);
    }

    execFileSync('node', args, {
      cwd: PROJECT_ROOT,
      timeout: 30 * 60 * 1000, // 30 min per page
      stdio: verbose ? 'inherit' : 'pipe',
    });

    return {
      pageId,
      status: 'success',
      tier,
      durationMs: Date.now() - start,
    };
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    return {
      pageId,
      status: 'failed',
      tier,
      error: error.message.slice(0, 300),
      durationMs: Date.now() - start,
    };
  }
}

// ── Validation ──────────────────────────────────────────────────────────────

function runValidation(verbose = false): boolean {
  try {
    execFileSync('node', [
      '--import', 'tsx/esm', '--no-warnings',
      'crux/crux.mjs', 'validate', 'gate', '--fix',
    ], {
      cwd: PROJECT_ROOT,
      timeout: 10 * 60 * 1000,
      stdio: verbose ? 'inherit' : 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

// ── Main Pipeline ───────────────────────────────────────────────────────────

export interface PipelineResult {
  report: RunReport;
  reportPath: string;
}

/**
 * Run the full auto-update pipeline.
 *
 * Stages:
 * 1. Fetch news from configured sources
 * 2. Build digest (dedupe, classify, filter)
 * 3. Route digest items to wiki pages
 * 4. Execute page improvements
 * 5. Run validation
 * 6. Save run report
 */
export async function runPipeline(options: AutoUpdateOptions = {}): Promise<PipelineResult> {
  const budget = parseFloat(options.budget || '50');
  const maxPages = parseInt(options.count || '10', 10);
  const dryRun = options.dryRun || false;
  const verbose = options.verbose || false;
  const trigger = options.trigger || 'manual';
  const sourceIds = options.sources ? options.sources.split(',').map(s => s.trim()) : undefined;

  const startedAt = new Date().toISOString();
  const date = startedAt.slice(0, 10);

  console.log(`\n=== Auto-Update Pipeline ===`);
  console.log(`Date: ${date} | Budget: $${budget} | Max pages: ${maxPages} | Dry run: ${dryRun}`);

  // ── Stage 1: Fetch ──────────────────────────────────────────────────────

  console.log(`\n── Stage 1: Fetching news sources ──`);
  const fetchResult = await fetchAllSources(sourceIds, verbose);
  console.log(`  Fetched: ${fetchResult.fetchedSources.length} sources, ${fetchResult.items.length} items`);
  if (fetchResult.failedSources.length > 0) {
    console.log(`  Failed: ${fetchResult.failedSources.map(f => f.id).join(', ')}`);
  }

  // ── Stage 2: Digest ─────────────────────────────────────────────────────

  console.log(`\n── Stage 2: Building news digest ──`);
  const entityIds = loadEntityIds();
  const previouslySeen = loadSeenItems();
  const digest = await buildDigest(
    fetchResult.items,
    fetchResult.fetchedSources,
    fetchResult.failedSources.map(f => f.id),
    { entityIds, previouslySeen, verbose },
  );
  console.log(`  Digest: ${digest.itemCount} relevant items`);

  // Record all digest items as seen for future runs
  if (digest.items.length > 0) {
    const now = new Date().toISOString().slice(0, 10);
    const newHashes: Record<string, string> = {};
    for (const item of digest.items) {
      const hash = normalizeTitle(item.title);
      if (hash.length >= 5) newHashes[hash] = now;
    }
    saveSeenItems(newHashes);
  }

  if (digest.itemCount === 0) {
    console.log(`\nNo relevant news found. Nothing to update.`);
    const report: RunReport = {
      date,
      startedAt,
      completedAt: new Date().toISOString(),
      trigger,
      budget: { limit: budget, spent: 0 },
      digest: {
        sourcesChecked: fetchResult.fetchedSources.length,
        sourcesFailed: fetchResult.failedSources.length,
        itemsFetched: fetchResult.items.length,
        itemsRelevant: 0,
      },
      plan: { pagesPlanned: 0, newPagesSuggested: 0 },
      execution: { pagesUpdated: 0, pagesFailed: 0, pagesSkipped: 0, results: [] },
      newPagesCreated: [],
    };
    const reportPath = saveRunReport(report);
    return { report, reportPath };
  }

  // Show top items
  if (verbose) {
    console.log(`\n  Top digest items:`);
    for (const item of digest.items.slice(0, 5)) {
      console.log(`    [${item.relevanceScore}] ${item.title}`);
    }
  }

  // ── Stage 3: Route ──────────────────────────────────────────────────────

  console.log(`\n── Stage 3: Routing to wiki pages ──`);
  const plan = await routeDigest(digest, {
    maxPages,
    maxBudget: budget,
    verbose,
  });

  // ── Watchlist Injection ────────────────────────────────────────────────────
  // Force-include pages scheduled for regular updates, regardless of news routing.
  const watchlistUpdates = getDueWatchlistUpdates(date, verbose);
  const watchlistPageIds: string[] = [];
  if (watchlistUpdates.length > 0) {
    console.log(`  Watchlist: ${watchlistUpdates.length} page(s) due for scheduled update`);
    const existingIds = new Set(plan.pageUpdates.map(u => u.pageId));
    for (const wu of watchlistUpdates) {
      watchlistPageIds.push(wu.pageId);
      if (existingIds.has(wu.pageId)) {
        // Merge directions into the existing news-driven entry
        const existing = plan.pageUpdates.find(u => u.pageId === wu.pageId)!;
        existing.directions = wu.directions + '\n\nAlso from news routing: ' + existing.directions;
        const tierRank: Record<string, number> = { polish: 1, standard: 2, deep: 3 };
        if (tierRank[wu.suggestedTier] > tierRank[existing.suggestedTier]) {
          existing.suggestedTier = wu.suggestedTier;
        }
      } else {
        // Insert at front of list so watchlist pages are prioritised
        plan.pageUpdates.unshift(wu);
      }
    }
  }

  console.log(`  Plan: ${plan.pageUpdates.length} page updates, ${plan.newPageSuggestions.length} new page suggestions`);
  console.log(`  Estimated cost: ~$${plan.estimatedCost.toFixed(0)}`);

  // Show the plan
  if (plan.pageUpdates.length > 0) {
    console.log(`\n  Planned updates:`);
    for (const update of plan.pageUpdates) {
      console.log(`    ${update.suggestedTier.padEnd(9)} ${update.pageTitle} — ${update.reason.slice(0, 80)}`);
    }
  }

  if (plan.newPageSuggestions.length > 0) {
    console.log(`\n  New page suggestions:`);
    for (const np of plan.newPageSuggestions) {
      console.log(`    ${np.suggestedTitle} — ${np.reason.slice(0, 80)}`);
    }
  }

  // Save digest + plan details for dashboard browsing
  saveRunDetails(startedAt, digest, plan);

  if (dryRun) {
    console.log(`\n── Dry run — stopping before execution ──`);
    const report: RunReport = {
      date,
      startedAt,
      completedAt: new Date().toISOString(),
      trigger,
      budget: { limit: budget, spent: 0 },
      digest: {
        sourcesChecked: fetchResult.fetchedSources.length,
        sourcesFailed: fetchResult.failedSources.length,
        itemsFetched: fetchResult.items.length,
        itemsRelevant: digest.itemCount,
      },
      plan: {
        pagesPlanned: plan.pageUpdates.length,
        newPagesSuggested: plan.newPageSuggestions.length,
      },
      execution: { pagesUpdated: 0, pagesFailed: 0, pagesSkipped: 0, results: [] },
      newPagesCreated: [],
    };
    const reportPath = saveRunReport(report);
    return { report, reportPath };
  }

  // ── Stage 4: Execute ────────────────────────────────────────────────────

  console.log(`\n── Stage 4: Executing updates ──`);
  const results: RunResult[] = [];
  let spent = 0;
  const costMap: Record<string, number> = { polish: 2.5, standard: 6.5, deep: 12.5 };

  for (let i = 0; i < plan.pageUpdates.length; i++) {
    const update = plan.pageUpdates[i];
    const cost = costMap[update.suggestedTier] || 6.5;

    if (spent + cost > budget) {
      console.log(`  [${i + 1}/${plan.pageUpdates.length}] ${update.pageTitle} — SKIPPED (budget exceeded)`);
      results.push({ pageId: update.pageId, status: 'skipped', tier: update.suggestedTier });
      continue;
    }

    console.log(`  [${i + 1}/${plan.pageUpdates.length}] ${update.pageTitle} (${update.suggestedTier})`);
    const result = executePageImprove(
      update.pageId,
      update.suggestedTier,
      update.directions,
      verbose,
    );
    results.push(result);

    if (result.status === 'success') {
      spent += cost;
      console.log(`    Done (${((result.durationMs || 0) / 1000).toFixed(0)}s)`);
    } else {
      console.log(`    FAILED: ${result.error?.slice(0, 100)}`);
    }
  }

  // Mark watchlist entries as updated so they aren't re-run until next window
  if (watchlistPageIds.length > 0) {
    const succeededIds = results.filter(r => r.status === 'success').map(r => r.pageId);
    const updatedWatchlistIds = watchlistPageIds.filter(id => succeededIds.includes(id));
    if (updatedWatchlistIds.length > 0) {
      markWatchlistUpdated(updatedWatchlistIds, date);
      if (verbose) {
        console.log(`\n  Watchlist last_run updated: ${updatedWatchlistIds.join(', ')}`);
      }
    }
  }

  // ── Stage 5: Validation ─────────────────────────────────────────────────

  if (results.some(r => r.status === 'success')) {
    console.log(`\n── Stage 5: Running validation ──`);
    const valid = runValidation(verbose);
    if (valid) {
      console.log(`  Validation passed`);
    } else {
      console.log(`  Validation had issues (check output above)`);
    }
  }

  // ── Stage 6: Report ─────────────────────────────────────────────────────

  const report: RunReport = {
    date,
    startedAt,
    completedAt: new Date().toISOString(),
    trigger,
    budget: { limit: budget, spent },
    digest: {
      sourcesChecked: fetchResult.fetchedSources.length,
      sourcesFailed: fetchResult.failedSources.length,
      itemsFetched: fetchResult.items.length,
      itemsRelevant: digest.itemCount,
    },
    plan: {
      pagesPlanned: plan.pageUpdates.length,
      newPagesSuggested: plan.newPageSuggestions.length,
    },
    execution: {
      pagesUpdated: results.filter(r => r.status === 'success').length,
      pagesFailed: results.filter(r => r.status === 'failed').length,
      pagesSkipped: results.filter(r => r.status === 'skipped').length,
      results,
    },
    newPagesCreated: [],
  };

  const reportPath = saveRunReport(report);

  // Summary
  console.log(`\n=== Auto-Update Complete ===`);
  console.log(`  Pages updated: ${report.execution.pagesUpdated}`);
  console.log(`  Pages failed: ${report.execution.pagesFailed}`);
  console.log(`  Pages skipped: ${report.execution.pagesSkipped}`);
  console.log(`  Budget: $${spent.toFixed(0)} / $${budget}`);
  console.log(`  Report: ${reportPath}`);

  return { report, reportPath };
}
