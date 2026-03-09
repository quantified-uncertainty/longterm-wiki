/**
 * PR Patrol — Scoring re-exports and budget computation (daemon-specific)
 *
 * Pure scoring functions (computeScore, rankPrs, ISSUE_SCORES) live in
 * crux/lib/pr-analysis/scoring.ts. This module re-exports them and adds
 * the daemon-specific budget computation (max-turns + timeout per issue type).
 */

import type { PrIssueType } from './types.ts';

// ── Re-exports from lib ──────────────────────────────────────────────────────

export {
  ISSUE_SCORES,
  APPROVED_BONUS,
  computeScore,
  rankPrs,
} from '../lib/pr-analysis/index.ts';

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
  conflict:            { maxTurns: 60, timeoutMinutes: 60 },
  'ci-failure':        { maxTurns: 50, timeoutMinutes: 45 },
  'bot-review-major':  { maxTurns: 50, timeoutMinutes: 45 },
  stale:               { maxTurns: 10, timeoutMinutes: 5 },
  'missing-testplan':  { maxTurns: 8,  timeoutMinutes: 5 },
  'bot-review-nitpick':{ maxTurns: 8,  timeoutMinutes: 5 },
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
