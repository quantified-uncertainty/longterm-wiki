/**
 * Page Improve Job Handler
 *
 * Runs `pnpm crux content improve` for a given page and captures the
 * file changes produced. Changes are stored in the job result so that
 * a batch-commit job can later apply them to a branch and create a PR.
 *
 * Params:
 *   - pageId: string (required) — the wiki page to improve
 *   - tier: 'polish' | 'standard' | 'deep' (default: 'standard')
 *   - directions: string (optional) — specific improvement instructions
 *   - batchId: string (optional) — links this job to a batch-commit group
 */

import { execFileSync } from 'child_process';
import type { JobHandlerContext, JobHandlerResult, PageImproveParams } from './types.ts';
import { collectChangedFiles, restoreGitState, isContentFile } from './utils.ts';

export async function handlePageImprove(
  params: Record<string, unknown>,
  ctx: JobHandlerContext,
): Promise<JobHandlerResult> {
  const { pageId, tier = 'standard', directions, batchId } = params as unknown as PageImproveParams;

  if (!pageId) {
    return { success: false, data: {}, error: 'Missing required param: pageId' };
  }

  const validTiers = ['polish', 'standard', 'deep'];
  if (!validTiers.includes(tier)) {
    return { success: false, data: {}, error: `Invalid tier: ${tier}. Must be one of: ${validTiers.join(', ')}` };
  }

  if (ctx.verbose) {
    console.log(`[page-improve] Starting: ${pageId} (tier: ${tier})`);
    if (directions) console.log(`[page-improve] Directions: ${directions.slice(0, 100)}...`);
  }

  const startTime = Date.now();

  try {
    // Ensure clean starting state
    restoreGitState(ctx.projectRoot);

    // Run the content improve pipeline
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

    execFileSync('node', args, {
      cwd: ctx.projectRoot,
      timeout: 30 * 60 * 1000, // 30 min per page
      stdio: ctx.verbose ? 'inherit' : 'pipe',
      env: { ...process.env },
    });

    // Run escaping fix on the changed files
    try {
      execFileSync('node', [
        '--import', 'tsx/esm', '--no-warnings',
        'crux/crux.mjs', 'fix', 'escaping',
      ], {
        cwd: ctx.projectRoot,
        timeout: 60_000,
        stdio: 'pipe',
      });
    } catch {
      // Fix escaping is best-effort
    }

    // Capture file changes produced by the improvement
    const fileChanges = collectChangedFiles(ctx.projectRoot, isContentFile);
    const durationMs = Date.now() - startTime;

    if (ctx.verbose) {
      console.log(`[page-improve] Completed: ${pageId} (${fileChanges.length} files changed, ${durationMs}ms)`);
    }

    // Restore git state so the worker's checkout stays clean for the next job
    restoreGitState(ctx.projectRoot);

    return {
      success: true,
      data: {
        pageId,
        tier,
        batchId: batchId ?? null,
        fileChanges,
        durationMs,
        filesChanged: fileChanges.length,
      },
    };
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - startTime;

    // Clean up any partial changes
    try {
      restoreGitState(ctx.projectRoot);
    } catch {
      // Best effort cleanup
    }

    return {
      success: false,
      data: { pageId, tier, batchId: batchId ?? null, durationMs },
      error: error.slice(0, 500),
    };
  }
}
