/**
 * Auto-Update Digest Job Handler
 *
 * Runs the first three stages of the auto-update pipeline (fetch → digest → route)
 * and creates individual page-improve jobs for each planned update, followed by
 * a batch-commit job that will collect all results into a single PR.
 *
 * This replaces the monolithic auto-update orchestrator's execution stage with
 * a parallelizable job-based approach:
 *
 *   1. This job: fetch news → build digest → route to pages → create child jobs
 *   2. N page-improve workers run in parallel
 *   3. 1 batch-commit worker collects results → creates PR
 *
 * Params:
 *   - budget: number (optional, default: 50) — max dollars for page improvements
 *   - maxPages: number (optional, default: 10) — max pages to update
 *   - sources: string (optional) — comma-separated source IDs
 *   - dryRun: boolean (optional) — if true, plans but doesn't create child jobs
 */

import type { JobHandlerContext, JobHandlerResult, AutoUpdateDigestParams } from './types.ts';
import { createJob, createJobBatch } from '../wiki-server/jobs.ts';

export async function handleAutoUpdateDigest(
  params: Record<string, unknown>,
  ctx: JobHandlerContext,
): Promise<JobHandlerResult> {
  const {
    budget = 50,
    maxPages = 10,
    sources,
    dryRun = false,
  } = params as unknown as AutoUpdateDigestParams;

  if (ctx.verbose) {
    console.log(`[auto-update-digest] Starting (budget: $${budget}, maxPages: ${maxPages}, dryRun: ${dryRun})`);
  }

  const startTime = Date.now();
  const date = new Date().toISOString().slice(0, 10);
  const batchId = `auto-update-${date}-${Date.now()}`;

  try {
    // ── Stage 1: Fetch news sources ────────────────────────────────────

    // Dynamic import to avoid loading heavy modules unless needed
    const { fetchAllSources, loadSeenItems, saveSeenItems } = await import('../../auto-update/feed-fetcher.ts');
    const { buildDigest, normalizeTitle } = await import('../../auto-update/digest.ts');
    const { routeDigest } = await import('../../auto-update/page-router.ts');
    const { getDueWatchlistUpdates } = await import('../../auto-update/watchlist.ts');
    const { loadPages } = await import('../content-types.ts');

    if (ctx.verbose) console.log('[auto-update-digest] Stage 1: Fetching news sources...');

    const sourceIds = sources ? sources.split(',').map(s => s.trim()) : undefined;
    const fetchResult = await fetchAllSources(sourceIds, ctx.verbose);

    if (ctx.verbose) {
      console.log(`  Fetched: ${fetchResult.fetchedSources.length} sources, ${fetchResult.items.length} items`);
    }

    // ── Stage 2: Build digest ──────────────────────────────────────────

    if (ctx.verbose) console.log('[auto-update-digest] Stage 2: Building news digest...');

    const pages = loadPages();
    const entityIds = pages.map(p => p.id).filter((id): id is string => Boolean(id));
    const previouslySeen = loadSeenItems();

    const digest = await buildDigest(
      fetchResult.items,
      fetchResult.fetchedSources,
      fetchResult.failedSources.map(f => f.id),
      { entityIds, previouslySeen, verbose: ctx.verbose },
    );

    // Save seen items for future runs
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
      return {
        success: true,
        data: {
          batchId,
          date,
          phase: 'digest',
          sourcesChecked: fetchResult.fetchedSources.length,
          sourcesFailed: fetchResult.failedSources.length,
          itemsFetched: fetchResult.items.length,
          itemsRelevant: 0,
          message: 'No relevant news found. No child jobs created.',
        },
      };
    }

    // ── Stage 3: Route to pages ────────────────────────────────────────

    if (ctx.verbose) console.log('[auto-update-digest] Stage 3: Routing to wiki pages...');

    const plan = await routeDigest(digest, {
      maxPages,
      maxBudget: budget,
      verbose: ctx.verbose,
    });

    // Inject watchlist-scheduled updates
    const watchlistUpdates = getDueWatchlistUpdates(date, ctx.verbose);
    if (watchlistUpdates.length > 0) {
      const existingIds = new Set(plan.pageUpdates.map(u => u.pageId));
      for (const wu of watchlistUpdates) {
        if (!existingIds.has(wu.pageId)) {
          plan.pageUpdates.unshift(wu);
        }
      }
    }

    if (ctx.verbose) {
      console.log(`  Plan: ${plan.pageUpdates.length} page updates`);
    }

    if (plan.pageUpdates.length === 0) {
      return {
        success: true,
        data: {
          batchId,
          date,
          phase: 'routing',
          sourcesChecked: fetchResult.fetchedSources.length,
          itemsRelevant: digest.itemCount,
          pagesPlanned: 0,
          message: 'No pages matched for updates.',
        },
      };
    }

    if (dryRun) {
      return {
        success: true,
        data: {
          batchId,
          date,
          phase: 'dry-run',
          sourcesChecked: fetchResult.fetchedSources.length,
          itemsFetched: fetchResult.items.length,
          itemsRelevant: digest.itemCount,
          pagesPlanned: plan.pageUpdates.length,
          plannedUpdates: plan.pageUpdates.map(u => ({
            pageId: u.pageId,
            pageTitle: u.pageTitle,
            tier: u.suggestedTier,
            reason: u.reason.slice(0, 200),
          })),
          newPageSuggestions: plan.newPageSuggestions.map(s => ({
            title: s.suggestedTitle,
            id: s.suggestedId,
          })),
          message: 'Dry run — no child jobs created.',
        },
      };
    }

    // ── Stage 4: Create child jobs ─────────────────────────────────────

    if (ctx.verbose) console.log('[auto-update-digest] Stage 4: Creating child jobs...');

    const costMap: Record<string, number> = { polish: 2.5, standard: 6.5, deep: 12.5 };
    let budgetUsed = 0;
    const jobInputs: Array<{
      type: string;
      params: Record<string, unknown>;
      priority: number;
      maxRetries: number;
    }> = [];

    for (const update of plan.pageUpdates) {
      const cost = costMap[update.suggestedTier] || 6.5;
      if (budgetUsed + cost > budget) {
        if (ctx.verbose) {
          console.log(`  Skipping ${update.pageId} (budget exceeded: $${budgetUsed}/$${budget})`);
        }
        continue;
      }

      jobInputs.push({
        type: 'page-improve',
        params: {
          pageId: update.pageId,
          tier: update.suggestedTier,
          directions: update.directions,
          batchId,
        },
        priority: 5, // Medium-high priority for auto-update jobs
        maxRetries: 2,
      });

      budgetUsed += cost;
    }

    // Create all page-improve jobs
    const childJobIds: number[] = [];
    const createResult = await createJobBatch(jobInputs);

    if (!createResult.ok) {
      // Fall back to individual creation
      if (ctx.verbose) {
        console.log('  Batch creation failed, falling back to individual...');
      }
      for (const input of jobInputs) {
        const singleResult = await createJob(input);
        if (singleResult.ok) {
          childJobIds.push(singleResult.data.id);
        }
      }
    } else {
      for (const job of createResult.data) {
        childJobIds.push(job.id);
      }
    }

    if (ctx.verbose) {
      console.log(`  Created ${childJobIds.length} page-improve jobs`);
    }

    // Create the batch-commit job
    let batchCommitJobId: number | null = null;
    const commitResult = await createJob({
      type: 'batch-commit',
      params: {
        batchId,
        childJobIds,
        prTitle: `Auto-update: ${date} daily wiki refresh`,
        prBody: `Automated news-driven wiki update via job queue.\n\n- **Sources checked**: ${fetchResult.fetchedSources.length}\n- **Relevant items**: ${digest.itemCount}\n- **Pages updated**: ${childJobIds.length}`,
        prLabels: ['auto-update'],
      },
      priority: 1, // Lower priority — should run after all page-improve jobs
      maxRetries: 5, // More retries since it depends on children
    });

    if (commitResult.ok) {
      batchCommitJobId = commitResult.data.id;
      if (ctx.verbose) {
        console.log(`  Created batch-commit job #${batchCommitJobId}`);
      }
    }

    const durationMs = Date.now() - startTime;

    return {
      success: true,
      data: {
        batchId,
        date,
        phase: 'jobs-created',
        sourcesChecked: fetchResult.fetchedSources.length,
        sourcesFailed: fetchResult.failedSources.length,
        itemsFetched: fetchResult.items.length,
        itemsRelevant: digest.itemCount,
        pagesPlanned: plan.pageUpdates.length,
        childJobIds,
        batchCommitJobId,
        estimatedBudget: budgetUsed,
        durationMs,
        plannedUpdates: plan.pageUpdates.slice(0, jobInputs.length).map(u => ({
          pageId: u.pageId,
          pageTitle: u.pageTitle,
          tier: u.suggestedTier,
        })),
      },
    };
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      data: { batchId, date, durationMs: Date.now() - startTime },
      error: error.slice(0, 500),
    };
  }
}
