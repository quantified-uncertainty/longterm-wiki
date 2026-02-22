/**
 * Batch Commit Job Handler
 *
 * Collects results from completed content jobs (page-improve, page-create),
 * applies their file changes to a fresh branch, runs validation, and creates
 * a GitHub PR.
 *
 * This enables the "50 parallel workers → 1 PR" workflow: many page-improve
 * jobs run in parallel, each storing their file changes in the job result.
 * This handler then combines all changes into a single commit.
 *
 * Params:
 *   - batchId: string (required) — identifies the batch
 *   - childJobIds: number[] (required) — job IDs to collect results from
 *   - branchName: string (optional) — branch name (default: auto-generated)
 *   - prTitle: string (required) — PR title
 *   - prBody: string (optional) — PR body markdown
 *   - prLabels: string[] (optional) — labels to add to the PR
 */

import { execFileSync } from 'child_process';
import type { JobHandlerContext, JobHandlerResult, BatchCommitParams, FileChange } from './types.ts';
import { getJob } from '../wiki-server/jobs.ts';
import { applyFileChanges } from './utils.ts';

/** Maximum number of incomplete child jobs before we give up waiting */
const MAX_INCOMPLETE_TOLERANCE = 0;

/**
 * Sanitize a string for use as a git branch name.
 * Removes characters that are invalid in git refs.
 */
function sanitizeBranchName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9\-_/]/g, '-')  // Replace invalid chars with hyphens
    .replace(/\.{2,}/g, '-')              // No consecutive dots
    .replace(/\/\//g, '/')                // No double slashes
    .replace(/^[.\-/]+/, '')              // No leading dots, hyphens, slashes
    .replace(/[.\-/]+$/, '')              // No trailing dots, hyphens, slashes
    .slice(0, 100);                        // Reasonable length limit
}

export async function handleBatchCommit(
  params: Record<string, unknown>,
  ctx: JobHandlerContext,
): Promise<JobHandlerResult> {
  const {
    batchId,
    childJobIds,
    branchName,
    prTitle,
    prBody,
    prLabels = [],
  } = params as unknown as BatchCommitParams;

  if (!batchId) {
    return { success: false, data: {}, error: 'Missing required param: batchId' };
  }
  if (!childJobIds || childJobIds.length === 0) {
    return { success: false, data: {}, error: 'Missing required param: childJobIds (must be non-empty array)' };
  }
  if (!prTitle) {
    return { success: false, data: {}, error: 'Missing required param: prTitle' };
  }

  if (ctx.verbose) {
    console.log(`[batch-commit] Starting batch "${batchId}" with ${childJobIds.length} child jobs`);
  }

  const startTime = Date.now();

  try {
    // ── Step 1: Collect results from child jobs ─────────────────────────

    const allFileChanges: FileChange[] = [];
    const jobSummaries: Array<{
      id: number;
      type: string;
      status: string;
      pageId?: string;
    }> = [];
    const errors: string[] = [];
    let incompleteCount = 0;

    for (const jobId of childJobIds) {
      const result = await getJob(jobId);

      if (!result.ok) {
        errors.push(`Failed to fetch job #${jobId}: ${result.message}`);
        continue;
      }

      const job = result.data;
      jobSummaries.push({
        id: job.id,
        type: job.type,
        status: job.status,
        pageId: (job.result as Record<string, unknown>)?.pageId as string | undefined,
      });

      if (job.status !== 'completed') {
        incompleteCount++;
        if (job.status === 'failed') {
          errors.push(`Job #${jobId} (${job.type}) failed: ${job.error ?? 'unknown error'}`);
        } else {
          errors.push(`Job #${jobId} (${job.type}) not yet completed (status: ${job.status})`);
        }
        continue;
      }

      // Extract file changes from the job result
      const jobResult = job.result as Record<string, unknown> | null;
      const fileChanges = (jobResult?.fileChanges ?? []) as FileChange[];

      for (const change of fileChanges) {
        // Deduplicate: later jobs win for the same file path
        const existingIdx = allFileChanges.findIndex(c => c.path === change.path);
        if (existingIdx >= 0) {
          allFileChanges[existingIdx] = change;
        } else {
          allFileChanges.push(change);
        }
      }
    }

    // Check if too many children are incomplete
    if (incompleteCount > MAX_INCOMPLETE_TOLERANCE) {
      return {
        success: false,
        data: {
          batchId,
          childJobIds,
          incompleteCount,
          jobSummaries,
          errors,
        },
        error: `${incompleteCount} child job(s) not yet completed. Retry after all children finish.`,
      };
    }

    if (allFileChanges.length === 0) {
      return {
        success: true,
        data: {
          batchId,
          childJobIds,
          filesApplied: 0,
          jobSummaries,
          message: 'No file changes to commit (all jobs may have produced no changes)',
        },
      };
    }

    if (ctx.verbose) {
      console.log(`[batch-commit] Collected ${allFileChanges.length} file changes from ${jobSummaries.length} jobs`);
    }

    // ── Step 2: Create branch and apply changes ─────────────────────────

    const branch = sanitizeBranchName(branchName ?? `batch/${batchId}`);

    // Ensure we're on a clean main/HEAD first
    try {
      execFileSync('git', ['checkout', 'main'], {
        cwd: ctx.projectRoot,
        stdio: 'pipe',
      });
      execFileSync('git', ['pull', '--ff-only', 'origin', 'main'], {
        cwd: ctx.projectRoot,
        stdio: 'pipe',
      });
    } catch {
      // May fail if no remote or not on main — try origin/main
      try {
        execFileSync('git', ['fetch', 'origin', 'main'], {
          cwd: ctx.projectRoot,
          stdio: 'pipe',
        });
      } catch {
        // Continue anyway
      }
    }

    // Create the branch
    try {
      execFileSync('git', ['checkout', '-b', branch], {
        cwd: ctx.projectRoot,
        stdio: 'pipe',
      });
    } catch {
      // Branch may already exist — reset it
      execFileSync('git', ['checkout', branch], {
        cwd: ctx.projectRoot,
        stdio: 'pipe',
      });
      execFileSync('git', ['reset', '--hard', 'main'], {
        cwd: ctx.projectRoot,
        stdio: 'pipe',
      });
    }

    // Apply all file changes (with path traversal protection)
    const { applied, errors: applyErrors, appliedPaths } = applyFileChanges(ctx.projectRoot, allFileChanges);

    if (applyErrors.length > 0) {
      errors.push(...applyErrors.map(e => `Apply error: ${e}`));
    }

    if (ctx.verbose) {
      console.log(`[batch-commit] Applied ${applied} file changes`);
    }

    // ── Step 3: Run validation ──────────────────────────────────────────

    let validationPassed = false;
    try {
      execFileSync('node', [
        '--import', 'tsx/esm', '--no-warnings',
        'crux/crux.mjs', 'validate', 'gate', '--fix',
      ], {
        cwd: ctx.projectRoot,
        timeout: 10 * 60 * 1000,
        stdio: ctx.verbose ? 'inherit' : 'pipe',
      });
      validationPassed = true;
    } catch {
      if (ctx.verbose) {
        console.log('[batch-commit] Validation had issues (continuing with commit)');
      }
    }

    // ── Step 4: Commit (stage only specific files, not -A) ──────────────

    // Stage only the files that were actually applied
    if (appliedPaths.length > 0) {
      execFileSync('git', ['add', ...appliedPaths], {
        cwd: ctx.projectRoot,
        stdio: 'pipe',
      });
    }

    // Check if there are staged changes
    try {
      execFileSync('git', ['diff', '--staged', '--quiet'], {
        cwd: ctx.projectRoot,
        stdio: 'pipe',
      });
      // No changes to commit
      return {
        success: true,
        data: {
          batchId,
          childJobIds,
          filesApplied: applied,
          jobSummaries,
          message: 'No changes after applying (files may be identical to main)',
        },
      };
    } catch {
      // There are staged changes — proceed with commit
    }

    const successCount = jobSummaries.filter(j => j.status === 'completed').length;
    const failedCount = jobSummaries.filter(j => j.status === 'failed').length;

    const commitMsg = [
      prTitle,
      '',
      `Batch: ${batchId}`,
      `Jobs: ${successCount} completed, ${failedCount} failed`,
      `Files: ${applied} changed`,
      validationPassed ? 'Validation: passed' : 'Validation: issues detected',
    ].join('\n');

    execFileSync('git', ['commit', '-m', commitMsg], {
      cwd: ctx.projectRoot,
      stdio: 'pipe',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'longterm-wiki-bot',
        GIT_AUTHOR_EMAIL: 'bot@longterm.wiki',
        GIT_COMMITTER_NAME: 'longterm-wiki-bot',
        GIT_COMMITTER_EMAIL: 'bot@longterm.wiki',
      },
    });

    // ── Step 5: Push and create PR ──────────────────────────────────────

    execFileSync('git', ['push', '-u', 'origin', branch], {
      cwd: ctx.projectRoot,
      timeout: 60_000,
      stdio: 'pipe',
    });

    // Build PR body
    const body = buildPrBody({
      batchId,
      prBody,
      jobSummaries,
      applied,
      validationPassed,
      errors,
    });

    // Create PR via gh CLI
    const prArgs = [
      'pr', 'create',
      '--title', prTitle,
      '--body', body,
      '--base', 'main',
      '--head', branch,
    ];

    for (const label of prLabels) {
      prArgs.push('--label', label);
    }

    let prUrl = '';
    try {
      prUrl = execFileSync('gh', prArgs, {
        cwd: ctx.projectRoot,
        encoding: 'utf-8',
        timeout: 30_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch (err) {
      if (ctx.verbose) {
        console.log(`[batch-commit] gh pr create failed, PR must be created manually: ${err}`);
      }
    }

    const durationMs = Date.now() - startTime;

    return {
      success: true,
      data: {
        batchId,
        childJobIds,
        branch,
        prUrl,
        filesApplied: applied,
        validationPassed,
        jobSummaries,
        durationMs,
        errors: errors.length > 0 ? errors : undefined,
      },
    };
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      data: { batchId, childJobIds, durationMs: Date.now() - startTime },
      error: error.slice(0, 500),
    };
  }
}

// ---------------------------------------------------------------------------
// PR Body Builder
// ---------------------------------------------------------------------------

function buildPrBody(opts: {
  batchId: string;
  prBody?: string;
  jobSummaries: Array<{ id: number; type: string; status: string; pageId?: string }>;
  applied: number;
  validationPassed: boolean;
  errors: string[];
}): string {
  const lines: string[] = [];

  lines.push('## Summary');
  lines.push('');
  if (opts.prBody) {
    lines.push(opts.prBody);
    lines.push('');
  }
  lines.push(`- **Batch**: \`${opts.batchId}\``);
  lines.push(`- **Files changed**: ${opts.applied}`);
  lines.push(`- **Validation**: ${opts.validationPassed ? 'Passed' : 'Issues detected'}`);
  lines.push('');

  // Job results table
  lines.push('## Job Results');
  lines.push('');
  lines.push('| Job | Type | Status | Page |');
  lines.push('|-----|------|--------|------|');
  for (const job of opts.jobSummaries) {
    const statusIcon = job.status === 'completed' ? '✅' : job.status === 'failed' ? '❌' : '⏳';
    lines.push(`| #${job.id} | ${job.type} | ${statusIcon} ${job.status} | ${job.pageId ?? '—'} |`);
  }
  lines.push('');

  const completed = opts.jobSummaries.filter(j => j.status === 'completed').length;
  const total = opts.jobSummaries.length;
  lines.push(`**${completed}/${total}** jobs completed successfully.`);

  if (opts.errors.length > 0) {
    lines.push('');
    lines.push('## Errors');
    lines.push('');
    for (const error of opts.errors.slice(0, 10)) {
      lines.push(`- ${error}`);
    }
    if (opts.errors.length > 10) {
      lines.push(`- ...and ${opts.errors.length - 10} more`);
    }
  }

  return lines.join('\n');
}
