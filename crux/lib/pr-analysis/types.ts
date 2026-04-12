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
  | 'bot-review-nitpick'
  | 'merge-blocked'
  | 'self-authored-feedback';

/** Issues that are logged but not fixed — advisory only.
 *  These are still detected by the shared library but filtered out by the
 *  PR Patrol daemon before scoring/fixing. They waste budget (e.g.,
 *  missing-issue-ref consistently hits max-turns with no useful outcome). */
export const ADVISORY_ISSUES: ReadonlySet<PrIssueType> = new Set([
  'missing-issue-ref',
  'missing-testplan',
]);

export interface BotComment {
  threadId: string;
  path: string;
  line: number | null;
  startLine: number | null;
  body: string;
  author: string;
}

/**
 * A top-level issue comment on a PR (not a review thread).
 * Used to surface blocking/maintainer feedback that patrol would otherwise miss.
 */
export interface BlockingComment {
  /** Author login (maintainer, bot, etc.) */
  author: string;
  /** Author association with the repo (OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE) */
  authorAssociation: string;
  /** Author type (User, Bot, Mannequin, Organization) */
  authorType: string;
  /** Comment body */
  body: string;
  /** ISO timestamp */
  createdAt: string;
  /** Whether the viewer (current auth token) authored this comment */
  viewerDidAuthor: boolean;
}

/**
 * Fresh check-run data fetched via REST (bypasses stale GraphQL rollup).
 * GraphQL statusCheckRollup can lag behind actual check-run state by several minutes;
 * REST is immediate. We cache by SHA since check-runs are immutable once conclusion is set.
 */
export interface FreshCheckRun {
  name: string;
  /** queued | in_progress | completed */
  status: string;
  /** success | failure | neutral | cancelled | timed_out | action_required | stale | skipped | null (when still running) */
  conclusion: string | null;
  /** URL to the check-run details */
  htmlUrl?: string;
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
  /**
   * Top-level PR comments that look blocking/urgent from a maintainer or bot.
   * Populated when at least one newer-than-last-push comment contains urgency
   * keywords or comes from a repo owner/member/collaborator.
   */
  blockingComments?: BlockingComment[];
  /**
   * Check-runs fetched fresh via REST for the head SHA. Use this instead of
   * statusCheckRollup for decisions that need to be up-to-date.
   */
  freshCheckRuns?: FreshCheckRun[];
  /**
   * GitHub's mergeStateStatus field (DIRTY, BLOCKED, BEHIND, CLEAN, HAS_HOOKS,
   * UNKNOWN, UNSTABLE). This is distinct from mergeable: mergeable only reports
   * conflicts, while mergeStateStatus reflects branch protection, required
   * reviews, required checks, etc.
   */
  mergeStateStatus?: string;
  /** True when the PR was authored by the patrol/agent itself (e.g., claude/ branch). */
  isSelfAuthored?: boolean;
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

export interface GqlIssueComment {
  author: { login: string; __typename?: string } | null;
  authorAssociation: string;
  body: string;
  createdAt: string;
  viewerDidAuthor: boolean;
}

export interface GqlCrossReferencedEvent {
  __typename?: 'CrossReferencedEvent';
  source?: unknown;
  createdAt?: string;
}

export interface GqlPrNode {
  id: string; // GraphQL node ID (e.g. "PR_kwDON..."), needed for enqueuePullRequestForMerge
  number: number;
  title: string;
  /** PR state: OPEN, CLOSED, or MERGED. Present when the GQL query requests it. */
  state?: string;
  headRefName: string;
  headRefOid: string;
  mergeable: string;
  /** GitHub's mergeStateStatus (DIRTY, BLOCKED, BEHIND, CLEAN, HAS_HOOKS, UNKNOWN, UNSTABLE). */
  mergeStateStatus?: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  body: string | null;
  author: { login: string } | null;
  labels: { nodes: Array<{ name: string }> };
  commits: {
    nodes: Array<{
      commit: {
        /**
         * ISO timestamp of the last push for the head ref, used to decide
         * whether comments arrived after the latest code push.
         */
        pushedDate?: string | null;
        committedDate?: string | null;
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
  /** Top-level PR conversation comments (last 20). */
  comments?: { nodes: GqlIssueComment[] };
  /** Timeline items (CROSS_REFERENCED_EVENT only for now — Phase 3 uses these). */
  timelineItems?: { nodes: GqlCrossReferencedEvent[] };
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
