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

import { existsSync, readFileSync } from 'fs';
import { githubApi, REPO } from '../lib/github.ts';
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
export { looksLikeNoOp, looksLikeMainRootCause } from './execution.ts';
export { JSONL_FILE, REFLECTION_FILE } from './state.ts';

// ── Internal imports (daemon-wrapped versions for the daemon loop) ──────────

import type { PatrolConfig } from './types.ts';
import {
  appendJsonl,
  clearProcessed,
  clearTrackedMainFixPr,
  ensureDirs,
  getTrackedMainFixPr,
  isAbandoned,
  isRecentlyProcessed,
  JSONL_FILE as JSONL_FILE_INTERNAL,
  log,
  logHeader,
} from './state.ts';
import {
  detectAllPrIssuesFromNodes,
  detectPrOverlaps,
  fetchOpenPrs as daemonFetchOpenPrs,
} from './detection.ts';
import { rankPrs as daemonRankPrs } from './scoring.ts';
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
import { runReflection } from './reflection.ts';

const cl = getColors();

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
      40,
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
      30,
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

  if (!process.env.GITHUB_TOKEN) {
    errors.push('GITHUB_TOKEN not set');
  }

  return errors;
}

// ── Check cycle ──────────────────────────────────────────────────────────────

async function runCheckCycle(
  cycleCount: number,
  config: PatrolConfig,
): Promise<void> {
  logHeader(`Check cycle #${cycleCount}`);

  // 0a. Check if a tracked main-branch fix PR has been merged
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
        log(`  ${cl.dim}Tracked fix PR #${trackedFix.prNumber} still open — waiting for merge${cl.reset}`);
      }
    } catch (e) {
      log(`  ${cl.yellow}Warning: could not check tracked fix PR: ${e instanceof Error ? e.message : String(e)}${cl.reset}`);
    }
  }

  // 0b. Check main branch CI first — highest priority
  const mainStatus = await daemonCheckMainBranch(config);
  if (mainStatus.isRed) {
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
    return; // Main takes the whole cycle; PRs wait
  }

  // 1. Fetch all open PRs (shared between fix and merge phases)
  const allPrs = await daemonFetchOpenPrs(config);

  // 1a. Reconcile stale stage:merging labels against actual merge queue state.
  // GitHub ejects PRs from the queue (CI failure, manual dequeue) without
  // notifying us, leaving stale labels that block re-enqueuing and auto-rebase.
  await reconcileMergeQueueLabels(allPrs, config);

  // ── Fix phase ──────────────────────────────────────────────────────

  const detected = detectAllPrIssuesFromNodes(allPrs, config);
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
        log(`  ${cl.dim}Skipping PR #${pr.number} (abandoned — needs human intervention)${cl.reset}`);
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
      log('');
      log(`${cl.bold}Fix queue${cl.reset} (${ranked.length} items):`);
      for (const pr of ranked) {
        log(
          `  [score=${pr.score}] PR ${cl.cyan}#${pr.number}${cl.reset}: ${pr.issues.join(',')} ${cl.dim}—${cl.reset} ${pr.title}`,
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
    } else {
      log(`${cl.dim}All issues recently processed — nothing to fix${cl.reset}`);
    }
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
  for (const candidate of eligibleForMerge) {
    const outcome = await enqueuePr(candidate, config);
    if (outcome === 'enqueued' || outcome === 'dry-run') {
      enqueuedPrs.push(candidate.number);
    }
  }

  // ── Cycle summary ──────────────────────────────────────────────────

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
  });
}

// ── Daemon loop ─────────────────────────────────────────────────────────────

export async function runDaemon(config: PatrolConfig): Promise<void> {
  const errors = preflightChecks(config);
  if (errors.length > 0) {
    for (const e of errors) console.error(`${cl.red}ERROR: ${e}${cl.reset}`);
    process.exit(1);
  }

  ensureDirs();

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
  while (!shuttingDown) {
    cycleCount++;
    try {
      await runCheckCycle(cycleCount, config);
    } catch (e) {
      log(
        `${cl.red}Check cycle failed: ${e instanceof Error ? e.message : String(e)}${cl.reset}`,
      );
    }

    // Periodic reflection
    if (cycleCount % config.reflectionInterval === 0) {
      try {
        await runReflection(cycleCount, config);
      } catch (e) {
        log(`${cl.yellow}Reflection failed: ${e instanceof Error ? e.message : String(e)} — continuing${cl.reset}`);
      }
    }

    log(`${cl.dim}Sleeping ${config.intervalSeconds}s until next check...${cl.reset}`);
    await new Promise((r) => setTimeout(r, config.intervalSeconds * 1000));
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
      } else if (entry.type === 'overlap_warning') {
        output.push(
          `  Overlap: PR #${entry.pr_a} ↔ PR #${entry.pr_b} (${entry.shared_files} shared files)`,
        );
      } else if (entry.type === 'cycle_summary') {
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
          `  Cycle #${entry.cycle_number}: scanned=${entry.prs_scanned}, queue=${entry.queue_size}, processed=${entry.pr_processed ?? 'none'}${mainFix}${enqueueInfo}${mergeInfo}`,
        );
      }
    } catch {
      // Skip malformed lines
    }
  }

  return output.join('\n') + '\n';
}
