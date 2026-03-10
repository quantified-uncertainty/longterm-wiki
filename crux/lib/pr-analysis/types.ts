/**
 * PR Analysis — Shared types for PR issue detection, merge eligibility, and scoring.
 *
 * These types are general-purpose and used by:
 *   - crux/lib/pr-analysis/ (this library)
 *   - crux/pr-patrol/ (daemon-specific orchestration)
 *   - crux/commands/pr.ts (CLI commands)
 */

// ── Issue types ─────────────────────────────────────────────────────────────

export type PrIssueType =
  | 'conflict'
  | 'ci-failure'
  | 'missing-testplan'
  | 'missing-issue-ref'
  | 'stale'
  | 'bot-review-major'
  | 'bot-review-nitpick';

/** Issues that are logged but not fixed — advisory only.
 *  These are still detected by the shared library but filtered out by the
 *  PR Patrol daemon before scoring/fixing. They waste budget (e.g.,
 *  missing-issue-ref consistently hits max-turns with no useful outcome). */
export const ADVISORY_ISSUES: ReadonlySet<PrIssueType> = new Set([
  'missing-issue-ref',
]);

export interface BotComment {
  threadId: string;
  path: string;
  line: number | null;
  startLine: number | null;
  body: string;
  author: string;
}

export interface DetectedPr {
  number: number;
  title: string;
  branch: string;
  createdAt: string;
  issues: PrIssueType[];
  botComments: BotComment[];
  labels: string[];
  failingChecks?: string[];
}

export interface ScoredPr extends DetectedPr {
  score: number;
}

// ── Merge eligibility ───────────────────────────────────────────────────────

/** Reason a PR with stage:approved label is NOT eligible for merge. */
export type MergeBlockReason =
  | 'not-mergeable'
  | 'ci-failing'
  | 'ci-pending'
  | 'unresolved-threads'
  | 'unchecked-items'
  | 'agent-working'
  | 'pr-patrol-working'
  | 'is-draft'
  | 'in-merge-queue';

export interface MergeCandidate {
  number: number;
  title: string;
  branch: string;
  createdAt: string;
  headOid: string;
  nodeId: string; // GraphQL node ID for enqueuePullRequestForMerge
  eligible: boolean;
  blockReasons: MergeBlockReason[];
}

// ── CI status ───────────────────────────────────────────────────────────────

export interface MainBranchStatus {
  isRed: boolean;
  runId: number | null;
  sha: string;
  htmlUrl: string;
  /** SHA of the last successful CI run (only populated when isRed is true). */
  lastGreenSha?: string;
  /** ISO timestamp of the last successful CI run (only populated when isRed is true). */
  lastGreenAt?: string;
}

export interface RecentMerge {
  prNumber: number;
  title: string;
  mergedAt: string;
  mergedBy: string;
  sha: string;
}

// ── GraphQL types ───────────────────────────────────────────────────────────

export interface GqlReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  startLine: number | null;
  comments: {
    nodes: Array<{
      author: { login: string } | null;
      body: string;
    }>;
  };
}

export interface GqlPrNode {
  id: string; // GraphQL node ID (e.g. "PR_kwDON..."), needed for enqueuePullRequestForMerge
  number: number;
  title: string;
  headRefName: string;
  headRefOid: string;
  mergeable: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  body: string | null;
  author: { login: string } | null;
  labels: { nodes: Array<{ name: string }> };
  commits: {
    nodes: Array<{
      commit: {
        statusCheckRollup: {
          contexts: {
            nodes: Array<{
              conclusion?: string | null;
              state?: string;
              /** CheckRun name (e.g. 'build', 'check-protected-paths') */
              name?: string;
              /** StatusContext context string (e.g. 'ci/circleci') */
              context?: string;
            }>;
          };
        } | null;
      };
    }>;
  };
  reviewThreads?: { nodes: GqlReviewThread[] };
}

// ── Overlap detection ───────────────────────────────────────────────────────

export interface PrOverlap {
  prA: number;
  prB: number;
  sharedFiles: string[];
}

// ── Automated rebase ────────────────────────────────────────────────────────

export interface AutoRebaseResult {
  success: boolean;
  /** 'rebased' if clean rebase + push succeeded, 'conflict' if rebase had conflicts, 'push-failed' if push failed */
  status: 'rebased' | 'up-to-date' | 'conflict' | 'push-failed' | 'checkout-failed';
}
