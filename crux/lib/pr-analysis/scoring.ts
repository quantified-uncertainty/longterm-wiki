/**
 * PR Analysis — Priority scoring for PR issues.
 *
 * Pure functions — no I/O, no state. Used for ranking PRs by urgency.
 */

import type { DetectedPr, PrIssueType, ScoredPr } from './types.ts';
import { LABELS } from '../labels.ts';

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

/** Bonus for PRs with stage:approved — they're one fix away from merging. */
export const APPROVED_BONUS = 100;

/** Pure function — computes priority score for a detected PR. */
export function computeScore(pr: DetectedPr): number {
  let score = 0;
  for (const issue of pr.issues) score += ISSUE_SCORES[issue] ?? 0;

  // Age bonus: 1 point per hour, capped at 50
  const ageHours = (Date.now() - new Date(pr.createdAt).getTime()) / 3_600_000;
  score += Math.min(50, Math.max(0, Math.floor(ageHours)));

  // Approved PRs get a priority boost — fixing them unblocks a merge
  if (pr.labels?.includes(LABELS.STAGE_APPROVED)) {
    score += APPROVED_BONUS;
  }

  return score;
}

export function rankPrs(prs: DetectedPr[]): ScoredPr[] {
  return prs
    .map((pr) => ({ ...pr, score: computeScore(pr) }))
    .sort((a, b) => b.score - a.score);
}
