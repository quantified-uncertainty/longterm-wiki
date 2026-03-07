/**
 * PR Patrol — Structured status comments on PRs.
 *
 * Gives humans visibility into what PR Patrol thinks about each PR:
 * - A persistent status comment (upserted) showing CI, conflicts, review threads, checklist
 * - One-off event comments for merges, fixes, and abandonments
 *
 * The status comment uses an HTML marker to find and update itself without
 * creating duplicate comments.
 */

import { githubApi } from '../lib/github.ts';
import type { GqlPrNode, MergeBlockReason } from './index.ts';

// ── Constants ────────────────────────────────────────────────────────────────

/** Hidden HTML marker used to identify the PR Patrol status comment. */
export const STATUS_MARKER = '<!-- pr-patrol-status -->';

// ── Types ────────────────────────────────────────────────────────────────────

interface GitHubComment {
  id: number;
  body: string;
  user: { login: string } | null;
}

export interface StatusCommentInfo {
  id: number;
  body: string;
}

// ── Status comment: find ─────────────────────────────────────────────────────

/**
 * Find the PR Patrol status comment on a PR (by marker).
 *
 * Returns the comment's ID and body (so callers can compare without a
 * second fetch), or null if no status comment exists.
 *
 * Searches from the most recent comments backward (`direction=desc`) so we
 * find the status comment in the first page even on PRs with 100+ comments.
 */
export async function findStatusComment(
  prNum: number,
  repo: string,
): Promise<StatusCommentInfo | null> {
  // Fetch up to 100 most-recent comments — the status comment was created
  // recently relative to total PR history, so desc ordering finds it fast.
  const comments = await githubApi<GitHubComment[]>(
    `/repos/${repo}/issues/${prNum}/comments?per_page=100&sort=created&direction=desc`,
  );

  for (const comment of comments) {
    if (comment.body.includes(STATUS_MARKER)) {
      return { id: comment.id, body: comment.body };
    }
  }

  return null;
}

// ── Status comment: build ────────────────────────────────────────────────────

interface CiStatus {
  label: string;
  emoji: string;
}

function getCiStatus(pr: GqlPrNode): CiStatus {
  const contexts =
    pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];

  if (contexts.length === 0) {
    return { label: 'no checks', emoji: '\u{26AA}' }; // white circle
  }

  const hasFailure = contexts.some(
    (c) =>
      c.conclusion === 'FAILURE' ||
      c.conclusion === 'CANCELLED' ||
      c.state === 'FAILURE' ||
      c.state === 'ERROR',
  );
  if (hasFailure) {
    return { label: 'failing', emoji: '\u{274C}' }; // red X
  }

  const hasPending = contexts.some(
    (c) =>
      (c.conclusion === null || c.conclusion === undefined) &&
      c.state !== 'SUCCESS',
  );
  if (hasPending) {
    return { label: 'pending', emoji: '\u{23F3}' }; // hourglass
  }

  return { label: 'passing', emoji: '\u{2705}' }; // green check
}

function getConflictStatus(pr: GqlPrNode): { label: string; emoji: string } {
  if (pr.mergeable === 'MERGEABLE') {
    return { label: 'clean', emoji: '\u{2705}' };
  }
  if (pr.mergeable === 'CONFLICTING') {
    return { label: 'has conflicts', emoji: '\u{274C}' };
  }
  // UNKNOWN — GitHub hasn't computed mergeability yet
  return { label: 'unknown', emoji: '\u{26AA}' };
}

function getReviewThreadStatus(pr: GqlPrNode): { label: string; emoji: string } {
  const threads = pr.reviewThreads?.nodes ?? [];
  const unresolved = threads.filter((t) => !t.isResolved && !t.isOutdated);

  if (unresolved.length === 0) {
    return { label: 'none unresolved', emoji: '\u{2705}' };
  }
  return {
    label: `${unresolved.length} unresolved`,
    emoji: '\u{274C}',
  };
}

function getChecklistStatus(pr: GqlPrNode): { label: string; emoji: string } {
  const body = pr.body ?? '';
  const unchecked = [...body.matchAll(/^[\s]*-\s+\[ \]/gm)];

  if (unchecked.length === 0) {
    return { label: 'complete', emoji: '\u{2705}' };
  }
  return {
    label: `${unchecked.length} unchecked`,
    emoji: '\u{274C}',
  };
}

function formatUtcTimestamp(): string {
  const now = new Date();
  return now.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

/**
 * Compute the "stage" string from block reasons.
 */
function computeStage(blockReasons: MergeBlockReason[]): string {
  if (blockReasons.length === 0) {
    return 'Ready to merge';
  }

  // Map block reasons to human-readable stage descriptions
  if (blockReasons.includes('claude-working')) {
    return 'Claude is working on this PR';
  }
  if (blockReasons.includes('ci-pending')) {
    return 'Waiting for CI to complete';
  }
  if (
    blockReasons.includes('ci-failing') ||
    blockReasons.includes('not-mergeable') ||
    blockReasons.includes('unresolved-threads') ||
    blockReasons.includes('unchecked-items')
  ) {
    return 'Waiting for issues to be resolved';
  }
  if (blockReasons.includes('is-draft')) {
    return 'Draft PR';
  }

  return 'Waiting for human review';
}

/**
 * Build the status comment markdown from current PR state.
 *
 * Reuses the same logic as `checkMergeEligibility()` for consistency.
 */
export function buildStatusCommentBody(
  pr: GqlPrNode,
  blockReasons: MergeBlockReason[],
): string {
  const ci = getCiStatus(pr);
  const conflicts = getConflictStatus(pr);
  const threads = getReviewThreadStatus(pr);
  const checklist = getChecklistStatus(pr);
  const stage = computeStage(blockReasons);
  const timestamp = formatUtcTimestamp();

  const lines = [
    STATUS_MARKER,
    '\u{1F916} **PR Patrol Status**',
    '',
    '| Check | Status |',
    '|-------|--------|',
    `| CI | ${ci.emoji} ${ci.label} |`,
    `| Conflicts | ${conflicts.emoji} ${conflicts.label} |`,
    `| Review threads | ${threads.emoji} ${threads.label} |`,
    `| Checklist | ${checklist.emoji} ${checklist.label} |`,
    '',
    `**Stage**: ${stage}`,
  ];

  if (blockReasons.length > 0) {
    lines.push(`**Blocks**: ${blockReasons.map((r) => '`' + r + '`').join(', ')}`);
  }

  lines.push('');
  lines.push(`<sub>Updated: ${timestamp}</sub>`);

  return lines.join('\n');
}

/**
 * Strip the timestamp line from a status comment body for comparison.
 * This prevents spurious updates when only the timestamp changed.
 */
export function stripTimestamp(body: string): string {
  return body.replace(/<sub>Updated:.*<\/sub>/, '').trim();
}

// ── Status comment: upsert ───────────────────────────────────────────────────

/**
 * Create or update the PR Patrol status comment.
 *
 * Only PATCHes if content actually changed (strips timestamps for comparison).
 * This prevents GitHub from sending notification emails every cycle.
 */
export async function upsertStatusComment(
  prNum: number,
  repo: string,
  body: string,
): Promise<void> {
  const existing = await findStatusComment(prNum, repo);

  if (existing !== null) {
    // Compare without timestamps to avoid spurious updates
    if (stripTimestamp(existing.body) === stripTimestamp(body)) {
      return; // No meaningful change — skip update
    }

    await githubApi(`/repos/${repo}/issues/comments/${existing.id}`, {
      method: 'PATCH',
      body: { body },
    });
  } else {
    await githubApi(`/repos/${repo}/issues/${prNum}/comments`, {
      method: 'POST',
      body: { body },
    });
  }
}

// ── Event comments ───────────────────────────────────────────────────────────

/**
 * Post a one-off event comment (for merges, fixes, abandonments).
 * These are NOT upserted — each call creates a new comment.
 */
export async function postEventComment(
  prNum: number,
  repo: string,
  body: string,
): Promise<void> {
  await githubApi(`/repos/${repo}/issues/${prNum}/comments`, {
    method: 'POST',
    body: { body },
  });
}

// ── Event comment builders ───────────────────────────────────────────────────

export function buildMergeComment(): string {
  return '\u{1F916} **PR Patrol** \u{2014} Merged to main via squash merge.';
}

export function buildMergeFailedComment(reason: string): string {
  return `\u{1F916} **PR Patrol** \u{2014} Merge failed: ${reason}`;
}

export function buildFixAttemptComment(issues: string[]): string {
  return `\u{1F916} **PR Patrol** \u{2014} Attempting fix for: ${issues.join(', ')}`;
}

export function buildFixCompleteComment(
  elapsedS: number,
  maxTurns: number,
  model: string,
  issues: string[],
  outputTail: string,
): string {
  const trimmedOutput = outputTail.slice(-300);
  return [
    `\u{1F916} **PR Patrol** \u{2014} Fix attempt complete (${elapsedS}s, ${maxTurns} max turns, model: ${model}).`,
    '',
    `**Issues detected**: ${issues.join(', ')}`,
    '',
    '**Result**:',
    trimmedOutput,
  ].join('\n');
}

export function buildAbandonmentComment(
  failCount: number,
  issues: string[],
): string {
  return [
    `\u{1F916} **PR Patrol** \u{2014} Abandoning after ${failCount} failed fix attempts. This PR needs human intervention.`,
    '',
    `**Issues**: ${issues.join(', ')}`,
  ].join('\n');
}

export function buildTimeoutComment(
  failCount: number,
  timeoutMinutes: number,
  issues: string[],
): string {
  return [
    `\u{1F916} **PR Patrol** \u{2014} Fix attempt timed out after ${timeoutMinutes}m (attempt ${failCount}).`,
    '',
    `**Issues**: ${issues.join(', ')}`,
  ].join('\n');
}

export function buildNoOpComment(issues: string[]): string {
  return [
    '\u{1F916} **PR Patrol** \u{2014} Agent determined this issue needs human intervention (no code changes made).',
    '',
    `**Issues**: ${issues.join(', ')}`,
  ].join('\n');
}
