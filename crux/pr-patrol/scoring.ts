/**
 * PR Patrol — Scoring and budget computation
 */

import type { DetectedPr, PrIssueType, ScoredPr } from './types.ts';

// ── Issue scores ─────────────────────────────────────────────────────────────

export const ISSUE_SCORES: Record<PrIssueType, number> = {
  conflict: 100,
  'ci-failure': 80,
  'bot-review-major': 55,
  'missing-issue-ref': 40,
  stale: 30,
  'missing-testplan': 20,
  'bot-review-nitpick': 15,
};

/** Pure function — computes priority score for a detected PR. */
export function computeScore(pr: DetectedPr): number {
  let score = 0;
  for (const issue of pr.issues) score += ISSUE_SCORES[issue] ?? 0;

  // Age bonus: 1 point per hour, capped at 50
  const ageHours = (Date.now() - new Date(pr.createdAt).getTime()) / 3_600_000;
  score += Math.min(50, Math.max(0, Math.floor(ageHours)));

  return score;
}

export function rankPrs(prs: DetectedPr[]): ScoredPr[] {
  return prs
    .map((pr) => ({ ...pr, score: computeScore(pr) }))
    .sort((a, b) => b.score - a.score);
}

// ── Issue-type-specific resource limits ──────────────────────────────────────
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
