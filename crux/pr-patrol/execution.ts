/**
 * PR Patrol — Claude spawning, PR fixing, main branch fixing, claim management
 */

import { spawn } from 'child_process';
import { githubApi } from '../lib/github.ts';
import { gitSafe } from '../lib/git.ts';
import type { FixOutcome, PatrolConfig, ScoredPr } from './types.ts';
import {
  buildAbandonmentComment,
  buildFixAttemptComment,
  buildFixCompleteComment,
  buildNoOpComment,
  buildTimeoutComment,
  postEventComment,
} from './comments.ts';
import {
  appendJsonl,
  isAbandoned,
  isRecentlyProcessed,
  JSONL_FILE,
  log,
  markProcessed,
  recordFailure,
  resetFailCount,
} from './state.ts';
import { buildMainBranchPrompt, buildPrompt } from './prompts.ts';
import { computeBudget } from './scoring.ts';

// ── No-op detection ─────────────────────────────────────────────────────────

/**
 * Detect when Claude exited cleanly but didn't actually fix anything
 * (e.g., followed "stop early" guidance for human-required issues).
 */
const NO_OP_PATTERNS = [
  /no action needed/i,
  /no code changes? needed/i,
  /requires? human intervention/i,
  /needs? human/i,
  /cannot be fixed automatically/i,
  /pre-existing.*(failure|issue|problem)/i,
  /also failing on main/i,
  /stopping early/i,
  /nothing to fix/i,
];

export function looksLikeNoOp(output: string): boolean {
  // Only check the last portion of output (where the conclusion lives)
  const tail = output.slice(-1000);
  return NO_OP_PATTERNS.some((p) => p.test(tail));
}

// ── Main Branch CI Check ────────────────────────────────────────────────────

interface WorkflowRun {
  id: number;
  status: string;
  conclusion: string | null;
  created_at: string;
  head_sha: string;
  html_url: string;
}

interface WorkflowRunsResponse {
  workflow_runs: WorkflowRun[];
  total_count: number;
}

export interface MainBranchStatus {
  isRed: boolean;
  runId: number | null;
  sha: string;
  htmlUrl: string;
}

const CI_WORKFLOW = 'ci.yml';
const MAIN_BRANCH_KEY = 'main-branch';

export async function checkMainBranch(config: PatrolConfig): Promise<MainBranchStatus> {
  const notRed: MainBranchStatus = { isRed: false, runId: null, sha: '', htmlUrl: '' };

  // Check cooldown and abandoned status first
  if (isAbandoned(MAIN_BRANCH_KEY)) {
    log('  Main branch fix abandoned — needs human intervention');
    return notRed;
  }
  if (isRecentlyProcessed(MAIN_BRANCH_KEY, config.cooldownSeconds)) {
    log('  Main branch recently processed — skipping');
    return notRed;
  }

  try {
    // Fetch the latest completed CI runs on main
    const resp = await githubApi<WorkflowRunsResponse>(
      `/repos/${config.repo}/actions/workflows/${CI_WORKFLOW}/runs?branch=main&status=completed&per_page=5`,
    );

    const runs = resp.workflow_runs ?? [];
    if (runs.length === 0) {
      log('  No completed CI runs on main found');
      return notRed;
    }

    const latest = runs[0];
    if (latest.conclusion === 'failure') {
      log(`  🔴 Main branch CI is RED (run #${latest.id}, sha ${latest.head_sha.slice(0, 8)})`);
      return {
        isRed: true,
        runId: latest.id,
        sha: latest.head_sha,
        htmlUrl: latest.html_url,
      };
    }

    log(`  Main branch CI is green (latest run #${latest.id}: ${latest.conclusion})`);
    return notRed;
  } catch (e) {
    log(`  Warning: could not check main branch CI: ${e instanceof Error ? e.message : String(e)}`);
    return notRed;
  }
}

export async function fixMainBranch(status: MainBranchStatus, config: PatrolConfig): Promise<void> {
  log(`→ Fixing main branch CI (run #${status.runId})`);

  if (config.dryRun) {
    log('  [DRY RUN] Would invoke Claude to fix main branch CI');
    appendJsonl(JSONL_FILE, {
      type: 'main_branch_result',
      run_id: status.runId,
      sha: status.sha,
      outcome: 'dry-run' as FixOutcome,
      elapsed_s: 0,
    });
    markProcessed(MAIN_BRANCH_KEY);
    return;
  }

  const prompt = buildMainBranchPrompt(status.runId!, config.repo);
  const startTime = Date.now();

  let outcome: FixOutcome = 'fixed';
  let reason = '';

  try {
    const result = await spawnClaude(prompt, config);
    const elapsedS = Math.floor((Date.now() - startTime) / 1000);

    if (result.timedOut) {
      const failCount = recordFailure(MAIN_BRANCH_KEY);
      outcome = 'timeout';
      reason = `Killed after ${config.timeoutMinutes}m timeout — attempt ${failCount}`;
      log(`✗ Main branch fix timed out after ${config.timeoutMinutes}m (attempt ${failCount})`);

      if (failCount >= 2) {
        reason = `Abandoned after ${failCount} failures (timeout)`;
        log(`✗ Main branch fix abandoned after ${failCount} failures`);
      }
    } else if (result.exitCode === 0 && !result.hitMaxTurns) {
      const isNoOp = looksLikeNoOp(result.output);
      outcome = isNoOp ? 'no-op' : 'fixed';
      if (isNoOp) {
        recordFailure(MAIN_BRANCH_KEY);
        reason = 'No-op: agent determined issue needs human intervention';
        log(`⚠ Main branch fix no-op — agent stopped early (${elapsedS}s)`);
      } else {
        resetFailCount(MAIN_BRANCH_KEY);
        log(`✓ Main branch CI fix processed (${elapsedS}s)`);
      }
    } else if (result.hitMaxTurns) {
      const failCount = recordFailure(MAIN_BRANCH_KEY);
      outcome = 'max-turns';
      reason = `Hit max turns (${config.maxTurns}) — attempt ${failCount}`;
      log(`⚠ Main branch fix hit max turns after ${elapsedS}s`);

      if (failCount >= 2) {
        reason = `Abandoned after ${failCount} failures`;
        log(`✗ Main branch fix abandoned after ${failCount} failures`);
      }
    } else {
      outcome = 'error';
      reason = `Exit code: ${result.exitCode}`;
      log(`✗ Main branch fix failed (exit: ${result.exitCode}, ${elapsedS}s)`);
    }

    appendJsonl(JSONL_FILE, {
      type: 'main_branch_result',
      run_id: status.runId,
      sha: status.sha,
      outcome,
      elapsed_s: elapsedS,
      reason: reason || undefined,
    });
  } finally {
    // Clean up any in-progress rebase/merge
    gitSafe('rebase', '--abort');
    gitSafe('merge', '--abort');

    // Restore to main branch
    gitSafe('checkout', 'main');

    markProcessed(MAIN_BRANCH_KEY);
  }
}

// ── Claude spawning ─────────────────────────────────────────────────────────

export function spawnClaude(
  prompt: string,
  config: PatrolConfig,
): Promise<{ exitCode: number; output: string; hitMaxTurns: boolean; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const args = [
      '--print',
      '--model',
      config.model,
      '--max-turns',
      String(config.maxTurns),
      '--verbose',
    ];
    if (config.skipPerms) args.push('--dangerously-skip-permissions');

    // Unset CLAUDECODE to prevent subprocess hang inside Claude Code sessions
    const env = { ...process.env };
    delete env.CLAUDECODE;

    const child = spawn('claude', args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let output = '';
    let timedOut = false;

    // Hard timeout — kill subprocess if it runs too long
    const timeoutMs = config.timeoutMinutes * 60 * 1000;
    const timer = setTimeout(() => {
      timedOut = true;
      log(`  ⚠ Claude subprocess timed out after ${config.timeoutMinutes}m — killing`);
      child.kill('SIGTERM');
      // Force kill if SIGTERM doesn't work within 10s
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 10_000);
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      process.stderr.write(text);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });

    child.stdin.write(prompt);
    child.stdin.end();

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? 1,
        output,
        hitMaxTurns: output.includes('Reached max turns'),
        timedOut,
      });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ── PR claim management ─────────────────────────────────────────────────────

let claimedPr: number | null = null;

export function getClaimedPr(): number | null {
  return claimedPr;
}

async function claimPr(prNum: number, repo: string): Promise<void> {
  try {
    await githubApi(`/repos/${repo}/issues/${prNum}/labels`, {
      method: 'POST',
      body: { labels: ['claude-working'] },
    });
    claimedPr = prNum;
  } catch {
    log(`  Warning: could not add claude-working label to PR #${prNum}`);
  }
}

async function releasePr(prNum: number, repo: string): Promise<void> {
  try {
    await githubApi(`/repos/${repo}/issues/${prNum}/labels/claude-working`, {
      method: 'DELETE',
    });
  } catch (e) {
    // Label may not exist or already removed — not actionable
    void e;
  }
  if (claimedPr === prNum) claimedPr = null;
}

export async function releaseCurrentClaim(repo: string): Promise<void> {
  if (claimedPr !== null) {
    await releasePr(claimedPr, repo).catch((e) => {
      // Best-effort cleanup during shutdown — label will be stale but not harmful
      log(`  Warning: could not release claim on PR #${claimedPr}: ${e instanceof Error ? e.message : String(e)}`);
    });
  }
}

// ── PR fix execution ────────────────────────────────────────────────────────

export async function fixPr(pr: ScoredPr, config: PatrolConfig): Promise<void> {
  log(`→ Fixing PR #${pr.number} (${pr.title})`);
  log(`  Issues: ${pr.issues.join(', ')}`);
  log(`  Branch: ${pr.branch}`);

  if (config.dryRun) {
    log('  [DRY RUN] Would invoke Claude to fix');
    appendJsonl(JSONL_FILE, {
      type: 'pr_result',
      pr_num: pr.number,
      issues: pr.issues,
      outcome: 'dry-run' as FixOutcome,
      elapsed_s: 0,
    });
    markProcessed(pr.number);
    return;
  }

  // Save current branch to restore after fix
  const origBranch = gitSafe('branch', '--show-current');
  const originalBranch = origBranch.ok ? origBranch.output.trim() : '';

  await claimPr(pr.number, config.repo);

  // Compute issue-specific budget (capped by global config)
  const budget = computeBudget(pr.issues);
  const effectiveMaxTurns = Math.min(budget.maxTurns, config.maxTurns);
  const effectiveTimeout = Math.min(budget.timeoutMinutes, config.timeoutMinutes);

  log(`  Budget: ${effectiveMaxTurns} max-turns, ${effectiveTimeout}m timeout (based on: ${pr.issues.join(', ')})`);

  // Post "attempting fix" event comment before spawning Claude
  await postEventComment(pr.number, config.repo, buildFixAttemptComment(pr.issues))
    .catch((e: unknown) => log(`  Warning: could not post fix attempt comment: ${e instanceof Error ? e.message : String(e)}`));

  const prompt = buildPrompt(pr, config.repo);
  const startTime = Date.now();

  let outcome: FixOutcome = 'fixed';
  let reason = '';

  try {
    const result = await spawnClaude(prompt, {
      ...config,
      maxTurns: effectiveMaxTurns,
      timeoutMinutes: effectiveTimeout,
    });
    const elapsedS = Math.floor((Date.now() - startTime) / 1000);

    if (result.timedOut) {
      // Timeouts count toward abandonment — a PR that times out repeatedly
      // is likely unfixable and should not keep burning compute.
      const failCount = recordFailure(pr.number);
      outcome = 'timeout';
      reason = `Killed after ${effectiveTimeout}m timeout — attempt ${failCount}`;
      log(`✗ PR #${pr.number} timed out after ${effectiveTimeout}m (attempt ${failCount})`);

      if (failCount >= 2) {
        reason = `Abandoned after ${failCount} failures (timeout)`;
        log(`✗ PR #${pr.number} abandoned after ${failCount} consecutive failures`);
        await postEventComment(pr.number, config.repo, buildAbandonmentComment(failCount, pr.issues))
          .catch((e: unknown) => log(`  Warning: could not post abandonment comment: ${e instanceof Error ? e.message : String(e)}`));
      } else {
        await postEventComment(pr.number, config.repo, buildTimeoutComment(failCount, effectiveTimeout, pr.issues))
          .catch((e: unknown) => log(`  Warning: could not post timeout comment: ${e instanceof Error ? e.message : String(e)}`));
      }
    } else if (result.exitCode === 0 && !result.hitMaxTurns) {
      const isNoOp = looksLikeNoOp(result.output);
      outcome = isNoOp ? 'no-op' : 'fixed';

      if (isNoOp) {
        // No-op: Claude determined the issue can't be fixed automatically.
        // Don't reset fail count — treat like a soft failure so the PR
        // gets skipped on future cycles instead of being retried forever.
        const failCount = recordFailure(pr.number);
        reason = `No-op: agent determined issue needs human intervention (attempt ${failCount})`;
        log(`⚠ PR #${pr.number} no-op — agent stopped early (${elapsedS}s)`);

        await postEventComment(pr.number, config.repo, buildNoOpComment(pr.issues))
          .catch((e: unknown) => log(`  Warning: could not post no-op comment: ${e instanceof Error ? e.message : String(e)}`));
      } else {
        resetFailCount(pr.number);
        log(`✓ PR #${pr.number} processed successfully (${elapsedS}s)`);

        // Post fix-complete summary comment
        const outputTail = result.output.slice(-500);
        await postEventComment(pr.number, config.repo, buildFixCompleteComment(elapsedS, effectiveMaxTurns, config.model, pr.issues, outputTail))
          .catch((e: unknown) => log(`  Warning: could not post fix-complete comment: ${e instanceof Error ? e.message : String(e)}`));
      }
    } else if (result.hitMaxTurns) {
      const failCount = recordFailure(pr.number);
      outcome = 'max-turns';
      reason = `Hit max turns (${effectiveMaxTurns}) — attempt ${failCount}`;
      log(`⚠ PR #${pr.number} hit max turns after ${elapsedS}s (attempt ${failCount})`);

      if (failCount >= 2) {
        reason = `Abandoned after ${failCount} failures`;
        log(
          `✗ PR #${pr.number} abandoned after ${failCount} consecutive failures`,
        );
        await postEventComment(pr.number, config.repo, buildAbandonmentComment(failCount, pr.issues))
          .catch((e: unknown) => log(`  Warning: could not post abandonment comment: ${e instanceof Error ? e.message : String(e)}`));
      }
    } else {
      outcome = 'error';
      reason = `Exit code: ${result.exitCode}`;
      log(
        `✗ PR #${pr.number} processing failed (exit: ${result.exitCode}, ${elapsedS}s)`,
      );
    }

    appendJsonl(JSONL_FILE, {
      type: 'pr_result',
      pr_num: pr.number,
      issues: pr.issues,
      outcome,
      elapsed_s: elapsedS,
      reason: reason || undefined,
    });
  } finally {
    await releasePr(pr.number, config.repo);

    // Clean up any in-progress rebase/merge left by the spawned session
    gitSafe('rebase', '--abort');
    gitSafe('merge', '--abort');

    // Restore original branch
    if (originalBranch) {
      gitSafe('checkout', originalBranch);
    }

    markProcessed(pr.number);
  }
}
