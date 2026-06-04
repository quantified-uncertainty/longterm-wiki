/**
 * PR Patrol — Continuous PR maintenance daemon
 *
 * Scans open PRs for issues (conflicts, CI failures, missing test plans,
 * missing issue refs, staleness), scores them by priority, and spawns
 * `claude` CLI to fix the highest-priority one per cycle.
 *
 * This file is the main entry point and daemon loop.
 * Implementation is split across focused modules:
 *   types.ts     — shared types and constants
 *   state.ts     — cooldown tracking, failure counting, JSONL logging
 *   detection.ts — GraphQL queries, issue detection, overlap detection
 *   scoring.ts   — priority scoring and budget computation
 *   merge.ts     — merge eligibility, undraft, merge execution
 *   prompts.ts   — prompt builders for Claude fix sessions
 *   execution.ts — Claude spawning, PR fixing, claim management
 *   reflection.ts — periodic log analysis
 *   comments.ts  — structured PR status comments
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import {
  githubApi,
  getGitHubToken,
  isMissingTokenError,
  MISSING_TOKEN_SUMMARY,
  REPO,
} from '../lib/github.ts';
import { gitSafe } from '../lib/git.ts';
import { parseIntOpt } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import {
  buildStatusCommentBody,
  upsertStatusComment,
} from './comments.ts';

// ── Re-exports for backward compatibility ───────────────────────────────────
// Consumers of pr-patrol/index.ts (like crux/commands/pr-patrol.ts) expect the
// daemon-wrapped versions that accept PatrolConfig. For type-only re-exports
// and pure functions, we re-export from the lib directly.

export type {
  PrIssueType,
  BotComment,
  DetectedPr,
  ScoredPr,
  MergeBlockReason,
  MergeCandidate,
  GqlPrNode,
  GqlReviewThread,
  MainBranchStatus,
  PrOverlap,
  AutoRebaseResult,
} from '../lib/pr-analysis/index.ts';

export type { PatrolConfig } from './types.ts';

// Pure functions from lib (no signature change)
export {
  detectIssues,
  extractBotComments,
  detectOverlaps,
  checkMergeEligibility,
  findMergeCandidates,
  ISSUE_SCORES,
  computeScore,
  rankPrs,
  tryAutomatedRebase,
} from '../lib/pr-analysis/index.ts';

// Daemon-wrapped versions (different signatures than lib versions)
export { fetchOpenPrs, fetchSinglePr } from './detection.ts';
export { checkMainBranch } from './execution.ts';

// Daemon-specific exports
export { computeBudget } from './scoring.ts';
export { looksLikeNoOp, looksLikeMainRootCause, findExistingMainFixPr, type FixPrResult } from './execution.ts';
export { JSONL_FILE, REFLECTION_FILE, PARALLEL_STATE_FILE, getParallelState } from './state.ts';

// ── Internal imports (daemon-wrapped versions for the daemon loop) ──────────

import type { PatrolConfig } from './types.ts';
import {
  appendJsonl,
  clearCodeRabbitRetryTime,
  clearProcessed,
  clearTrackedMainFixPr,
  CODERABBIT_DEFAULT_RETRY_DELAY_MS,
  ensureDirs,
  getCodeRabbitRetryTime,
  getTrackedMainFixPr,
  isAbandoned,
  isAutoMergeDisabled,
  isCircuitOpen,
  isRecentlyProcessed,
  JSONL_FILE as JSONL_FILE_INTERNAL,
  log,
  logHeader,
  setCodeRabbitRetryTime,
} from './state.ts';
import {
  applyStuckCycleDetection,
  detectAllPrIssues,
  detectPrOverlaps,
  fetchOpenPrs as daemonFetchOpenPrs,
} from './detection.ts';
import { detectCodeRabbitRateLimited } from '../lib/pr-analysis/detection.ts';
import { rankPrsWithDeps as daemonRankPrs } from './scoring.ts';
import {
  findMergeCandidates as daemonFindMergeCandidates,
  enqueuePr,
  undraftPr,
  reconcileMergeQueueLabels,
} from './merge.ts';
import {
  checkMainBranch as daemonCheckMainBranch,
  fixMainBranch,
  fixPr,
  releaseCurrentClaim,
} from './execution.ts';
import { checkDeployHealth as libCheckDeployHealth } from '../lib/pr-analysis/deploy-status.ts';
import type { DeployHealthStatus } from '../lib/pr-analysis/deploy-status.ts';
import { runHealthGate } from './health-gate.ts';
import { runReflection } from './reflection.ts';
import {
  createIdleState,
  nextCycle as nextIdleCycle,
  DEFAULT_TRIP_THRESHOLD,
  DEFAULT_MAX_SLEEP_SECONDS,
} from './idle-tracker.ts';

const cl = getColors();

// ── PID file management ─────────────────────────────────────────────────────

import { join as joinPath } from 'path';

export const PID_FILE = joinPath(process.env.HOME ?? '/tmp', '.cache', 'pr-patrol', 'daemon.pid');

function removePidFile(file: string = PID_FILE): void {
  try {
    unlinkSync(file);
  } catch (e) {
    // ENOENT is expected when the file is already gone (e.g. another shutdown
    // path beat us to it). Anything else (EACCES, EPERM) is a real surprise
    // worth surfacing.
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.error(`${cl.yellow}Warning: could not remove PID file ${file}: ${e instanceof Error ? e.message : String(e)}${cl.reset}`);
    }
  }
}

/** Read the PID of a running patrol daemon, or null if none. */
export function getDaemonPid(file: string = PID_FILE): number | null {
  try {
    const pid = parseInt(readFileSync(file, 'utf-8').trim(), 10);
    if (isNaN(pid)) return null;
    // Check if process is alive. Note: this only verifies _some_ process owns
    // the PID — after a crash + enough new PID allocations, the OS will reuse
    // the dead daemon's PID for an unrelated process. Acceptable failure mode:
    // the new daemon refuses to start until the user clears the PID file.
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

/**
 * Atomically acquire the PID file. Uses `flag: 'wx'` (exclusive create) so
 * two simultaneous patrol launches can't both succeed: only one wins the
 * create, the other sees EEXIST and either bails (live owner) or reclaims
 * (stale owner). Bounded retry handles the rare race where two processes
 * both detect a stale file at the same instant.
 *
 * Returns `{ ok: false, existingPid }` when another live process owns the
 * file. Returns `{ ok: true }` only after this process's PID has been
 * persisted to disk — never lies about acquisition.
 */
export function acquirePidFile(
  file: string = PID_FILE,
): { ok: true } | { ok: false; existingPid: number } {
  // Bounded retry — stale-PID reclamation can race with a peer doing the
  // same. After two attempts we surface failure rather than spin.
  for (let i = 0; i < 2; i++) {
    try {
      writeFileSync(file, String(process.pid), { flag: 'wx' });
      return { ok: true };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        // EACCES, ENOSPC, EROFS, etc. — we couldn't write, so we can't claim.
        // Surface as failure so the daemon refuses to start (better than
        // silently running without singleton enforcement).
        console.error(`${cl.red}ERROR: could not write PID file ${file}: ${e instanceof Error ? e.message : String(e)}${cl.reset}`);
        return { ok: false, existingPid: -1 };
      }
      const existing = getDaemonPid(file);
      if (existing === process.pid) return { ok: true };
      if (existing !== null) return { ok: false, existingPid: existing };
      // File exists but owner is dead — try to clear it and loop.
      try {
        unlinkSync(file);
      } catch {
        // Another process raced us to clear it. Next iteration will
        // either succeed or detect the new owner.
      }
    }
  }
  // Lost both rounds (extreme contention). Re-read once to get the final
  // owner; if the file vanished, treat as our last failed write rather than
  // falsely reporting success.
  const finalOwner = getDaemonPid(file);
  if (finalOwner === process.pid) return { ok: true };
  return { ok: false, existingPid: finalOwner ?? -1 };
}

/** Stop a running patrol daemon. Returns true if one was stopped. */
export function stopDaemon(): boolean {
  const pid = getDaemonPid();
  if (!pid) return false;
  try {
    process.kill(pid, 'SIGTERM');
    removePidFile();
    return true;
  } catch {
    removePidFile();
    return false;
  }
}

// ── Config builder ───────────────────────────────────────────────────────────

export function buildConfig(
  _args: string[],
  options: Record<string, unknown>,
): PatrolConfig {
  // Note: crux.mjs converts kebab-case flags to camelCase (--dry-run → dryRun)
  return {
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
}

// ── Preflight checks ─────────────────────────────────────────────────────────

function preflightChecks(config: PatrolConfig): string[] {
  const errors: string[] = [];
  const inRepo = gitSafe('rev-parse', '--is-inside-work-tree');
  if (!inRepo.ok) errors.push('Must run inside a git worktree');

  // Only enforce clean tree when actually fixing (not for dry-run or status)
  if (!config.dryRun) {
    // Use git status --porcelain to catch both modified and untracked files
    // that could interfere with branch switching during fixes.
    // Filter out known noise directories that are always untracked.
    const IGNORED_PREFIXES = ['.claude/worktrees/', '.claude/wip-'];
    const status = gitSafe('status', '--porcelain');
    if (status.ok && status.output.trim()) {
      const significant = status.output
        .trim()
        .split('\n')
        .filter((line) => {
          const filePath = line.slice(3); // strip status prefix "?? " / " M " etc.
          return !IGNORED_PREFIXES.some((p) => filePath.startsWith(p));
        });
      if (significant.length > 0) {
        // If we're on a non-main branch, these are likely partial changes left
        // by a previous patrol sub-agent that hit its max-turns limit. Auto-commit
        // them so this cycle can continue without manual intervention.
        const currentBranch = gitSafe('branch', '--show-current');
        const branch = currentBranch.ok ? currentBranch.output.trim() : '';

        if (branch && branch !== 'main' && branch !== 'master') {
          log(`⚠ Working tree has ${significant.length} uncommitted change(s) from a previous patrol run — auto-committing`);
          log(`  Dirty files: ${significant.slice(0, 5).map((l) => l.trim()).join(', ')}${significant.length > 5 ? ` (+${significant.length - 5} more)` : ''}`);

          // Stage only already-tracked files (no untracked noise)
          const addResult = gitSafe('add', '-u');
          if (addResult.ok) {
            const commitResult = gitSafe('commit', '-m', 'fix: partial patrol fix (auto-committed on patrol restart)');
            if (commitResult.ok) {
              log(`  ✓ Auto-committed leftover changes on ${branch}`);
            } else if (!commitResult.output.includes('nothing to commit')) {
              log(`  Warning: could not auto-commit leftover changes: ${commitResult.output.trim()}`);
            }
          }
        } else {
          errors.push(
            'Working tree must be clean before starting PR Patrol. Commit or stash your changes first.\n' +
              `  Dirty files: ${significant.slice(0, 5).map((l) => l.trim()).join(', ')}${significant.length > 5 ? ` (+${significant.length - 5} more)` : ''}`,
          );
        }
      }
    }
  }

  try {
    getGitHubToken();
  } catch (e) {
    if (isMissingTokenError(e)) {
      errors.push(MISSING_TOKEN_SUMMARY);
    } else {
      throw e;
    }
  }

  return errors;
}

// ── Check cycle ──────────────────────────────────────────────────────────────

/**
 * Outcome of a single check cycle. `didWork = true` means the cycle should
 * count against the idle-cycle circuit breaker (QUA-1071), i.e. the breaker
 * resets and stays at base interval. Two flavors of "work":
 *
 *   1. Queue-shrinking work: a PR was processed, a merge was enqueued, or a
 *      draft was undrafted. Computed at the bottom of `runCheckCycle`.
 *   2. Active-but-non-queue-shrinking signals: health-gate tripped, main-branch
 *      fix attempted. Returned via the early-return paths so the daemon keeps
 *      polling at base interval to detect fleet recovery — backing off when
 *      the fleet is unhealthy would extend MTTR.
 *
 * The breaker drives exponential backoff after K=20 consecutive
 * `didWork = false` cycles.
 */
export interface CheckCycleResult {
  didWork: boolean;
}

async function runCheckCycle(
  cycleCount: number,
  config: PatrolConfig,
): Promise<CheckCycleResult> {
  logHeader(`Check cycle #${cycleCount}`);

  // 0. Health gate (QUA-300 Phase 3) — check fleet-level signals FIRST.
  // If any of deploy-stuck / main-ci-red / ratchet-drift fires, skip PR work
  // this cycle and escalate. This is the precondition that keeps patrol from
  // churning out symptom-fix PRs while a deploy is stuck or a ratchet is
  // drifting. See docs/agent-rules/patrol-health-gate.md for the rationale.
  const gate = await runHealthGate();
  if (!gate.proceed) {
    appendJsonl(JSONL_FILE_INTERNAL, {
      type: 'cycle_summary',
      cycle_number: cycleCount,
      prs_scanned: 0,
      queue_size: 0,
      pr_processed: null,
      health_gate_tripped: true,
      health_gate_reason: gate.reason,
    });
    // Health-gate halts the queue but is itself a real signal — count as work
    // so the idle breaker doesn't back off when the fleet is actively unhealthy.
    return { didWork: true };
  }

  // 0a. Check if a tracked main-branch fix PR has been merged
  let skipMainFix = false;
  const trackedFix = getTrackedMainFixPr();
  if (trackedFix) {
    try {
      const pr = await githubApi<{ merged: boolean; state: string }>(
        `/repos/${config.repo}/pulls/${trackedFix.prNumber}`,
      );
      if (pr.merged) {
        log(`${cl.green}✓ Main branch fix PR #${trackedFix.prNumber} merged${cl.reset} — clearing main cooldown`);
        clearTrackedMainFixPr();
        clearProcessed('main-branch');
      } else if (pr.state === 'closed') {
        log(`${cl.yellow}⚠ Main branch fix PR #${trackedFix.prNumber} closed without merging${cl.reset}`);
        clearTrackedMainFixPr();
      } else {
        log(`  ${cl.dim}Tracked fix PR #${trackedFix.prNumber} still open — skipping main branch fix${cl.reset}`);
        skipMainFix = true;
      }
    } catch (e) {
      log(`  ${cl.yellow}Warning: could not check tracked fix PR: ${e instanceof Error ? e.message : String(e)}${cl.reset}`);
    }
  }

  // 0b. Check main branch CI first — highest priority (skip if fix PR already open)
  const mainStatus = await daemonCheckMainBranch(config);
  if (mainStatus.isRed && skipMainFix) {
    log(`${cl.yellow}⚠ Main branch CI is red but fix PR #${trackedFix!.prNumber} already open — skipping${cl.reset}`);
  } else if (mainStatus.isRed) {
    log(`${cl.red}Main branch CI is red${cl.reset} — prioritizing fix over PR queue`);
    await fixMainBranch(mainStatus, config);
    appendJsonl(JSONL_FILE_INTERNAL, {
      type: 'cycle_summary',
      cycle_number: cycleCount,
      prs_scanned: 0,
      queue_size: 0,
      pr_processed: null,
      main_branch_fix: true,
    });
    return { didWork: true }; // Main takes the whole cycle; PRs wait
  }

  // 0b. Check deploy health
  const deployHealth: DeployHealthStatus = await libCheckDeployHealth(config.repo).catch((e) => {
    log(`  ${cl.yellow}Warning: deploy health check failed: ${e instanceof Error ? e.message : String(e)}${cl.reset}`);
    return { healthy: true, lastDeploy: null, failingSince: null } as DeployHealthStatus;
  });

  if (!deployHealth.healthy) {
    log(`  ${cl.red}Deploy pipeline is failing${cl.reset} since ${deployHealth.failingSince ?? 'unknown'}`);
  } else if (deployHealth.lastDeploy) {
    log(`  Deploy pipeline is healthy`);
  }

  // 1. Fetch all open PRs (shared between fix and merge phases)
  const allPrs = await daemonFetchOpenPrs(config);

  // 1a. Reconcile stale stage:merging labels against actual merge queue state.
  // GitHub ejects PRs from the queue (CI failure, manual dequeue) without
  // notifying us, leaving stale labels that block re-enqueuing and auto-rebase.
  await reconcileMergeQueueLabels(allPrs, config);

  // ── Fix phase ──────────────────────────────────────────────────────

  const detected = await detectAllPrIssues(allPrs, config);

  // Annotate detected PRs with stuck-cycle metadata and persist per-PR
  // snapshots. Runs after detection so stuckCycles / stuck issue are
  // available to scoring and dispatch. Best-effort — errors are logged
  // inside applyStuckCycleDetection and do not abort the cycle.
  await applyStuckCycleDetection(detected, allPrs);

  let fixedPr: number | null = null;

  // 1b. Check for PR file overlaps (informational — posts warnings)
  if (detected.length >= 2) {
    await detectPrOverlaps(config, detected);
  }

  if (detected.length === 0) {
    log(`${cl.green}All PRs clean${cl.reset} — nothing to fix`);
  } else {
    // Filter cooldowns and abandoned
    const eligible = detected.filter((pr) => {
      if (isAbandoned(pr.number)) {
        log(`  ${cl.dim}Skipping PR #${pr.number} (abandoned — escalated to coordinator)${cl.reset}`);
        return false;
      }
      if (isRecentlyProcessed(pr.number, config.cooldownSeconds)) {
        log(`  ${cl.dim}Skipping PR #${pr.number} (recently processed)${cl.reset}`);
        return false;
      }
      return true;
    });

    const ranked = daemonRankPrs(eligible);
    if (ranked.length > 0) {
      // Circuit breaker: skip dispatching if too many instant failures
      if (isCircuitOpen()) {
        log(`${cl.red}Circuit breaker OPEN — pausing dispatch (3+ consecutive instant failures). Will auto-reset in ≤15 min.${cl.reset}`);
      } else {
        log('');
        log(`${cl.bold}Fix queue${cl.reset} (${ranked.length} items):`);
        for (const pr of ranked) {
          // Render dependency chain `#A → #B` when blockedOnPrs is populated,
          // so operators see which open PRs this one is waiting on. Cap at 3
          // to keep lines readable; common case is 1–2.
          const deps = (pr.blockedOnPrs ?? []).slice(0, 3);
          const depChain = deps.length > 0
            ? ` ${cl.yellow}→ blocked on ${deps.map((d) => `#${d.pr}`).join(', ')}${cl.reset}`
            : '';
          const moreDeps = (pr.blockedOnPrs?.length ?? 0) > 3
            ? ` ${cl.dim}(+${(pr.blockedOnPrs?.length ?? 0) - 3} more)${cl.reset}`
            : '';
          log(
            `  [score=${pr.score}] PR ${cl.cyan}#${pr.number}${cl.reset}: ${pr.issues.join(',')}${depChain}${moreDeps} ${cl.dim}—${cl.reset} ${pr.title}`,
          );
        }
        log('');

        const top = ranked[0];
        const fixResult = await fixPr(top, config);
        fixedPr = top.number;

        // If the PR's CI failure is caused by main being broken, immediately re-check main
        if (fixResult.mainIsRootCause) {
          log(`${cl.yellow}⚠ PR #${top.number} blocked by broken main — clearing main cooldown for immediate re-check${cl.reset}`);
          clearProcessed('main-branch');
        }
      }
    } else {
      log(`${cl.dim}All issues recently processed — nothing to fix${cl.reset}`);
    }
  }

  // ── CodeRabbit review retry phase ────────────────────────────────────
  // When CodeRabbit rate-limits a PR review, schedule a retry and post
  // `@coderabbitai review` after the cooldown expires.

  for (const pr of allPrs) {
    const isRateLimited = detectCodeRabbitRateLimited(pr);

    if (!isRateLimited) {
      // Not rate-limited — clear any pending retry (review succeeded or not applicable)
      clearCodeRabbitRetryTime(pr.number);
      continue;
    }

    const existingRetry = getCodeRabbitRetryTime(pr.number);

    if (!existingRetry) {
      // First time seeing rate limit — schedule retry
      const retryAt = new Date(Date.now() + CODERABBIT_DEFAULT_RETRY_DELAY_MS).toISOString();
      setCodeRabbitRetryTime(pr.number, retryAt);
      log(`  PR #${pr.number}: CodeRabbit rate-limited — scheduled retry at ${retryAt}`);
      continue;
    }

    // Check if it's time to retry
    const retryTime = new Date(existingRetry).getTime();
    if (Date.now() < retryTime) {
      const minutesLeft = Math.ceil((retryTime - Date.now()) / 60000);
      if (config.verbose) {
        log(`  ${cl.dim}PR #${pr.number}: CodeRabbit retry in ~${minutesLeft}min${cl.reset}`);
      }
      continue;
    }

    // Time to retry — post the review request comment
    log(`  PR #${pr.number}: CodeRabbit retry time reached — requesting review`);
    if (config.dryRun) {
      log(`  ${cl.dim}[DRY RUN] Would post @coderabbitai review on PR #${pr.number}${cl.reset}`);
    } else {
      try {
        await githubApi(`/repos/${config.repo}/issues/${pr.number}/comments`, {
          method: 'POST',
          body: { body: '@coderabbitai review' },
        });
        log(`  ${cl.green}Posted @coderabbitai review on PR #${pr.number}${cl.reset}`);
        appendJsonl(JSONL_FILE_INTERNAL, {
          type: 'coderabbit_retry',
          pr_num: pr.number,
          outcome: 'posted',
        });
      } catch (e) {
        log(`  ${cl.yellow}Warning: could not post CodeRabbit retry on PR #${pr.number}: ${e instanceof Error ? e.message : String(e)}${cl.reset}`);
        appendJsonl(JSONL_FILE_INTERNAL, {
          type: 'coderabbit_retry',
          pr_num: pr.number,
          outcome: 'error',
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    // Clear the retry state — only retry once per rate-limit event
    clearCodeRabbitRetryTime(pr.number);
  }

  // ── Undraft phase ──────────────────────────────────────────────────
  // Auto-undraft draft PRs that are otherwise eligible for merge.
  // A PR is auto-undrafted when its only block reason is 'is-draft'.

  const draftCandidates = daemonFindMergeCandidates(allPrs).filter(
    (c) => !c.eligible && c.blockReasons.length === 1 && c.blockReasons[0] === 'is-draft',
  );

  const undraftedNumbers = new Set<number>();
  for (const candidate of draftCandidates) {
    if (config.dryRun) {
      log(`  [DRY RUN] Would undraft PR #${candidate.number} (all other checks pass)`);
      undraftedNumbers.add(candidate.number);
    } else {
      const success = await undraftPr(candidate.number, config);
      if (success) undraftedNumbers.add(candidate.number);
    }
  }

  // ── Merge phase ────────────────────────────────────────────────────
  // Re-evaluate after undrafting (only successfully undrafted PRs become eligible)
  const mergeCandidates = daemonFindMergeCandidates(allPrs).map((c) => {
    if (undraftedNumbers.has(c.number)) {
      const updated = { ...c, blockReasons: c.blockReasons.filter((r) => r !== 'is-draft') };
      return { ...updated, eligible: updated.blockReasons.length === 0 };
    }
    return c;
  });
  const eligibleForMerge = mergeCandidates.filter((c) => c.eligible);
  const blockedForMerge = mergeCandidates.filter((c) => !c.eligible);
  const enqueuedPrs: number[] = [];

  if (mergeCandidates.length > 0) {
    log('');
    log(`${cl.bold}Merge candidates${cl.reset} (${mergeCandidates.length} with stage:approved):`);
    for (const mc of eligibleForMerge) {
      log(`  ${cl.green}✓${cl.reset} PR ${cl.cyan}#${mc.number}${cl.reset}: eligible ${cl.dim}—${cl.reset} ${mc.title}`);
    }
    for (const mc of blockedForMerge) {
      log(`  ${cl.red}✗${cl.reset} PR ${cl.cyan}#${mc.number}${cl.reset}: blocked (${mc.blockReasons.join(', ')}) ${cl.dim}—${cl.reset} ${mc.title}`);
    }

    // Upsert status comments on merge candidates so humans can see WHY
    // a PR can or cannot merge. Build a lookup from PR number to GqlPrNode.
    const prNodeByNumber = new Map(allPrs.map((p) => [p.number, p]));
    for (const mc of mergeCandidates) {
      const prNode = prNodeByNumber.get(mc.number);
      if (!prNode) continue;
      const statusBody = buildStatusCommentBody(prNode, mc.blockReasons);
      await upsertStatusComment(mc.number, config.repo, statusBody)
        .catch((e: unknown) => log(`  ${cl.yellow}Warning: could not upsert status comment on PR #${mc.number}: ${e instanceof Error ? e.message : String(e)}${cl.reset}`));
    }
  }

  // Enqueue ALL eligible PRs — the merge queue handles serialization
  // Skip if deploy pipeline is failing — don't merge into a broken pipeline
  // Skip if auto-merge has been disabled at the repo level (QUA-858)
  const autoMergeStatus = isAutoMergeDisabled();
  if (!deployHealth.healthy) {
    log(`  ${cl.yellow}Skipping merge enqueue — deploy pipeline is failing since ${deployHealth.failingSince ?? 'unknown'}${cl.reset}`);
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

  // ── Cycle summary ──────────────────────────────────────────────────

  // Queue-shrinking work this cycle. The early-return paths above (health-gate
  // tripped, main-branch fix) handle their own `didWork` per CheckCycleResult's
  // contract — see the JSDoc on the interface for the full taxonomy.
  const didWork =
    fixedPr !== null ||
    enqueuedPrs.length > 0 ||
    undraftedNumbers.size > 0;

  appendJsonl(JSONL_FILE_INTERNAL, {
    type: 'cycle_summary',
    cycle_number: cycleCount,
    prs_scanned: allPrs.length,
    queue_size: detected.filter(
      (pr) =>
        !isAbandoned(pr.number) &&
        !isRecentlyProcessed(pr.number, config.cooldownSeconds),
    ).length,
    pr_processed: fixedPr,
    prs_enqueued: enqueuedPrs.length > 0 ? enqueuedPrs : undefined,
    merge_candidates: mergeCandidates.length,
    merge_eligible: eligibleForMerge.length,
    deploy_healthy: deployHealth.healthy,
    deploy_failing_since: deployHealth.failingSince ?? undefined,
    did_work: didWork,
  });
  return { didWork };
}

// ── Daemon loop ─────────────────────────────────────────────────────────────

export async function runDaemon(config: PatrolConfig): Promise<void> {
  const errors = preflightChecks(config);
  if (errors.length > 0) {
    for (const e of errors) console.error(`${cl.red}ERROR: ${e}${cl.reset}`);
    process.exit(1);
  }

  ensureDirs();

  // Tracks whether THIS process acquired the PID file. `once` mode skips
  // acquisition (line below), so it must also skip release in shutdown,
  // otherwise a one-shot run that catches SIGINT/SIGTERM would delete the
  // continuous daemon's PID file (CodeRabbit, PR #4701).
  let ownsPidFile = false;

  // Refuse to start a continuous daemon if another is already running —
  // otherwise two `pr-patrol run` invocations spawn parallel loops with
  // independent cycle counters and double-process the queue.
  //
  // `once` mode is intentionally NOT checked: it does a single pass and
  // exits, so debugging a daemon with `once` runs is the documented workflow.
  if (!config.once) {
    const acquired = acquirePidFile();
    if (!acquired.ok) {
      if (acquired.existingPid === -1) {
        // Write failure (EACCES, ENOSPC, etc.) — the message was already
        // logged inside acquirePidFile. Just bail.
      } else {
        console.error(
          `${cl.red}ERROR: Another PR patrol daemon is already running (pid ${acquired.existingPid}).${cl.reset}`,
        );
        console.error(`  PID file: ${PID_FILE}`);
        console.error(
          `  Run \`crux gh pr-patrol stop\` to stop it, \`crux gh pr-patrol status\` to check,`,
        );
        console.error(
          `  or remove the PID file manually if the listed PID is not actually a patrol process.`,
        );
      }
      process.exit(1);
    }
    ownsPidFile = true;
  }

  logHeader('PR Patrol starting');
  log(
    `Config: interval=${config.intervalSeconds}s, max-turns=${config.maxTurns}, cooldown=${config.cooldownSeconds}s, model=${config.model}`,
  );
  log(`Repo: ${config.repo}`);
  log(`JSONL: ${JSONL_FILE_INTERNAL}`);
  log(
    `Mode: ${config.once ? 'single pass' : config.dryRun ? 'dry run' : 'continuous'}`,
  );

  // Signal handlers for graceful shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('Shutting down...');
    if (ownsPidFile) removePidFile();
    await releaseCurrentClaim(config.repo);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  if (config.once) {
    await runCheckCycle(1, config);
    return;
  }

  let cycleCount = 0;
  let idleState = createIdleState();
  const idleConfig = {
    tripThreshold: DEFAULT_TRIP_THRESHOLD,
    baseSleepSeconds: config.intervalSeconds,
    maxSleepSeconds: DEFAULT_MAX_SLEEP_SECONDS,
  };

  while (!shuttingDown) {
    cycleCount++;
    // A check-cycle exception is treated as no-op so a persistent error
    // (e.g. GitHub auth dropped) progresses the breaker toward backoff
    // rather than spinning at base interval forever.
    let didWork = false;
    try {
      const cycleResult = await runCheckCycle(cycleCount, config);
      didWork = cycleResult.didWork;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`${cl.red}Check cycle failed: ${msg}${cl.reset}`);
      // Persist the failure to JSONL so the breaker's eventual engagement is
      // attributable to a stream of errors rather than a "no work needed"
      // streak. The normal cycle_summary won't have run when this throws.
      appendJsonl(JSONL_FILE_INTERNAL, {
        type: 'cycle_error',
        cycle_number: cycleCount,
        error: msg,
      });
    }

    // Periodic reflection
    if (cycleCount % config.reflectionInterval === 0) {
      try {
        await runReflection(cycleCount, config);
      } catch (e) {
        log(`${cl.yellow}Reflection failed: ${e instanceof Error ? e.message : String(e)} — continuing${cl.reset}`);
      }
    }

    const step = nextIdleCycle(idleState, didWork, idleConfig);
    idleState = step.state;
    if (step.justTripped) {
      // The engagement cycle itself sleeps at base interval (overshoot=0);
      // backoff doubles starting on the next idle cycle. Be honest about
      // that in the log so operators reading it don't expect immediate growth.
      log(
        `${cl.yellow}⚠ Idle-cycle breaker engaged after ${idleState.noOpStreak} no-op cycles — sleeping ${step.sleepSeconds}s now; backoff begins next cycle (max ${idleConfig.maxSleepSeconds}s).${cl.reset}`,
      );
      appendJsonl(JSONL_FILE_INTERNAL, {
        type: 'idle_breaker_engaged',
        cycle_number: cycleCount,
        no_op_streak: idleState.noOpStreak,
        next_sleep_seconds: step.sleepSeconds,
      });
    } else if (idleState.noOpStreak > idleConfig.tripThreshold) {
      log(
        `${cl.dim}Idle ${idleState.noOpStreak} cycles — sleeping ${step.sleepSeconds}s.${cl.reset}`,
      );
    } else {
      log(`${cl.dim}Sleeping ${step.sleepSeconds}s until next check...${cl.reset}`);
    }
    await new Promise((r) => setTimeout(r, step.sleepSeconds * 1000));
  }
}

// ── Status command ──────────────────────────────────────────────────────────

export function readRecentLogs(count: number): string {
  if (!existsSync(JSONL_FILE_INTERNAL)) return 'No PR Patrol logs found.\n';

  const lines = readFileSync(JSONL_FILE_INTERNAL, 'utf-8').trim().split('\n');
  const recent = lines.slice(-count);
  const output: string[] = ['Recent PR Patrol activity:\n'];

  for (const line of recent) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'pr_result') {
        output.push(
          `  PR #${entry.pr_num}: ${entry.outcome} (${entry.elapsed_s}s) — ${entry.issues?.join(', ') ?? ''}`,
        );
      } else if (entry.type === 'merge_result') {
        output.push(
          `  PR #${entry.pr_num}: merge-${entry.outcome}${entry.reason ? ` (${entry.reason})` : ''}`,
        );
      } else if (entry.type === 'main_branch_result') {
        output.push(
          `  Main branch: ${entry.outcome} (${entry.elapsed_s}s) — run #${entry.run_id}`,
        );
      } else if (entry.type === 'coderabbit_retry') {
        output.push(
          `  PR #${entry.pr_num}: coderabbit-retry-${entry.outcome}${entry.error ? ` (${entry.error})` : ''}`,
        );
      } else if (entry.type === 'overlap_warning') {
        output.push(
          `  Overlap: PR #${entry.pr_a} ↔ PR #${entry.pr_b} (${entry.shared_files} shared files)`,
        );
      } else if (entry.type === 'cycle_summary') {
        const gateInfo = entry.health_gate_tripped
          ? `, health_gate=tripped (${entry.health_gate_reason ?? 'unknown'})`
          : '';
        const mainFix = entry.main_branch_fix ? ', main_branch_fix=true' : '';
        const enqueueInfo = entry.prs_enqueued?.length
          ? `, enqueued=[${entry.prs_enqueued.map((n: number) => `#${n}`).join(', ')}]`
          : '';
        const mergeInfo = entry.pr_merged
          ? `, merged=#${entry.pr_merged}`
          : !enqueueInfo && entry.merge_candidates > 0
            ? `, merge-blocked=${entry.merge_candidates}`
            : '';
        output.push(
          `  Cycle #${entry.cycle_number}: scanned=${entry.prs_scanned}, queue=${entry.queue_size}, processed=${entry.pr_processed ?? 'none'}${gateInfo}${mainFix}${enqueueInfo}${mergeInfo}`,
        );
      }
    } catch {
      // Skip malformed lines
    }
  }

  return output.join('\n') + '\n';
}
