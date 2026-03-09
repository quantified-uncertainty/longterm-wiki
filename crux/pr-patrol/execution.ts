/**
 * PR Patrol — Claude spawning, PR fixing, main branch fixing, claim management
 *
 * Main branch CI checking uses crux/lib/pr-analysis/ci-status.ts (pure API call).
 * This module wraps it with daemon concerns (cooldown, abandoned tracking, logging).
 *
 * Automated rebase uses crux/lib/pr-analysis/rebase.ts for stale or conflicting
 * PRs before falling back to Claude when the rebase can't auto-resolve.
 */

import { spawn } from 'child_process';
import { githubApi } from '../lib/github.ts';
import { git, createWorktree, removeWorktree } from '../lib/git.ts';
import { checkMainBranch as libCheckMainBranch, findRecentMerges as libFindRecentMerges } from '../lib/pr-analysis/index.ts';
import type { RecentMerge } from '../lib/pr-analysis/index.ts';
import { tryAutomatedRebase } from '../lib/pr-analysis/rebase.ts';
import type { FixOutcome, MainBranchStatus, PatrolConfig, ScoredPr } from './types.ts';
import { LABELS } from './types.ts';
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
  cl,
  getFailCount,
  isMainBranchAbandoned,
  isRecentlyProcessed,
  JSONL_FILE,
  log,
  MAIN_BRANCH_ABANDON_THRESHOLD,
  MAIN_BRANCH_COOLDOWN_SECONDS,
  markProcessed,
  recordFailure,
  resetFailCount,
  trackMainFixPr,
  getMainRedSince,
  setMainRedSince,
  clearMainRedSince,
  getMainFixAttempts,
  incrementMainFixAttempts,
  resetMainFixAttempts,
  setPersistedClaimedPr,
} from './state.ts';
import { buildMainBranchPrompt, buildPrompt } from './prompts.ts';
import { computeEffectiveBudget } from './scoring.ts';

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

// ── Main root cause detection ───────────────────────────────────────────────

/**
 * Detect when a PR fix no-op is because the root cause is on main branch.
 * This is a subset of no-op patterns — specifically indicates main is broken
 * and this PR's CI failure isn't its own fault.
 */
const MAIN_ROOT_CAUSE_PATTERNS = [
  /pre-existing.*(failure|issue|problem)/i,
  /also failing on main/i,
  /not (introduced|caused) by this PR/i,
  /main branch.*(is|also).*(failing|broken|red)/i,
  /failure.*(originat|com).*(from|on) main/i,
  /same (failure|error|issue) on main/i,
];

export function looksLikeMainRootCause(output: string): boolean {
  const tail = output.slice(-2000);
  return MAIN_ROOT_CAUSE_PATTERNS.some((p) => p.test(tail));
}

/**
 * Extract a fix PR number from Claude's output.
 * Looks for patterns like github.com/.../pull/1234 or "PR #1234".
 */
function extractFixPrNumber(output: string): number | null {
  const tail = output.slice(-3000);
  const urlMatch = tail.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/);
  if (urlMatch) return parseInt(urlMatch[1], 10);
  const prMatch = tail.match(/(?:PR|pull request)\s*#(\d+)/i);
  if (prMatch) return parseInt(prMatch[1], 10);
  return null;
}

// ── Main Branch CI Check (daemon wrapper) ────────────────────────────────────

export { type MainBranchStatus };

const MAIN_BRANCH_KEY = 'main-branch';

/**
 * Check main branch CI with daemon-specific cooldown and abandoned tracking.
 * Delegates to the pure lib function for the actual API call.
 */
export async function checkMainBranch(config: PatrolConfig): Promise<MainBranchStatus> {
  const notRed: MainBranchStatus = { isRed: false, runId: null, sha: '', htmlUrl: '' };

  // Check cooldown and abandoned status first
  if (isMainBranchAbandoned(MAIN_BRANCH_KEY)) {
    log(`  ${cl.yellow}Main branch fix abandoned (${MAIN_BRANCH_ABANDON_THRESHOLD} attempts) — needs human intervention${cl.reset}`);
    return notRed;
  }
  if (isRecentlyProcessed(MAIN_BRANCH_KEY, MAIN_BRANCH_COOLDOWN_SECONDS)) {
    log(`  ${cl.dim}Main branch recently processed — skipping (${MAIN_BRANCH_COOLDOWN_SECONDS}s cooldown)${cl.reset}`);
    return notRed;
  }

  try {
    const status = await libCheckMainBranch(config.repo);

    if (status.isRed) {
      log(`  ${cl.red}🔴 Main branch CI is RED${cl.reset} (run #${status.runId}, sha ${status.sha.slice(0, 8)})`);

      // Track red-since state
      if (!getMainRedSince()) {
        setMainRedSince(new Date().toISOString());
      }

      // Identify likely culprits (PRs merged since last green)
      const culprits = await libFindRecentMerges(config.repo, status.lastGreenAt).catch(() => [] as RecentMerge[]);
      if (culprits.length > 0) {
        log(`  Likely culprits: ${culprits.map((c) => `#${c.prNumber} (${c.title.slice(0, 40)})`).join(', ')}`);
      }
    } else {
      // Main is green — reset tracking if it was red before
      if (getMainRedSince()) {
        log(`  Main branch recovered (was red since ${getMainRedSince()})`);
        clearMainRedSince();
        resetMainFixAttempts();
        resetFailCount(MAIN_BRANCH_KEY);
      }
      log(`  ${cl.green}Main branch CI is green${cl.reset}`);
    }

    return status;
  } catch (e) {
    log(`  ${cl.yellow}Warning: could not check main branch CI: ${e instanceof Error ? e.message : String(e)}${cl.reset}`);
    return notRed;
  }
}

export async function fixMainBranch(status: MainBranchStatus, config: PatrolConfig): Promise<void> {
  log(`${cl.bold}→${cl.reset} Fixing main branch CI (run #${status.runId})`);

  if (config.dryRun) {
    log(`  ${cl.dim}[DRY RUN] Would invoke Claude to fix main branch CI${cl.reset}`);
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

  const attemptNum = incrementMainFixAttempts();
  log(`  Fix attempt #${attemptNum}`);

  // Create an isolated worktree for the fix (detached HEAD at origin/main).
  // Claude will create its own fix branch from there.
  const projectRoot = git('rev-parse', '--show-toplevel');
  const wtName = `patrol-main-${Date.now()}`;
  let worktreePath: string;
  try {
    worktreePath = createWorktree(projectRoot, wtName, 'origin/main', { detach: true });
    log(`  Worktree: ${cl.dim}${worktreePath}${cl.reset}`);
  } catch (e) {
    log(`${cl.red}✗ Failed to create worktree for main branch fix: ${e instanceof Error ? e.message : String(e)}${cl.reset}`);
    markProcessed(MAIN_BRANCH_KEY);
    return;
  }

  const prompt = buildMainBranchPrompt(status.runId!, config.repo);
  const startTime = Date.now();

  let outcome: FixOutcome = 'fixed';
  let reason = '';

  try {
    const result = await spawnClaude(prompt, config, { cwd: worktreePath });
    const elapsedS = Math.floor((Date.now() - startTime) / 1000);

    if (result.timedOut) {
      const failCount = recordFailure(MAIN_BRANCH_KEY);
      outcome = 'timeout';
      reason = `Killed after ${config.timeoutMinutes}m timeout — attempt ${failCount}`;
      log(`${cl.red}✗ Main branch fix timed out after ${config.timeoutMinutes}m${cl.reset} (attempt ${failCount})`);

      if (failCount >= MAIN_BRANCH_ABANDON_THRESHOLD) {
        reason = `Abandoned after ${failCount} failures (timeout)`;
        log(`${cl.red}✗ Main branch fix abandoned after ${failCount} failures${cl.reset}`);
      }
    } else if (result.exitCode === 0 && !result.hitMaxTurns) {
      const isNoOp = looksLikeNoOp(result.output);
      outcome = isNoOp ? 'no-op' : 'fixed';
      if (isNoOp) {
        recordFailure(MAIN_BRANCH_KEY);
        reason = 'No-op: agent determined issue needs human intervention';
        log(`${cl.yellow}⚠ Main branch fix no-op — agent stopped early${cl.reset} (${elapsedS}s)`);
      } else {
        resetFailCount(MAIN_BRANCH_KEY);
        log(`${cl.green}✓ Main branch CI fix processed${cl.reset} (${elapsedS}s)`);
        // Track the fix PR so we can poll for merge and verify main is green
        const fixPrNum = extractFixPrNumber(result.output);
        if (fixPrNum) {
          trackMainFixPr(fixPrNum);
          log(`  ${cl.cyan}Tracking fix PR #${fixPrNum} for merge verification${cl.reset}`);
        }
      }
    } else if (result.hitMaxTurns) {
      const failCount = recordFailure(MAIN_BRANCH_KEY);
      outcome = 'max-turns';
      reason = `Hit max turns (${config.maxTurns}) — attempt ${failCount}`;
      log(`${cl.yellow}⚠ Main branch fix hit max turns after ${elapsedS}s${cl.reset}`);

      if (failCount >= MAIN_BRANCH_ABANDON_THRESHOLD) {
        reason = `Abandoned after ${failCount} failures`;
        log(`${cl.red}✗ Main branch fix abandoned after ${failCount} failures${cl.reset}`);
      }
    } else {
      outcome = 'error';
      reason = `Exit code: ${result.exitCode}`;
      log(`${cl.red}✗ Main branch fix failed${cl.reset} (exit: ${result.exitCode}, ${elapsedS}s)`);
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
    removeWorktree(worktreePath);
    markProcessed(MAIN_BRANCH_KEY);
  }
}

// ── Claude spawning ─────────────────────────────────────────────────────────

export function spawnClaude(
  prompt: string,
  config: PatrolConfig,
  opts?: { cwd?: string },
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
      cwd: opts?.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let output = '';
    let timedOut = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

    const clearTimers = () => {
      clearTimeout(timer);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
        forceKillTimer = null;
      }
    };

    // Hard timeout — kill subprocess if it runs too long
    const timeoutMs = config.timeoutMinutes * 60 * 1000;
    const timer = setTimeout(() => {
      timedOut = true;
      log(`  ${cl.yellow}⚠ Claude subprocess timed out after ${config.timeoutMinutes}m — killing${cl.reset}`);
      child.kill('SIGTERM');
      // Force kill if SIGTERM doesn't exit within 10s.
      // Note: child.killed is true as soon as kill() is called, so we check
      // exitCode/signalCode instead to know if the process actually exited.
      forceKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
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
      clearTimers();
      resolve({
        exitCode: code ?? 1,
        output,
        hitMaxTurns: output.includes('Reached max turns'),
        timedOut,
      });
    });
    child.on('error', (err) => {
      clearTimers();
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
      body: { labels: [LABELS.PR_PATROL_WORKING] },
    });
    claimedPr = prNum;
    setPersistedClaimedPr(prNum);
  } catch {
    log(`  ${cl.yellow}Warning: could not add ${LABELS.PR_PATROL_WORKING} label to PR #${prNum}${cl.reset}`);
  }
}

async function releasePr(prNum: number, repo: string): Promise<void> {
  try {
    await githubApi(`/repos/${repo}/issues/${prNum}/labels/${encodeURIComponent(LABELS.PR_PATROL_WORKING)}`, {
      method: 'DELETE',
    });
  } catch (e) {
    // 404 is expected (label already absent) — swallow silently.
    // Any other error (network, 500, auth) needs visibility since a stale
    // pr-patrol:working label makes detectAllPrIssuesFromNodes skip the PR.
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes('404') && !msg.includes('Not Found')) {
      log(`  Warning: could not remove pr-patrol:working label from PR #${prNum}: ${msg}`);
    }
  }
  if (claimedPr === prNum) {
    claimedPr = null;
    setPersistedClaimedPr(null);
  }
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

export interface FixPrResult {
  /** True when the PR's CI failure is caused by main branch being broken, not the PR itself. */
  mainIsRootCause: boolean;
}

export async function fixPr(pr: ScoredPr, config: PatrolConfig): Promise<FixPrResult> {
  log(`${cl.bold}→${cl.reset} Fixing PR ${cl.cyan}#${pr.number}${cl.reset} (${pr.title})`);
  log(`  Issues: ${cl.yellow}${pr.issues.join(', ')}${cl.reset}`);
  log(`  Branch: ${cl.dim}${pr.branch}${cl.reset}`);

  if (config.dryRun) {
    log(`  ${cl.dim}[DRY RUN] Would invoke Claude to fix${cl.reset}`);
    appendJsonl(JSONL_FILE, {
      type: 'pr_result',
      pr_num: pr.number,
      issues: pr.issues,
      outcome: 'dry-run' as FixOutcome,
      elapsed_s: 0,
    });
    markProcessed(pr.number);
    return { mainIsRootCause: false };
  }

  // ── Create worktree ──────────────────────────────────────────────
  const projectRoot = git('rev-parse', '--show-toplevel');
  const wtName = `patrol-pr-${pr.number}`;
  let worktreePath: string;
  try {
    worktreePath = createWorktree(projectRoot, wtName, pr.branch);
    log(`  Worktree: ${cl.dim}${worktreePath}${cl.reset}`);
  } catch (e) {
    log(`${cl.red}✗ Failed to create worktree for PR #${pr.number}: ${e instanceof Error ? e.message : String(e)}${cl.reset}`);
    return { mainIsRootCause: false };
  }

  // ── Automated rebase pre-step (runs in worktree) ──────────────────
  // For stale or conflicting PRs, try a plain git rebase first.
  // This saves the full Claude spawn (~5 turns, ~3-10 min) when the
  // rebase resolves cleanly. Even when GitHub reports CONFLICTING,
  // git rebase can auto-resolve many cases (different merge strategies).
  // Cost of a failed attempt is negligible (<1s of git commands).
  if (pr.issues.includes('stale') || pr.issues.includes('conflict')) {
    log('  Attempting automated rebase (no Claude needed)...');
    const rebaseResult = tryAutomatedRebase(pr.branch, worktreePath);

    if (rebaseResult.success) {
      log(`  ✓ Automated rebase ${rebaseResult.status} — no Claude needed`);

      // Strip both 'stale' and 'conflict' — rebase resolved them
      const remainingIssues = pr.issues.filter((i) => i !== 'stale' && i !== 'conflict');
      if (remainingIssues.length === 0) {
        removeWorktree(worktreePath);
        appendJsonl(JSONL_FILE, {
          type: 'pr_result',
          pr_num: pr.number,
          issues: pr.issues,
          outcome: 'fixed' as FixOutcome,
          elapsed_s: 0,
          reason: `automated-rebase: ${rebaseResult.status}`,
        });
        markProcessed(pr.number);
        return { mainIsRootCause: false };
      }
      // Remaining issues need Claude — update pr.issues so Claude doesn't re-address resolved ones
      pr.issues = remainingIssues;
      log(`  Remaining issues after rebase: ${remainingIssues.join(', ')} — falling through to Claude`);
    } else {
      log(`  Automated rebase failed (${rebaseResult.status}) — falling through to Claude`);
    }
  }

  await claimPr(pr.number, config.repo);

  // Compute issue-specific budget (capped by global config)
  // Reduce budget on retry — the full budget already failed once, so give less on subsequent attempts
  const failCount = getFailCount(pr.number);
  const { maxTurns: effectiveMaxTurns, timeoutMinutes: effectiveTimeout } =
    computeEffectiveBudget(pr.issues, config.maxTurns, config.timeoutMinutes, failCount);

  if (failCount > 0) {
    log(`  ${cl.dim}Retry #${failCount + 1} — budget reduced to ${effectiveMaxTurns} turns / ${effectiveTimeout}m${cl.reset}`);
  }
  log(`  Budget: ${effectiveMaxTurns} max-turns, ${effectiveTimeout}m timeout (based on: ${pr.issues.join(', ')})`);

  // Post "attempting fix" event comment before spawning Claude
  await postEventComment(pr.number, config.repo, buildFixAttemptComment(pr.issues))
    .catch((e: unknown) => log(`  Warning: could not post fix attempt comment: ${e instanceof Error ? e.message : String(e)}`));

  const prompt = buildPrompt(pr, config.repo);
  const startTime = Date.now();

  let outcome: FixOutcome = 'fixed';
  let reason = '';
  let mainIsRootCause = false;

  try {
    const result = await spawnClaude(prompt, {
      ...config,
      maxTurns: effectiveMaxTurns,
      timeoutMinutes: effectiveTimeout,
    }, { cwd: worktreePath });
    const elapsedS = Math.floor((Date.now() - startTime) / 1000);

    if (result.timedOut) {
      // Timeouts count toward abandonment — a PR that times out repeatedly
      // is likely unfixable and should not keep burning compute.
      const failCount = recordFailure(pr.number);
      outcome = 'timeout';
      reason = `Killed after ${effectiveTimeout}m timeout — attempt ${failCount}`;
      log(`${cl.red}✗ PR #${pr.number} timed out after ${effectiveTimeout}m${cl.reset} (attempt ${failCount})`);

      if (failCount >= 2) {
        reason = `Abandoned after ${failCount} failures (timeout)`;
        log(`${cl.red}✗ PR #${pr.number} abandoned after ${failCount} consecutive failures${cl.reset}`);
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
        if (looksLikeMainRootCause(result.output)) {
          // PR's CI failure is caused by main being broken — don't penalize this PR
          mainIsRootCause = true;
          reason = `No-op: CI failure is pre-existing on main branch`;
          log(`${cl.yellow}⚠ PR #${pr.number} no-op — root cause is on main branch${cl.reset} (${elapsedS}s)`);
        } else {
          // No-op: Claude determined the issue can't be fixed automatically.
          // Don't reset fail count — treat like a soft failure so the PR
          // gets skipped on future cycles instead of being retried forever.
          const failCount = recordFailure(pr.number);
          reason = `No-op: agent determined issue needs human intervention (attempt ${failCount})`;
          log(`${cl.yellow}⚠ PR #${pr.number} no-op — agent stopped early${cl.reset} (${elapsedS}s)`);
        }

        await postEventComment(pr.number, config.repo, buildNoOpComment(pr.issues))
          .catch((e: unknown) => log(`  Warning: could not post no-op comment: ${e instanceof Error ? e.message : String(e)}`));
      } else {
        resetFailCount(pr.number);
        log(`${cl.green}✓ PR #${pr.number} processed successfully${cl.reset} (${elapsedS}s)`);

        // Post fix-complete summary comment
        const outputTail = result.output.slice(-500);
        await postEventComment(pr.number, config.repo, buildFixCompleteComment(elapsedS, effectiveMaxTurns, config.model, pr.issues, outputTail))
          .catch((e: unknown) => log(`  Warning: could not post fix-complete comment: ${e instanceof Error ? e.message : String(e)}`));
      }
    } else if (result.hitMaxTurns) {
      const failCount = recordFailure(pr.number);
      outcome = 'max-turns';
      reason = `Hit max turns (${effectiveMaxTurns}) — attempt ${failCount}`;
      log(`${cl.yellow}⚠ PR #${pr.number} hit max turns after ${elapsedS}s${cl.reset} (attempt ${failCount})`);

      if (failCount >= 2) {
        reason = `Abandoned after ${failCount} failures`;
        log(
          `${cl.red}✗ PR #${pr.number} abandoned after ${failCount} consecutive failures${cl.reset}`,
        );
        await postEventComment(pr.number, config.repo, buildAbandonmentComment(failCount, pr.issues))
          .catch((e: unknown) => log(`  Warning: could not post abandonment comment: ${e instanceof Error ? e.message : String(e)}`));
      }
    } else {
      outcome = 'error';
      reason = `Exit code: ${result.exitCode}`;
      log(
        `${cl.red}✗ PR #${pr.number} processing failed${cl.reset} (exit: ${result.exitCode}, ${elapsedS}s)`,
      );

      // Track errors as failures so the PR gets abandoned after repeated failures
      // (previously missing — errored PRs would retry forever after cooldown expired)
      const failCount = recordFailure(pr.number);
      if (failCount >= 2) {
        reason = `Abandoned after ${failCount} failures (last: exit code ${result.exitCode})`;
        log(
          `${cl.red}✗ PR #${pr.number} abandoned after ${failCount} consecutive failures${cl.reset}`,
        );
        await postEventComment(pr.number, config.repo, buildAbandonmentComment(failCount, pr.issues))
          .catch((e: unknown) => log(`  Warning: could not post abandonment comment: ${e instanceof Error ? e.message : String(e)}`));
      }
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

    // Clean up worktree (handles rebase/merge abort internally)
    removeWorktree(worktreePath);

    markProcessed(pr.number);
  }

  return { mainIsRootCause };
}
