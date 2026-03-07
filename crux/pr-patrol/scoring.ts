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
  computeScore,
  rankPrs,
} from '../lib/pr-analysis/index.ts';

// ── Issue-type-specific resource limits (daemon-specific) ────────────────────
// Scale max-turns and timeout based on the hardest issue in a PR.
// This prevents trivial issues from consuming the full 40-turn / 30-min budget.

export interface IssueBudget {
  maxTurns: number;
  timeoutMinutes: number;
}

const ISSUE_BUDGETS: Record<PrIssueType, IssueBudget> = {
  conflict:            { maxTurns: 40, timeoutMinutes: 30 },
  'ci-failure':        { maxTurns: 25, timeoutMinutes: 15 },
  'bot-review-major':  { maxTurns: 25, timeoutMinutes: 15 },
  'missing-issue-ref': { maxTurns: 5,  timeoutMinutes: 3 },
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
    if (budget.maxTurns > maxTurns) maxTurns = budget.maxTurns;
    if (budget.timeoutMinutes > timeoutMinutes) timeoutMinutes = budget.timeoutMinutes;
  }
  return { maxTurns, timeoutMinutes };
}
