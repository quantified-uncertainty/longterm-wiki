/**
 * PR Patrol — Parallel dispatch engine
 *
 * Dispatches PR fixes in parallel using temporary git worktrees.
 * Each fix runs in its own worktree (created and destroyed per-fix),
 * with no dependency on agent workspace slots.
 *
 * Designed to complement the existing serial daemon — shares cooldowns, failure
 * tracking, and claim labels. New subcommand: `crux pr-patrol parallel`.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { tryRebaseAndVerify } from './rebase-verify.ts';
import { gitIn, gitSafe, gitSafeIn } from '../lib/git.ts';
import { parseIntOpt } from '../lib/cli.ts';
import {
  getGitHubToken,
  isMissingTokenError,
  MISSING_TOKEN_SUMMARY,
  REPO,
} from '../lib/github.ts';
import type { PatrolConfig, ScoredPr, FixOutcome } from './types.ts';
import {
  appendJsonl,
  cl,
  ensureDirs,
  getFailCount,
  isAbandoned,
  isAutoMergeDisabled,
  isRecentlyProcessed,
  JSONL_FILE,
  log,
  logHeader,
  markProcessed,
  recordFailure,
  resetFailCount,
  setParallelState,
} from './state.ts';
import {
  detectAllPrIssues,
  fetchOpenPrs,
} from './detection.ts';
import { rankPrs, computeEffectiveBudget } from './scoring.ts';
import { buildPrompt } from './prompts.ts';
import {
  looksLikeNoOp,
  looksLikeMainRootCause,
  spawnClaude,
} from './execution.ts';
import {
  tryClaimPr,
  releasePrIfClaimed,
  defaultClaimDeps,
  type ClaimDeps,
} from './claim.ts';
import {
  buildAbandonmentComment,
  buildFixAttemptComment,
  buildFixCompleteComment,
  buildNoOpComment,
  buildTimeoutComment,
  buildStatusCommentBody,
  postEventComment,
  upsertStatusComment,
} from './comments.ts';
import {
  findMergeCandidates,
  enqueuePr,
  undraftPr,
  reconcileMergeQueueLabels,
} from './merge.ts';
import { checkDeployHealth as libCheckDeployHealth } from '../lib/pr-analysis/deploy-status.ts';
import type { DeployHealthStatus } from '../lib/pr-analysis/deploy-status.ts';

// ── Parallel config ──────────────────────────────────────────────────────────

export interface ParallelConfig extends PatrolConfig {
  maxConcurrent: number;
  abandonThreshold: number;
  /** Directory to create worktrees in. Defaults to /tmp/pr-patrol-worktrees */
  worktreeDir: string;
}

// ── Worktree management ──────────────────────────────────────────────────────

/** Get the repo root (for creating worktrees from). */
function getRepoRoot(): string {
  return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
}

/** Create a temporary worktree for a PR branch. Returns the worktree path. */
function createPatrolWorktree(branch: string, prNumber: number, worktreeDir: string): string {
  mkdirSync(worktreeDir, { recursive: true });
  const wtPath = join(worktreeDir, `patrol-pr-${prNumber}-${Date.now()}`);

  // Remove stale worktree at similar paths
  gitSafe('worktree', 'prune');

  // Fetch the branch and create worktree in detached HEAD mode.
  // Using --detach avoids "branch is already checked out" errors when
  // manual agents or other worktrees have the same branch checked out.
  gitSafe('fetch', 'origin', branch);
  let result = gitSafe('worktree', 'add', '--detach', wtPath, `origin/${branch}`);
  if (!result.ok) {
    // Fallback: try with -B (force create local branch)
    result = gitSafe('worktree', 'add', '-B', `patrol-${prNumber}`, wtPath, `origin/${branch}`);
  }
  if (!result.ok) {
    throw new Error(`Failed to create worktree: ${result.stderr}`);
  }

  return wtPath;
}

/** Remove a patrol worktree. Best-effort cleanup. */
function removePatrolWorktree(wtPath: string): void {
  if (!wtPath || !existsSync(wtPath)) return;

  // Abort any in-progress rebase/merge
  gitSafeIn(wtPath, 'rebase', '--abort');
  gitSafeIn(wtPath, 'merge', '--abort');

  const result = gitSafe('worktree', 'remove', '--force', wtPath);
  if (!result.ok) {
    try { rmSync(wtPath, { recursive: true, force: true }); } catch { /* best-effort */ }
    gitSafe('worktree', 'prune');
  }
}

/** Clean up any stale patrol worktrees (from crashed processes). */
function cleanStaleWorktrees(worktreeDir: string): void {
  if (!existsSync(worktreeDir)) return;
  try {
    const entries = execSync('ls', { cwd: worktreeDir, encoding: 'utf-8' })
      .trim().split('\n').filter(Boolean);
    for (const name of entries) {
      if (!name.startsWith('patrol-pr-')) continue;
      const wtPath = join(worktreeDir, name);
      // If the worktree is older than 2 hours, it's stale
      try {
        const mtime = statSync(wtPath).mtimeMs / 1000;
        const age = Date.now() / 1000 - mtime;
        if (age > 2 * 60 * 60) {
          log(`  ${cl.yellow}Cleaning stale worktree: ${name}${cl.reset}`);
          removePatrolWorktree(wtPath);
        }
      } catch { /* skip */ }
    }
  } catch { /* dir may not exist yet */ }
  gitSafe('worktree', 'prune');
}




// ── PR claim management (parallel-safe) ──────────────────────────────────────
//
// Delegates to the shared helpers in ./claim.ts so both the serial
// (execution.ts) and parallel dispatch paths use the same
// ownership-tracked claim/release flow. See claim.ts for the QUA-400
// race-condition context.

const parallelClaimDeps: ClaimDeps = defaultClaimDeps((prNum, reason) => {
  log(`  ${cl.yellow}PR #${prNum} claim skipped: ${reason}${cl.reset}`);
});

/**
 * Attempt to claim a PR. Returns `true` on success (we added the working
 * label), `false` when the PR is already claimed by another worker or the
 * claim write failed.
 */
async function claimPr(prNum: number, repo: string): Promise<boolean> {
  return tryClaimPr(prNum, repo, parallelClaimDeps);
}

/**
 * Release the working label — only if `didClaim === true`. When another
 * worker holds the label, this is a no-op.
 */
async function releasePr(
  didClaim: boolean,
  prNum: number,
  repo: string,
): Promise<void> {
  if (!didClaim) return;
  try {
    await releasePrIfClaimed(didClaim, prNum, repo, parallelClaimDeps);
  } catch (e) {
    log(
      `  Warning: could not remove pr-patrol:working label from PR #${prNum}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

// ── Outcome classification ───────────────────────────────────────────────────

interface ClaudeResult {
  exitCode: number;
  output: string;
  hitMaxTurns: boolean;
  timedOut: boolean;
  /** QUA-1078: optional fields from spawnClaude's stream-json mode. */
  budgetExceeded?: boolean;
  inputTokens?: number;
}

interface ClassifiedOutcome {
  outcome: FixOutcome;
  reason: string;
  mainIsRootCause: boolean;
}

/**
 * Classify the outcome of a Claude fix session.
 * Shared logic between serial and parallel modes.
 */
export function classifyFixOutcome(
  result: ClaudeResult,
  prNumber: number,
  effectiveTimeout: number,
  effectiveMaxTurns: number,
): ClassifiedOutcome {
  if (result.timedOut || result.budgetExceeded) {
    const failCount = recordFailure(prNumber);
    // QUA-1078: budget kills are shaped like timeouts (daemon-initiated,
    // partial work) — fold both into the same branch but emit a clearer
    // reason so the JSONL/PR-comment isn't a meaningless "Exit code: null".
    const cause = result.budgetExceeded ? 'budget' : 'timeout';
    const reason = failCount >= 2
      ? `Abandoned after ${failCount} failures (${cause})`
      : result.budgetExceeded
        ? `Killed after exceeding cumulative input_tokens (observed ${result.inputTokens ?? '?'}) — attempt ${failCount}`
        : `Killed after ${effectiveTimeout}m timeout — attempt ${failCount}`;
    return { outcome: 'timeout', reason, mainIsRootCause: false };
  }

  if (result.exitCode === 0 && !result.hitMaxTurns) {
    const isNoOp = looksLikeNoOp(result.output);
    if (isNoOp) {
      if (looksLikeMainRootCause(result.output)) {
        return {
          outcome: 'no-op',
          reason: 'No-op: CI failure is pre-existing on main branch',
          mainIsRootCause: true,
        };
      }
      const failCount = recordFailure(prNumber);
      return {
        outcome: 'no-op',
        reason: `No-op: agent determined issue needs escalation to coordinator (attempt ${failCount})`,
        mainIsRootCause: false,
      };
    }

    resetFailCount(prNumber);
    return { outcome: 'fixed', reason: '', mainIsRootCause: false };
  }

  if (result.hitMaxTurns) {
    const failCount = recordFailure(prNumber);
    const reason = failCount >= 2
      ? `Abandoned after ${failCount} failures`
      : `Hit max turns (${effectiveMaxTurns}) — attempt ${failCount}`;
    return { outcome: 'max-turns', reason, mainIsRootCause: false };
  }

  // Error exit
  const failCount = recordFailure(prNumber);
  const reason = failCount >= 2
    ? `Abandoned after ${failCount} failures (last: exit code ${result.exitCode})`
    : `Exit code: ${result.exitCode}`;
  return { outcome: 'error', reason, mainIsRootCause: false };
}

// ── Fix PR in worktree ───────────────────────────────────────────────────────

interface FixResult {
  prNumber: number;
  outcome: FixOutcome;
  reason: string;
  elapsedS: number;
}

async function fixPrInWorktree(
  pr: ScoredPr,
  config: ParallelConfig,
): Promise<FixResult> {
  const prefix = `[#${pr.number}]`;
  log(`${prefix} Starting fix: ${pr.title}`);
  log(`${prefix} Issues: ${pr.issues.join(', ')}`);

  if (config.dryRun) {
    log(`${prefix} ${cl.dim}[DRY RUN] Would fix PR #${pr.number}${cl.reset}`);
    return { prNumber: pr.number, outcome: 'dry-run', reason: '', elapsedS: 0 };
  }

  const startTime = Date.now();
  let worktreePath = '';
  // `didClaim` is declared outside the try so the finally block can gate
  // `releasePr` on it and avoid deleting another worker's label
  // (QUA-400 critical review — see claim.ts for the full rationale).
  let didClaim = false;

  try {
    // Create worktree for this PR
    worktreePath = createPatrolWorktree(pr.branch, pr.number, config.worktreeDir);
    log(`${prefix} Worktree: ${cl.dim}${worktreePath}${cl.reset}`);

    // ── Claim the PR BEFORE any rebase/verify round-trip ────────────
    // QUA-400: `tryRebaseAndVerify` below polls GitHub for ~12s. If we
    // ran it before claiming, another patrol instance could grab the
    // label during that window and our `finally` release would delete
    // the other worker's claim. Claim-first + didClaim gating closes
    // both halves of the race.
    didClaim = await claimPr(pr.number, config.repo);
    if (!didClaim) {
      log(`${prefix} ${cl.yellow}Claim lost to concurrent worker — skipping${cl.reset}`);
      markProcessed(pr.number);
      appendJsonl(JSONL_FILE, {
        type: 'pr_result',
        pr_num: pr.number,
        issues: pr.issues,
        outcome: 'no-op' as FixOutcome,
        elapsed_s: Math.floor((Date.now() - startTime) / 1000),
        reason: 'Claim lost to concurrent worker',
        parallel: true,
      });
      return {
        prNumber: pr.number,
        outcome: 'no-op',
        reason: 'Claim lost to concurrent worker',
        elapsedS: Math.floor((Date.now() - startTime) / 1000),
      };
    }

    // Automated rebase pre-step
    if (pr.issues.includes('stale') || pr.issues.includes('conflict')) {
      log(`${prefix} Attempting automated rebase...`);
      const outcome = await tryRebaseAndVerify(
        pr.branch,
        pr.number,
        pr.issues,
        worktreePath,
        config.repo,
      );

      if (outcome.kind === 'verify-failed') {
        log(
          `${prefix} ${cl.yellow}⚠ Rebase reported ${outcome.rebaseStatus} but GitHub still shows conflict: ${outcome.verify.reason}${cl.reset} — falling through to Claude`,
        );
        appendJsonl(JSONL_FILE, {
          type: 'rebase_verify_failed',
          pr_num: pr.number,
          rebase_status: outcome.rebaseStatus,
          reason: outcome.verify.reason,
          mergeable: outcome.verify.mergeable,
          merge_state_status: outcome.verify.mergeStateStatus,
          attempts: outcome.verify.attempts,
        });
      } else if (outcome.kind === 'fully-resolved') {
        log(`${prefix} Automated rebase ${outcome.rebaseStatus} — no Claude needed`);
        markProcessed(pr.number);
        return {
          prNumber: pr.number,
          outcome: 'fixed',
          reason: `automated-rebase: ${outcome.rebaseStatus} (verified)`,
          elapsedS: Math.floor((Date.now() - startTime) / 1000),
        };
      } else if (outcome.kind === 'partially-resolved') {
        log(`${prefix} Automated rebase ${outcome.rebaseStatus} — no Claude needed`);
        pr.issues = outcome.remainingIssues;
        log(`${prefix} Remaining issues after rebase: ${outcome.remainingIssues.join(', ')}`);
      } else {
        // outcome.kind === 'rebase-failed'
        // On retry for conflict-only PRs, try rebase-only with Claude (simpler prompt)
        const failCount = getFailCount(pr.number);
        if (failCount > 0 && pr.issues.length === 1 && pr.issues[0] === 'conflict') {
          log(`${prefix} Retry #${failCount + 1} for conflict-only PR — using rebase-only strategy`);
          // Claim was already acquired at the top of the try block; no
          // need to re-claim here.
          const rebasePrompt = `Rebase the current branch onto origin/main. Resolve any merge conflicts. Then force-push with: git push --force-with-lease. Do NOT fix CI issues, do NOT address code review comments — ONLY resolve the merge conflicts and push.`;
          const rebaseResult2 = await spawnClaude(rebasePrompt, {
            ...config,
            maxTurns: 60,
            timeoutMinutes: 30,
          }, { cwd: worktreePath, context: { prNumber: pr.number, label: 'rebase-only' } });
          const elapsedS = Math.floor((Date.now() - startTime) / 1000);
          const claudeOutcome: FixOutcome = rebaseResult2.exitCode === 0 && !rebaseResult2.hitMaxTurns ? 'fixed' : 'error';
          if (claudeOutcome === 'fixed') {
            resetFailCount(pr.number);
            log(`${prefix} ${cl.green}Rebase-only fix succeeded${cl.reset} (${elapsedS}s)`);
          } else {
            recordFailure(pr.number);
            log(`${prefix} ${cl.red}Rebase-only fix failed${cl.reset} (${elapsedS}s)`);
          }
          appendJsonl(JSONL_FILE, {
            type: 'pr_result', pr_num: pr.number, issues: pr.issues,
            outcome: claudeOutcome, elapsed_s: elapsedS, reason: 'rebase-only strategy', parallel: true,
          });
          markProcessed(pr.number);
          return { prNumber: pr.number, outcome: claudeOutcome, reason: 'rebase-only strategy', elapsedS };
        }
        log(`${prefix} Automated rebase failed (${outcome.status}) — falling through to Claude`);
      }
    }

    // Claim was already acquired at the top of the try block
    // (before tryRebaseAndVerify); no need to re-claim here.

    // Compute budget — full budget every attempt (no reduction on retry)
    const failCount = getFailCount(pr.number);
    const { maxTurns: effectiveMaxTurns, timeoutMinutes: effectiveTimeout } =
      computeEffectiveBudget(pr.issues, config.maxTurns, config.timeoutMinutes, 0);

    if (failCount > 0) {
      log(`${prefix} Retry #${failCount + 1} (full budget — no reduction)`);
    }
    log(`${prefix} Budget: ${effectiveMaxTurns} max-turns, ${effectiveTimeout}m timeout`);

    // Post "attempting fix" comment
    await postEventComment(pr.number, config.repo, buildFixAttemptComment(pr.issues))
      .catch((e: unknown) => log(`${prefix} Warning: could not post fix attempt comment: ${e instanceof Error ? e.message : String(e)}`));

    // Build prompt and spawn Claude in worktree (no .env loading needed — OAuth auth)
    const prompt = buildPrompt(pr, config.repo);
    const result = await spawnClaude(prompt, {
      ...config,
      maxTurns: effectiveMaxTurns,
      timeoutMinutes: effectiveTimeout,
    }, { cwd: worktreePath, context: { prNumber: pr.number } });

    const elapsedS = Math.floor((Date.now() - startTime) / 1000);

    // Classify outcome
    const classified = classifyFixOutcome(result, pr.number, effectiveTimeout, effectiveMaxTurns);

    // Post outcome comments
    if (classified.outcome === 'fixed') {
      log(`${prefix} ${cl.green}Fixed${cl.reset} (${elapsedS}s)`);
      const outputTail = result.output.slice(-500);
      await postEventComment(pr.number, config.repo, buildFixCompleteComment(elapsedS, effectiveMaxTurns, config.model, pr.issues, outputTail))
        .catch((e: unknown) => log(`${prefix} Warning: could not post fix-complete comment: ${e instanceof Error ? e.message : String(e)}`));
    } else if (classified.outcome === 'no-op') {
      log(`${prefix} ${cl.yellow}No-op${cl.reset}: ${classified.reason} (${elapsedS}s)`);
      await postEventComment(pr.number, config.repo, buildNoOpComment(pr.issues))
        .catch((e: unknown) => log(`${prefix} Warning: could not post no-op comment: ${e instanceof Error ? e.message : String(e)}`));
    } else if (classified.outcome === 'timeout') {
      log(`${prefix} ${cl.red}Timeout${cl.reset} (${elapsedS}s)`);
      const currentFailCount = getFailCount(pr.number);
      if (currentFailCount >= config.abandonThreshold) {
        await postEventComment(pr.number, config.repo, buildAbandonmentComment(currentFailCount, pr.issues))
          .catch((e: unknown) => log(`${prefix} Warning: could not post abandonment comment: ${e instanceof Error ? e.message : String(e)}`));
      } else {
        await postEventComment(pr.number, config.repo, buildTimeoutComment(currentFailCount, effectiveTimeout, pr.issues))
          .catch((e: unknown) => log(`${prefix} Warning: could not post timeout comment: ${e instanceof Error ? e.message : String(e)}`));
      }
    } else if (classified.outcome === 'max-turns') {
      log(`${prefix} ${cl.yellow}Max turns${cl.reset} (${elapsedS}s)`);
      const currentFailCount = getFailCount(pr.number);
      if (currentFailCount >= config.abandonThreshold) {
        await postEventComment(pr.number, config.repo, buildAbandonmentComment(currentFailCount, pr.issues))
          .catch((e: unknown) => log(`${prefix} Warning: could not post abandonment comment: ${e instanceof Error ? e.message : String(e)}`));
      }
    } else {
      log(`${prefix} ${cl.red}Error${cl.reset}: ${classified.reason} (${elapsedS}s)`);
      const currentFailCount = getFailCount(pr.number);
      if (currentFailCount >= config.abandonThreshold) {
        await postEventComment(pr.number, config.repo, buildAbandonmentComment(currentFailCount, pr.issues))
          .catch((e: unknown) => log(`${prefix} Warning: could not post abandonment comment: ${e instanceof Error ? e.message : String(e)}`));
      }
    }

    // Log to JSONL
    appendJsonl(JSONL_FILE, {
      type: 'pr_result',
      pr_num: pr.number,
      issues: pr.issues,
      outcome: classified.outcome,
      elapsed_s: elapsedS,
      reason: classified.reason || undefined,
      parallel: true,
    });

    markProcessed(pr.number);

    return {
      prNumber: pr.number,
      outcome: classified.outcome,
      reason: classified.reason,
      elapsedS,
    };
  } finally {
    // Only release the working label if THIS worker actually acquired
    // the claim — `releasePr(false, ...)` is a no-op so we never delete
    // another worker's label (QUA-400).
    await releasePr(didClaim, pr.number, config.repo);
    if (worktreePath) removePatrolWorktree(worktreePath);
  }
}

// ── Parallel dispatch ────────────────────────────────────────────────────────

interface CycleResult {
  dispatched: number;
  results: FixResult[];
}

/**
 * Dispatch fixes in parallel using worktrees.
 */
async function dispatchFixes(
  ranked: ScoredPr[],
  maxConcurrent: number,
  config: ParallelConfig,
): Promise<CycleResult> {
  const toFix = ranked.slice(0, maxConcurrent);

  if (toFix.length === 0) {
    return { dispatched: 0, results: [] };
  }

  log('');
  log(`${cl.bold}Dispatching ${toFix.length} fix(es) in parallel (worktrees):${cl.reset}`);
  for (const pr of toFix) {
    log(`  PR #${pr.number} (${pr.issues.join(', ')}) — ${pr.title}`);
  }
  log('');

  const promises = toFix.map((pr) =>
    fixPrInWorktree(pr, config).catch((e): FixResult => {
      log(`${cl.red}[#${pr.number}] Unexpected error: ${e instanceof Error ? e.message : String(e)}${cl.reset}`);
      return {
        prNumber: pr.number,
        outcome: 'error',
        reason: `Unexpected: ${e instanceof Error ? e.message : String(e)}`,
        elapsedS: 0,
      };
    }),
  );

  const settled = await Promise.allSettled(promises);
  const results = settled.map((r) =>
    r.status === 'fulfilled'
      ? r.value
      : {
          prNumber: 0,
          outcome: 'error' as FixOutcome,
          reason: `Promise rejected: ${r.reason}`,
          elapsedS: 0,
        },
  );

  return { dispatched: toFix.length, results };
}

// ── Single parallel cycle ────────────────────────────────────────────────────

let parallelCycleCount = 0;

export async function runParallelCycle(config: ParallelConfig): Promise<CycleResult> {
  parallelCycleCount++;
  logHeader('Parallel patrol cycle');

  // 0. Housekeeping: clean stale worktrees
  cleanStaleWorktrees(config.worktreeDir);

  // Write heartbeat at cycle start (so monitors can detect stalls)
  const writeHeartbeat = (status: 'idle' | 'dispatching' | 'sleeping', extra?: Partial<import('./state.ts').ParallelState>) => {
    setParallelState({
      lastHeartbeat: new Date().toISOString(),
      lastCycleAt: new Date().toISOString(),
      pid: process.pid,
      status,
      cycleCount: parallelCycleCount,
      prsScanned: 0,
      slotsUsed: [],
      dispatched: 0,
      fixed: 0,
      errors: 0,
      ...extra,
    });
  };

  // 1. Detect: Fetch open PRs and find issues
  const allPrs = await fetchOpenPrs(config);
  const detected = await detectAllPrIssues(allPrs, config);

  if (detected.length === 0) {
    log(`${cl.green}All PRs clean${cl.reset} — nothing to fix`);
    writeHeartbeat('idle', { prsScanned: allPrs.length });
    return { dispatched: 0, results: [] };
  }

  // Filter cooldowns and abandoned (parallel uses higher threshold than serial)
  const eligible = detected.filter((pr) => {
    if (getFailCount(pr.number) >= config.abandonThreshold) {
      log(`  ${cl.dim}Skipping PR #${pr.number} (abandoned — ${getFailCount(pr.number)} failures, threshold ${config.abandonThreshold})${cl.reset}`);
      return false;
    }
    if (isRecentlyProcessed(pr.number, config.cooldownSeconds)) {
      log(`  ${cl.dim}Skipping PR #${pr.number} (recently processed)${cl.reset}`);
      return false;
    }
    return true;
  });

  const ranked = rankPrs(eligible);
  if (ranked.length === 0) {
    log(`${cl.dim}All issues recently processed — nothing to fix${cl.reset}`);
    writeHeartbeat('idle', { prsScanned: allPrs.length });
    return { dispatched: 0, results: [] };
  }

  log(`${cl.bold}Fix queue${cl.reset} (${ranked.length} items):`);
  for (const pr of ranked) {
    log(`  [score=${pr.score}] PR ${cl.cyan}#${pr.number}${cl.reset}: ${pr.issues.join(',')} — ${pr.title}`);
  }

  // 2. Dispatch fixes (worktrees — no slot allocation needed)
  log(`${cl.green}Dispatching up to ${config.maxConcurrent} fix(es) via worktrees${cl.reset}`);

  writeHeartbeat('dispatching', { prsScanned: allPrs.length });
  const result = await dispatchFixes(ranked, config.maxConcurrent, config);

  // 4. Merge phase — reconcile labels, undraft, enqueue eligible PRs
  await reconcileMergeQueueLabels(allPrs, config);

  const deployHealth: DeployHealthStatus = await libCheckDeployHealth(config.repo).catch((e) => {
    log(`  ${cl.yellow}Warning: deploy health check failed: ${e instanceof Error ? e.message : String(e)}${cl.reset}`);
    return { healthy: true, lastDeploy: null, failingSince: null } as DeployHealthStatus;
  });

  // Undraft phase
  const draftCandidates = findMergeCandidates(allPrs).filter(
    (c) => !c.eligible && c.blockReasons.length === 1 && c.blockReasons[0] === 'is-draft',
  );
  const undraftedNumbers = new Set<number>();
  for (const candidate of draftCandidates) {
    if (config.dryRun) {
      log(`  [DRY RUN] Would undraft PR #${candidate.number}`);
      undraftedNumbers.add(candidate.number);
    } else {
      const success = await undraftPr(candidate.number, config);
      if (success) undraftedNumbers.add(candidate.number);
    }
  }

  // Re-evaluate merge candidates after undrafting
  const mergeCandidates = findMergeCandidates(allPrs).map((c) => {
    if (undraftedNumbers.has(c.number)) {
      const updated = { ...c, blockReasons: c.blockReasons.filter((r) => r !== 'is-draft') };
      return { ...updated, eligible: updated.blockReasons.length === 0 };
    }
    return c;
  });
  const eligibleForMerge = mergeCandidates.filter((c) => c.eligible);

  // Upsert status comments
  const prNodeByNumber = new Map(allPrs.map((p) => [p.number, p]));
  for (const mc of mergeCandidates) {
    const prNode = prNodeByNumber.get(mc.number);
    if (!prNode) continue;
    const statusBody = buildStatusCommentBody(prNode, mc.blockReasons);
    await upsertStatusComment(mc.number, config.repo, statusBody)
      .catch((e: unknown) => log(`  ${cl.yellow}Warning: could not upsert status comment on PR #${mc.number}: ${e instanceof Error ? e.message : String(e)}${cl.reset}`));
  }

  // Enqueue eligible PRs (skip if deploy is failing or auto-merge is repo-disabled)
  const enqueuedPrs: number[] = [];
  const autoMergeStatus = isAutoMergeDisabled();
  if (!deployHealth.healthy) {
    log(`  ${cl.yellow}Skipping merge enqueue — deploy pipeline is failing${cl.reset}`);
  } else if (autoMergeStatus.disabled && eligibleForMerge.length > 0) {
    log(
      `  ${cl.yellow}Skipping ${eligibleForMerge.length} merge enqueue(s) — auto-merge is disabled at the repository level (since ${autoMergeStatus.disabledAt}). Re-enable in repo Settings → Pull Requests → Allow auto-merge.${cl.reset}`,
    );
  } else {
    for (let i = 0; i < eligibleForMerge.length; i++) {
      const candidate = eligibleForMerge[i];
      const outcome = await enqueuePr(candidate, config);
      if (outcome === 'enqueued' || outcome === 'dry-run') {
        enqueuedPrs.push(candidate.number);
      }
      // If the first attempt tripped the repo-level circuit breaker, skip the
      // remaining candidates this cycle — they would all hit the same error.
      if (isAutoMergeDisabled().disabled) {
        const remaining = eligibleForMerge.length - i - 1;
        if (remaining > 0) {
          log(`  ${cl.yellow}Skipping ${remaining} remaining merge enqueue(s) this cycle — auto-merge disabled at repo level${cl.reset}`);
        }
        break;
      }
    }
  }

  // 5. Summary
  log('');
  logHeader('Parallel cycle complete');
  const fixed = result.results.filter((r) => r.outcome === 'fixed').length;
  const noOps = result.results.filter((r) => r.outcome === 'no-op').length;
  const errors = result.results.filter((r) => r.outcome === 'error' || r.outcome === 'timeout' || r.outcome === 'max-turns').length;
  const dryRuns = result.results.filter((r) => r.outcome === 'dry-run').length;

  const mergeInfo = enqueuedPrs.length > 0
    ? `, Enqueued: [${enqueuedPrs.map((n) => `#${n}`).join(', ')}]`
    : mergeCandidates.length > 0
      ? `, Merge candidates: ${mergeCandidates.length} (${eligibleForMerge.length} eligible)`
      : '';
  log(`Dispatched: ${result.dispatched}, Fixed: ${fixed}, No-op: ${noOps}, Errors: ${errors}${dryRuns > 0 ? `, Dry-run: ${dryRuns}` : ''}${mergeInfo}`);

  for (const r of result.results) {
    const icon = r.outcome === 'fixed' ? cl.green + '✓' :
                 r.outcome === 'dry-run' ? cl.dim + '○' :
                 r.outcome === 'no-op' ? cl.yellow + '⚠' :
                 cl.red + '✗';
    log(`  ${icon}${cl.reset} PR #${r.prNumber}: ${r.outcome} (${r.elapsedS}s)${r.reason ? ` — ${r.reason}` : ''}`);
  }

  // Log cycle summary
  appendJsonl(JSONL_FILE, {
    type: 'parallel_cycle_summary',
    dispatched: result.dispatched,
    fixed,
    no_ops: noOps,
    errors,
    prs_enqueued: enqueuedPrs.length > 0 ? enqueuedPrs : undefined,
    merge_candidates: mergeCandidates.length,
    merge_eligible: eligibleForMerge.length,
    deploy_healthy: deployHealth.healthy,
    results: result.results.map((r) => ({
      pr: r.prNumber,
      outcome: r.outcome,
      elapsed_s: r.elapsedS,
    })),
  });

  // Write state file for monitoring
  writeHeartbeat('sleeping', {
    prsScanned: allPrs.length,
    slotsUsed: [],
    dispatched: result.dispatched,
    fixed,
    errors,
  });

  return result;
}

// ── Parallel daemon (continuous loop) ────────────────────────────────────────

export async function runParallelDaemon(config: ParallelConfig): Promise<void> {
  ensureDirs();

  logHeader('PR Patrol Parallel starting');
  log(`Config: max-concurrent=${config.maxConcurrent}, worktree-dir=${config.worktreeDir}`);
  log(`  interval=${config.intervalSeconds}s, model=${config.model}, cooldown=${config.cooldownSeconds}s`);
  log(`  mode=${config.once ? 'single pass' : config.dryRun ? 'dry run' : 'continuous'}`);
  log(`  JSONL: ${JSONL_FILE}`);

  try {
    getGitHubToken();
  } catch (e) {
    if (isMissingTokenError(e)) {
      log(`${cl.red}ERROR: ${MISSING_TOKEN_SUMMARY}${cl.reset}`);
      process.exit(1);
    }
    throw e;
  }

  // Signal handlers for graceful shutdown
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('Shutting down parallel patrol...');
    // Locks will be cleaned up naturally on next cycle since they contain PIDs
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown());
  process.on('SIGTERM', () => shutdown());

  if (config.once) {
    await runParallelCycle(config);
    return;
  }

  let cycleCount = 0;
  while (!shuttingDown) {
    cycleCount++;
    try {
      await runParallelCycle(config);
    } catch (e) {
      log(`${cl.red}Parallel cycle failed: ${e instanceof Error ? e.message : String(e)}${cl.reset}`);
    }

    log(`${cl.dim}Sleeping ${config.intervalSeconds}s until next cycle...${cl.reset}`);
    await new Promise((r) => setTimeout(r, config.intervalSeconds * 1000));
  }
}

// ── Config builder ───────────────────────────────────────────────────────────

export function buildParallelConfig(
  args: string[],
  options: Record<string, unknown>,
): ParallelConfig {
  // Build base config inline (mirrors buildConfig in index.ts to avoid circular import)
  const base: PatrolConfig = {
    repo: (process.env.PR_PATROL_REPO as string) ?? REPO,
    intervalSeconds: parseIntOpt(
      options.interval ?? process.env.PR_PATROL_INTERVAL,
      300,
    ),
    maxTurns: parseIntOpt(
      options.maxTurns ?? process.env.PR_PATROL_MAX_TURNS,
      120,
    ),
    cooldownSeconds: parseIntOpt(
      options.cooldown ?? process.env.PR_PATROL_COOLDOWN,
      1800,
    ),
    staleHours: parseIntOpt(
      options.staleHours ?? process.env.PR_PATROL_STALE_HOURS,
      48,
    ),
    model:
      (options.model as string) ??
      process.env.PR_PATROL_MODEL ??
      'sonnet',
    skipPerms:
      options.skipPerms === true ||
      process.env.PR_PATROL_SKIP_PERMS === '1',
    once: options.once === true,
    dryRun: options.dryRun === true,
    verbose: options.verbose === true,
    reflectionInterval: Math.max(
      1,
      parseIntOpt(process.env.PR_PATROL_REFLECTION_INTERVAL, 10),
    ),
    timeoutMinutes: parseIntOpt(
      options.timeout ?? process.env.PR_PATROL_TIMEOUT_MINUTES,
      60,
    ),
    // QUA-1078: inline 50k input-token cap on spawnClaude. 0 disables.
    inputTokenCap: parseIntOpt(
      options.inputTokenCap ?? process.env.PR_PATROL_INPUT_TOKEN_CAP,
      50_000,
    ),
  };

  const defaultWorktreeDir = join(process.env.HOME ?? '/tmp', '.cache', 'pr-patrol', 'worktrees');

  return {
    ...base,
    maxConcurrent: typeof options.maxConcurrent === 'number'
      ? options.maxConcurrent
      : typeof options.maxConcurrent === 'string'
        ? parseInt(options.maxConcurrent, 10) || 5
        : typeof options.maxSlots === 'number'  // backward compat
          ? options.maxSlots as number
          : typeof options.maxSlots === 'string'
            ? parseInt(options.maxSlots, 10) || 5
            : 5,
    worktreeDir: typeof options.worktreeDir === 'string'
      ? options.worktreeDir
      : defaultWorktreeDir,
    abandonThreshold: typeof options.abandonThreshold === 'number'
      ? options.abandonThreshold
      : typeof options.abandonThreshold === 'string'
        ? parseInt(options.abandonThreshold, 10) || 4
        : 4,
  };
}
