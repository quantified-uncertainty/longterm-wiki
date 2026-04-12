/**
 * PR Patrol — Scoring re-exports and budget computation (daemon-specific)
 *
 * Pure scoring functions (computeScore, rankPrs, ISSUE_SCORES) live in
 * crux/lib/pr-analysis/scoring.ts. This module re-exports them and adds
 * the daemon-specific budget computation (max-turns + timeout per issue type).
 */

import type { DetectedPr, PrIssueType, ScoredPr } from './types.ts';
import {
  computeScore as libComputeScore,
  computeBlocksCount,
} from '../lib/pr-analysis/index.ts';

// ── Re-exports from lib ──────────────────────────────────────────────────────

export {
  ISSUE_SCORES,
  APPROVED_BONUS,
  computeScore,
  rankPrs,
} from '../lib/pr-analysis/index.ts';

// ── Fleet-level health scores (QUA-298 Phase 1) ──────────────────────────────
// Health-gate signals are not per-PR issues — they're surfaced here so the
// two score constants live alongside ISSUE_SCORES for discoverability.
// Phase 3 wires them into the patrol loop as a precondition gate.
export {
  DEPLOY_STUCK_SCORE,
  MAIN_CI_RED_SCORE,
  type HealthIssueType,
  type HealthIssue,
} from './health-scan.ts';

// ── Cross-PR dependency priority boost (QUA-287 Phase 3) ─────────────────────

/**
 * Score bonus applied to a PR that BOTH:
 *   - has `stuckCycles >= 3` (escalation threshold), AND
 *   - blocks ≥2 other detected PRs (computed from reverse `blockedOnPrs`).
 *
 * Rationale: a stuck PR that's already holding up multiple siblings costs the
 * patrol more than its own issue score implies, so surfacing it earlier pays
 * off. Chosen to sit between `conflict` (100) and `self-authored-feedback`
 * (90) — important, but not so large it buries all other signals.
 */
export const BLOCKING_STUCK_BONUS = 50;

/** Minimum number of blocked PRs before the BLOCKING_STUCK_BONUS applies. */
export const MIN_BLOCKED_COUNT_FOR_BOOST = 2;

/**
 * Rank a list of detected PRs, applying the QUA-287 cross-PR priority boost
 * for stuck PRs that block ≥2 siblings. Uses the shared `computeScore` as
 * the base and adds `BLOCKING_STUCK_BONUS` on top when the criteria are met.
 *
 * This differs from the plain `rankPrs()` re-export above — callers that want
 * dependency-aware ordering should use this instead.
 */
export function rankPrsWithDeps(prs: DetectedPr[]): ScoredPr[] {
  const blocksCount = computeBlocksCount(prs);
  return prs
    .map((pr) => {
      let score = libComputeScore(pr);
      const blocks = blocksCount.get(pr.number) ?? 0;
      if ((pr.stuckCycles ?? 0) >= 3 && blocks >= MIN_BLOCKED_COUNT_FOR_BOOST) {
        score += BLOCKING_STUCK_BONUS;
      }
      return { ...pr, score };
    })
    .sort((a, b) => b.score - a.score);
}

// ── Issue-type-specific resource limits (daemon-specific) ────────────────────
// Scale max-turns and timeout based on the hardest issue in a PR.
// This prevents trivial issues from consuming the full 60-turn / 60-min budget.

export interface IssueBudget {
  maxTurns: number;
  timeoutMinutes: number;
}

// Note: missing-issue-ref is an advisory-only issue (see ADVISORY_ISSUES in types.ts)
// and is filtered out before reaching the budget system, so it's not listed here.
const ISSUE_BUDGETS: Partial<Record<PrIssueType, IssueBudget>> = {
  // Reduced from 60/60 — 60+ turns is counterproductive (#3776). Most conflicts
  // resolve in <20 turns; beyond that, the agent is likely stuck in a loop.
  conflict:            { maxTurns: 30, timeoutMinutes: 20 },
  'ci-failure':        { maxTurns: 50, timeoutMinutes: 45 },
  // Reduced from 15/10 — large CodeRabbit reviews are systematically unfixable
  // by patrol (#3827). Give enough turns to try, but fail fast.
  'bot-review-major':  { maxTurns: 10, timeoutMinutes: 5 },
  stale:               { maxTurns: 10, timeoutMinutes: 5 },
  'missing-testplan':  { maxTurns: 8,  timeoutMinutes: 5 },
  'bot-review-nitpick':{ maxTurns: 8,  timeoutMinutes: 5 },
  // Merge-blocked usually requires adding a label, clearing a review request,
  // or coordinating with a maintainer — lightweight work, not code changes.
  'merge-blocked':     { maxTurns: 10, timeoutMinutes: 5 },
  // Self-authored feedback requires reading the maintainer comment and
  // addressing it; keep modest but non-trivial budget.
  'self-authored-feedback': { maxTurns: 20, timeoutMinutes: 15 },
  // Stuck-cycle PRs are routed to escalation (no Claude dispatch), so the
  // budget here is a safety net for the rare case they reach fixPr() without
  // being intercepted. Keep it tiny so a misconfig doesn't burn compute.
  stuck: { maxTurns: 3, timeoutMinutes: 2 },
};

/** Compute the budget for a PR based on its hardest issue. */
export function computeBudget(issues: PrIssueType[]): IssueBudget {
  let maxTurns = 5;
  let timeoutMinutes = 3;
  for (const issue of issues) {
    const budget = ISSUE_BUDGETS[issue];
    if (!budget) continue; // advisory-only issues have no budget entry
    if (budget.maxTurns > maxTurns) maxTurns = budget.maxTurns;
    if (budget.timeoutMinutes > timeoutMinutes) timeoutMinutes = budget.timeoutMinutes;
  }
  return { maxTurns, timeoutMinutes };
}

/**
 * Compute the retry budget multiplier based on the number of previous failures.
 * First attempt gets full budget (1.0), subsequent attempts get half (0.5).
 * This prevents wasting compute on PRs where the full budget already failed.
 */
export function getRetryBudgetMultiplier(failCount: number): number {
  return failCount === 0 ? 1.0 : 0.5;
}

/**
 * Compute the effective budget for a PR, accounting for retry reduction.
 * Combines the issue-based budget, global config caps, and retry multiplier.
 */
export function computeEffectiveBudget(
  issues: PrIssueType[],
  configMaxTurns: number,
  configTimeoutMinutes: number,
  failCount: number,
): IssueBudget {
  const budget = computeBudget(issues);
  const multiplier = getRetryBudgetMultiplier(failCount);
  return {
    maxTurns: Math.ceil(Math.min(budget.maxTurns, configMaxTurns) * multiplier),
    timeoutMinutes: Math.ceil(Math.min(budget.timeoutMinutes, configTimeoutMinutes) * multiplier),
  };
}
