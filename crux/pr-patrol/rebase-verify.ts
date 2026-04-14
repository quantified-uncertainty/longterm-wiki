/**
 * PR Patrol — Rebase outcome verification (QUA-400).
 *
 * `tryAutomatedRebase` in `lib/pr-analysis/rebase.ts` returns success when
 * `git rebase origin/main` exits cleanly and the force-push succeeds. That is
 * not the same thing as GitHub considering the PR mergeable — the divergence
 * has several observed causes:
 *
 *   - GitHub recomputes mergeable asynchronously (several seconds of lag
 *     after a force-push)
 *   - A concurrent commit can land on the branch between rebase and scan,
 *     re-introducing a conflict (head_sha f21ed7 rather than our 9be921)
 *   - The PR targets a non-main base branch, so rebasing onto main does
 *     nothing useful for mergeability
 *
 * When the patrol reported `outcome: 'fixed'` without verifying the GitHub
 * state, the next scan cycle saw the PR still CONFLICTING and started the
 * whole cycle over — 7 wasted cycles on PR #4287 before stuck-cycle detection
 * kicked in.
 *
 * This module polls GitHub's PR state a few times with a short delay to
 * distinguish "still computing" from "actually still conflicting". The
 * rebase is only considered cleared when a fresh read returns a
 * non-CONFLICTING, non-UNKNOWN mergeable state.
 */

import { fetchSinglePr } from '../lib/pr-analysis/detection.ts';
import { tryAutomatedRebase } from '../lib/pr-analysis/rebase.ts';
import type { AutoRebaseResult, GqlPrNode, PrIssueType } from '../lib/pr-analysis/types.ts';

export interface RebaseVerifyResult {
  /** True when GitHub no longer reports the PR as conflicting. */
  cleared: boolean;
  /** Human-readable reason — logged and stored in the JSONL event. */
  reason: string;
  /** Last observed mergeable status (for debugging). */
  mergeable: string | null;
  /** Last observed mergeStateStatus (for debugging). */
  mergeStateStatus: string | null;
  /** Number of poll attempts actually made. */
  attempts: number;
}

export interface VerifyRebaseDeps {
  /** PR fetcher. Injectable for unit tests. Defaults to fetchSinglePr. */
  fetchPr?: (prNumber: number, repo: string) => Promise<GqlPrNode | null>;
  /** Sleep fn. Injectable for unit tests. Defaults to setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Max poll attempts. Default 4. */
  maxAttempts?: number;
  /** Delay between polls in ms. Default 3000. */
  delayMs?: number;
}

/**
 * Default max poll attempts. 4 × 3s = up to 12s of verification latency,
 * which is acceptable cost given that a wasted patrol cycle takes minutes
 * of compute.
 */
export const DEFAULT_MAX_ATTEMPTS = 4;

/**
 * Default delay between polls. 3s chosen because GitHub's async mergeable
 * recomputation typically settles within 2-4s of a push.
 */
export const DEFAULT_DELAY_MS = 3000;

/**
 * Verify that a PR's conflict state actually cleared after an automated
 * rebase. Returns `cleared: true` only when GitHub reports a non-CONFLICTING,
 * non-UNKNOWN mergeable state on at least one fresh read.
 *
 * @param prNumber PR number
 * @param repo     owner/repo string (e.g. "foo/bar")
 * @param deps     injectable dependencies for testing
 */
export async function verifyRebaseCleared(
  prNumber: number,
  repo: string,
  deps: VerifyRebaseDeps = {},
): Promise<RebaseVerifyResult> {
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const delayMs = deps.delayMs ?? DEFAULT_DELAY_MS;
  const fetchPr = deps.fetchPr ?? fetchSinglePr;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let lastMergeable: string | null = null;
  let lastMergeStateStatus: string | null = null;
  let attempts = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt;
    // Sleep before retries, not before the first fetch — the happy path
    // (rebase actually worked, GitHub state already CLEAN) shouldn't pay a
    // guaranteed 3s latency. We only pay the delay if the first read is
    // UNKNOWN or the fetch fails and we need to retry.
    if (attempt > 1) await sleep(delayMs);

    let pr: GqlPrNode | null = null;
    try {
      pr = await fetchPr(prNumber, repo);
    } catch {
      pr = null;
    }

    if (pr == null) {
      // Fetch failed. Retry if we have attempts left.
      if (attempt < maxAttempts) continue;
      return {
        cleared: false,
        reason: `fetchSinglePr returned null after ${maxAttempts} attempts`,
        mergeable: lastMergeable,
        mergeStateStatus: lastMergeStateStatus,
        attempts,
      };
    }

    lastMergeable = pr.mergeable ?? null;
    lastMergeStateStatus = pr.mergeStateStatus ?? null;

    // CONFLICTING / DIRTY → still has conflicts. Checked before UNKNOWN so a
    // definitive conflict signal wins over a "still computing" one from the
    // other field (GraphQL sometimes reports them inconsistently).
    if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY') {
      return {
        cleared: false,
        reason: `PR still conflicting after rebase (mergeable=${pr.mergeable}, mergeStateStatus=${pr.mergeStateStatus ?? 'n/a'})`,
        mergeable: lastMergeable,
        mergeStateStatus: lastMergeStateStatus,
        attempts,
      };
    }

    // UNKNOWN → GitHub is still computing, poll again.
    if (pr.mergeable === 'UNKNOWN' || pr.mergeStateStatus === 'UNKNOWN') {
      if (attempt < maxAttempts) continue;
      return {
        cleared: false,
        reason: `mergeable still UNKNOWN after ${maxAttempts} polls (GitHub recomputation stalled)`,
        mergeable: lastMergeable,
        mergeStateStatus: lastMergeStateStatus,
        attempts,
      };
    }

    // MERGEABLE / BLOCKED / BEHIND / CLEAN / UNSTABLE / HAS_HOOKS → conflict
    // cleared. BLOCKED/BEHIND aren't conflicts, just other gates.
    return {
      cleared: true,
      reason: `mergeable=${pr.mergeable}, mergeStateStatus=${pr.mergeStateStatus ?? 'n/a'}`,
      mergeable: lastMergeable,
      mergeStateStatus: lastMergeStateStatus,
      attempts,
    };
  }

  return {
    cleared: false,
    reason: `max attempts (${maxAttempts}) exhausted without a definitive state`,
    mergeable: lastMergeable,
    mergeStateStatus: lastMergeStateStatus,
    attempts,
  };
}

// ── Rebase-and-verify orchestration ──────────────────────────────────────────

/**
 * Outcome of a combined rebase + verify attempt. Callers pattern-match on
 * `kind` to decide what to report / log / return. Side effects (JSONL writes,
 * worktree removal, claim tracking) are the caller's responsibility because
 * the two patrol entry points (`execution.ts::fixPr` and
 * `parallel.ts::fixPrInWorktree`) have different return shapes and different
 * claim / cleanup concerns.
 */
export type RebaseAndVerifyOutcome =
  /** `git rebase` exited non-zero (conflict, fetch failure, etc.). */
  | { kind: 'rebase-failed'; status: AutoRebaseResult['status'] }
  /** Rebase pushed, but GitHub still reports the PR as conflicting. */
  | { kind: 'verify-failed'; rebaseStatus: AutoRebaseResult['status']; verify: RebaseVerifyResult }
  /** All `stale` + `conflict` issues resolved. Caller should mark fixed. */
  | { kind: 'fully-resolved'; rebaseStatus: AutoRebaseResult['status'] }
  /** Rebase cleared stale/conflict but other issues remain. Caller should
   *  update `pr.issues` to `remainingIssues` and fall through to Claude. */
  | {
      kind: 'partially-resolved';
      rebaseStatus: AutoRebaseResult['status'];
      remainingIssues: PrIssueType[];
    };

export interface TryRebaseAndVerifyDeps {
  /** Injectable git rebase — defaults to `tryAutomatedRebase`. */
  rebase?: typeof tryAutomatedRebase;
  /** Injectable GitHub verify — defaults to `verifyRebaseCleared`. */
  verify?: typeof verifyRebaseCleared;
  /** Forwarded to `verifyRebaseCleared` when the default is used. */
  verifyDeps?: VerifyRebaseDeps;
}

/**
 * Attempt a git-level rebase and verify that GitHub considers the PR no
 * longer conflicting. Extracted from `execution.ts` + `parallel.ts` so both
 * patrol entry points share a single code path (QUA-400 simplify pass).
 *
 * Note: this function does NOT write JSONL or manage claims — each caller
 * handles those based on its own loop structure.
 */
export async function tryRebaseAndVerify(
  branch: string,
  prNumber: number,
  issues: readonly PrIssueType[],
  worktreePath: string,
  repo: string,
  deps: TryRebaseAndVerifyDeps = {},
): Promise<RebaseAndVerifyOutcome> {
  const doRebase = deps.rebase ?? tryAutomatedRebase;
  const doVerify = deps.verify ?? verifyRebaseCleared;

  const rebaseResult = doRebase(branch, worktreePath);
  if (!rebaseResult.success) {
    return { kind: 'rebase-failed', status: rebaseResult.status };
  }

  // Only pay the GitHub round-trip when we actually had a conflict to clear.
  // Stale-only rebases don't need a mergeable-state recheck.
  if (issues.includes('conflict')) {
    const verify = await doVerify(prNumber, repo, deps.verifyDeps);
    if (!verify.cleared) {
      return {
        kind: 'verify-failed',
        rebaseStatus: rebaseResult.status,
        verify,
      };
    }
  }

  const remainingIssues = issues.filter(
    (i) => i !== 'stale' && i !== 'conflict',
  );
  if (remainingIssues.length === 0) {
    return { kind: 'fully-resolved', rebaseStatus: rebaseResult.status };
  }
  return {
    kind: 'partially-resolved',
    rebaseStatus: rebaseResult.status,
    remainingIssues,
  };
}
