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
  // Self-authored feedback outranks everything else: a maintainer already told
  // the agent the PR is wrong. Rebasing past that would be actively harmful.
  'self-authored-feedback': 90,
  // Stuck-cycle: 3+ consecutive cycles with the same signal. Scored high so
  // the escalation path runs before the patrol re-dispatches a wasteful fix
  // session, but below conflict/self-authored-feedback because those are
  // better-grounded signals.
  stuck: 85,
  'ci-failure': 80,
  // Branch-protection / required-review blocks. Score below CI so a failing
  // CI gets fixed first, but above stale/bot-nitpick because the PR won't
  // merge until this is addressed.
  'merge-blocked': 70,
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
