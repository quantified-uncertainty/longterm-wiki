/**
 * PR Analysis — General-purpose PR analysis library.
 *
 * Pure functions and simple GitHub API wrappers for:
 *   - Issue detection (conflicts, CI failures, missing test plans, staleness)
 *   - Merge eligibility checking
 *   - Priority scoring and ranking
 *   - Main branch CI status
 *   - PR file overlap detection
 *   - Automated rebase (no Claude needed)
 *
 * Used by:
 *   - crux/commands/pr.ts (CLI commands: `crux pr check`, `crux pr overlaps`)
 *   - crux/commands/ci.ts (CLI command: `crux ci main-status`)
 *   - crux/pr-patrol/ (daemon — adds logging, cooldowns, Claude spawning on top)
 *
 * Design constraints:
 *   - No daemon state (cooldowns, failure tracking, JSONL logging)
 *   - No logging — callers handle their own output
 *   - No PatrolConfig dependency — uses optional `repo?: string` params
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type {
  PrIssueType,
  BotComment,
  DetectedPr,
  ScoredPr,
  MergeBlockReason,
  MergeCandidate,
  MainBranchStatus,
  RecentMerge,
  GqlReviewThread,
  GqlPrNode,
  PrOverlap,
  AutoRebaseResult,
} from './types.ts';

export { ADVISORY_ISSUES } from './types.ts';

// ── Detection ────────────────────────────────────────────────────────────────

export {
  extractBotComments,
  detectIssues,
  fetchOpenPrs,
  fetchSinglePr,
  detectOverlaps,
} from './detection.ts';

// ── Merge eligibility ────────────────────────────────────────────────────────

export {
  checkMergeEligibility,
  findMergeCandidates,
} from './merge-check.ts';

// ── Scoring ──────────────────────────────────────────────────────────────────

export {
  ISSUE_SCORES,
  APPROVED_BONUS,
  computeScore,
  rankPrs,
} from './scoring.ts';

// ── CI status ────────────────────────────────────────────────────────────────

export { checkMainBranch, findRecentMerges } from './ci-status.ts';

// ── Deploy health ────────────────────────────────────────────────────────────

export { checkDeployHealth } from './deploy-status.ts';
export type { DeployHealthStatus } from './deploy-status.ts';

// ── Automated rebase ─────────────────────────────────────────────────────────

export { tryAutomatedRebase } from './rebase.ts';
