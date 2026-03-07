/**
 * PR Patrol — Shared types and constants
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type PrIssueType =
  | 'conflict'
  | 'ci-failure'
  | 'missing-testplan'
  | 'missing-issue-ref'
  | 'stale'
  | 'bot-review-major'
  | 'bot-review-nitpick';

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
}

export interface ScoredPr extends DetectedPr {
  score: number;
}

export type FixOutcome = 'fixed' | 'no-op' | 'max-turns' | 'timeout' | 'error' | 'dry-run';

export type MergeOutcome = 'merged' | 'dry-run' | 'error';

/** Reason a PR with ready-to-merge label is NOT eligible for merge. */
export type MergeBlockReason =
  | 'not-mergeable'
  | 'ci-failing'
  | 'ci-pending'
  | 'unresolved-threads'
  | 'unchecked-items'
  | 'claude-working'
  | 'is-draft';

export interface MergeCandidate {
  number: number;
  title: string;
  branch: string;
  createdAt: string;
  eligible: boolean;
  blockReasons: MergeBlockReason[];
}

export const READY_TO_MERGE_LABEL = 'ready-to-merge';

// ── Config ───────────────────────────────────────────────────────────────────

export interface PatrolConfig {
  repo: string;
  intervalSeconds: number;
  maxTurns: number;
  cooldownSeconds: number;
  staleHours: number;
  model: string;
  skipPerms: boolean;
  once: boolean;
  dryRun: boolean;
  verbose: boolean;
  reflectionInterval: number;
  timeoutMinutes: number;
}

// ── GraphQL Types ────────────────────────────────────────────────────────────

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
  number: number;
  title: string;
  headRefName: string;
  mergeable: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  body: string | null;
  labels: { nodes: Array<{ name: string }> };
  commits: {
    nodes: Array<{
      commit: {
        statusCheckRollup: {
          contexts: {
            nodes: Array<{ conclusion?: string | null; state?: string }>;
          };
        } | null;
      };
    }>;
  };
  reviewThreads?: { nodes: GqlReviewThread[] };
}
