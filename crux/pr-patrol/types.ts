/**
 * PR Patrol — Shared types and constants
 *
 * Daemon-specific types live here (PatrolConfig, FixOutcome, MergeOutcome).
 * General-purpose analysis types are re-exported from crux/lib/pr-analysis/.
 */

// ── Re-export general-purpose types from lib ─────────────────────────────────

export type {
  PrIssueType,
  BotComment,
  DetectedPr,
  ScoredPr,
  MergeBlockReason,
  MergeCandidate,
  GqlReviewThread,
  GqlPrNode,
  MainBranchStatus,
  PrOverlap,
  AutoRebaseResult,
} from '../lib/pr-analysis/types.ts';

// ── Daemon-specific types ────────────────────────────────────────────────────

export type FixOutcome = 'fixed' | 'no-op' | 'max-turns' | 'timeout' | 'error' | 'dry-run';

export type MergeOutcome = 'merged' | 'enqueued' | 'dry-run' | 'error';

// Re-export LABELS for backward compatibility with consumers that import from types.ts
export { LABELS } from '../lib/labels.ts';

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
