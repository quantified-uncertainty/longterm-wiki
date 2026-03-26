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

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { tryAutomatedRebase } from '../lib/pr-analysis/rebase.ts';
import { gitIn, gitSafe, gitSafeIn } from '../lib/git.ts';
import { parseIntOpt } from '../lib/cli.ts';
import { REPO } from '../lib/github.ts';
import type { PatrolConfig, ScoredPr, FixOutcome } from './types.ts';
import {
  appendJsonl,
  cl,
  ensureDirs,
  getFailCount,
  isAbandoned,
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
  detectAllPrIssuesFromNodes,
  fetchOpenPrs,
} from './detection.ts';
import { rankPrs, computeEffectiveBudget } from './scoring.ts';
import { buildPrompt } from './prompts.ts';
import {
  looksLikeNoOp,
  looksLikeMainRootCause,
  spawnClaude,
} from './execution.ts';
import { githubApi } from '../lib/github.ts';
import { LABELS } from './types.ts';
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
        const stat = execSync(`stat -f %m "${wtPath}"`, { encoding: 'utf-8' }).trim();
        const age = Date.now() / 1000 - Number(stat);
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

async function claimPr(prNum: number, repo: string): Promise<void> {
  try {
    await githubApi(`/repos/${repo}/issues/${prNum}/labels`, {
      method: 'POST',
      body: { labels: [LABELS.PR_PATROL_WORKING] },
    });
  } catch {
    log(`  ${cl.yellow}Warning: could not add ${LABELS.PR_PATROL_WORKING} label to PR #${prNum}${cl.reset}`);
  }
}

async function releasePr(prNum: number, repo: string): Promise<void> {
  try {
    await githubApi(
      `/repos/${repo}/issues/${prNum}/labels/${encodeURIComponent(LABELS.PR_PATROL_WORKING)}`,
      { method: 'DELETE' },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes('404') && !msg.includes('Not Found')) {
      log(`  Warning: could not remove pr-patrol:working label from PR #${prNum}: ${msg}`);
    }
  }
}

// ── Outcome classification ───────────────────────────────────────────────────

interface ClaudeResult {
  exitCode: number;
  output: string;
  hitMaxTurns: boolean;
  timedOut: boolean;
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
  if (result.timedOut) {
    const failCount = recordFailure(prNumber);
    const reason = failCount >= 2
      ? `Abandoned after ${failCount} failures (timeout)`
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
        reason: `No-op: agent determined issue needs human intervention (attempt ${failCount})`,
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

  try {
    // Create worktree for this PR
    worktreePath = createPatrolWorktree(pr.branch, pr.number, config.worktreeDir);
    log(`${prefix} Worktree: ${cl.dim}${worktreePath}${cl.reset}`);

    // Automated rebase pre-step
    if (pr.issues.includes('stale') || pr.issues.includes('conflict')) {
      log(`${prefix} Attempting automated rebase...`);
      const rebaseResult = tryAutomatedRebase(pr.branch, worktreePath);

      if (rebaseResult.success) {
        log(`${prefix} Automated rebase ${rebaseResult.status} — no Claude needed`);
        const remainingIssues = pr.issues.filter((i) => i !== 'stale' && i !== 'conflict');
        if (remainingIssues.length === 0) {
          markProcessed(pr.number);
          return {
            prNumber: pr.number,
            outcome: 'fixed',
            reason: `automated-rebase: ${rebaseResult.status}`,
            elapsedS: Math.floor((Date.now() - startTime) / 1000),
          };
        }
        pr.issues = remainingIssues;
        log(`${prefix} Remaining issues after rebase: ${remainingIssues.join(', ')}`);
      } else {
        // On retry for conflict-only PRs, try rebase-only with Claude (simpler prompt)
        const failCount = getFailCount(pr.number);
        if (failCount > 0 && pr.issues.length === 1 && pr.issues[0] === 'conflict') {
          log(`${prefix} Retry #${failCount + 1} for conflict-only PR — using rebase-only strategy`);
          await claimPr(pr.number, config.repo);
          const rebasePrompt = `Rebase the current branch onto origin/main. Resolve any merge conflicts. Then force-push with: git push --force-with-lease. Do NOT fix CI issues, do NOT address code review comments — ONLY resolve the merge conflicts and push.`;
          const rebaseResult2 = await spawnClaude(rebasePrompt, {
            ...config,
            maxTurns: 30,
            timeoutMinutes: 15,
          }, { cwd: worktreePath });
          const elapsedS = Math.floor((Date.now() - startTime) / 1000);
          const outcome: FixOutcome = rebaseResult2.exitCode === 0 && !rebaseResult2.hitMaxTurns ? 'fixed' : 'error';
          if (outcome === 'fixed') {
            resetFailCount(pr.number);
            log(`${prefix} ${cl.green}Rebase-only fix succeeded${cl.reset} (${elapsedS}s)`);
          } else {
            recordFailure(pr.number);
            log(`${prefix} ${cl.red}Rebase-only fix failed${cl.reset} (${elapsedS}s)`);
          }
          appendJsonl(JSONL_FILE, {
            type: 'pr_result', pr_num: pr.number, issues: pr.issues,
            outcome, elapsed_s: elapsedS, reason: 'rebase-only strategy', parallel: true,
          });
          markProcessed(pr.number);
          return { prNumber: pr.number, outcome, reason: 'rebase-only strategy', elapsedS };
        }
        log(`${prefix} Automated rebase failed (${rebaseResult.status}) — falling through to Claude`);
      }
    }

    // Claim PR on GitHub
    await claimPr(pr.number, config.repo);

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
    }, { cwd: worktreePath });

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
    // Always release PR claim and remove worktree
    await releasePr(pr.number, config.repo);
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
  const detected = detectAllPrIssuesFromNodes(allPrs, config);

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

  // Enqueue eligible PRs (skip if deploy is failing)
  const enqueuedPrs: number[] = [];
  if (!deployHealth.healthy) {
    log(`  ${cl.yellow}Skipping merge enqueue — deploy pipeline is failing${cl.reset}`);
  } else {
    for (const candidate of eligibleForMerge) {
      const outcome = await enqueuePr(candidate, config);
      if (outcome === 'enqueued' || outcome === 'dry-run') {
        enqueuedPrs.push(candidate.number);
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

  if (!process.env.GITHUB_TOKEN) {
    log(`${cl.red}ERROR: GITHUB_TOKEN not set${cl.reset}`);
    process.exit(1);
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
      60,
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
