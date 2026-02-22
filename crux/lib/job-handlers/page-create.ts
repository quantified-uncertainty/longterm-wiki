/**
 * Page Create Job Handler
 *
 * Runs `pnpm crux content create` for a new page and captures the
 * file changes produced. Changes are stored in the job result so that
 * a batch-commit job can later apply them to a branch and create a PR.
 *
 * Params:
 *   - title: string (required) — the page title
 *   - tier: 'budget' | 'standard' | 'premium' (default: 'standard')
 *   - batchId: string (optional) — links this job to a batch-commit group
 */

import { execFileSync } from 'child_process';
import type { JobHandlerContext, JobHandlerResult, PageCreateParams } from './types.ts';
import { collectChangedFiles, restoreGitState, isContentFile } from './utils.ts';

export async function handlePageCreate(
  params: Record<string, unknown>,
  ctx: JobHandlerContext,
): Promise<JobHandlerResult> {
  const { title, tier = 'standard', batchId } = params as unknown as PageCreateParams;

  if (!title) {
    return { success: false, data: {}, error: 'Missing required param: title' };
  }

  const validTiers = ['budget', 'standard', 'premium'];
  if (!validTiers.includes(tier)) {
    return { success: false, data: {}, error: `Invalid tier: ${tier}. Must be one of: ${validTiers.join(', ')}` };
  }

  if (ctx.verbose) {
    console.log(`[page-create] Starting: "${title}" (tier: ${tier})`);
  }

  const startTime = Date.now();

  try {
    // Ensure clean starting state
    restoreGitState(ctx.projectRoot);

    // Run the content create pipeline
    const args = [
      '--import', 'tsx/esm', '--no-warnings',
      'crux/authoring/page-creator/index.ts',
      '--', title,
      '--tier', tier,
    ];

    const output = execFileSync('node', args, {
      cwd: ctx.projectRoot,
      timeout: 30 * 60 * 1000,
      stdio: ctx.verbose ? 'inherit' : 'pipe',
      encoding: 'utf-8',
      env: { ...process.env },
    });

    // Try to extract the created page ID from output
    let pageId: string | null = null;
    if (typeof output === 'string') {
      const match = output.match(/Page created:\s+(\S+)/i) || output.match(/id:\s*["']?(\S+?)["']?\s/);
      if (match) pageId = match[1];
    }

    // Run escaping fix
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
      // Best-effort
    }

    // Capture file changes
    const fileChanges = collectChangedFiles(ctx.projectRoot, isContentFile);
    const durationMs = Date.now() - startTime;

    if (ctx.verbose) {
      console.log(`[page-create] Completed: "${title}" → ${pageId ?? 'unknown'} (${fileChanges.length} files, ${durationMs}ms)`);
    }

    // Restore git state
    restoreGitState(ctx.projectRoot);

    return {
      success: true,
      data: {
        title,
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

    try {
      restoreGitState(ctx.projectRoot);
    } catch {
      // Best effort
    }

    return {
      success: false,
      data: { title, tier, batchId: batchId ?? null, durationMs },
      error: error.slice(0, 500),
    };
  }
}
