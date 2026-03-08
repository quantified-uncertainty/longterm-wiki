/**
 * PR Analysis — Merge eligibility checking.
 *
 * Pure functions that determine whether a PR is eligible for auto-merge.
 * No I/O, no state, no logging — callers handle those concerns.
 */

import { LABELS } from '../labels.ts';
import type {
  GqlPrNode,
  MergeBlockReason,
  MergeCandidate,
} from './types.ts';

// ── Merge eligibility ────────────────────────────────────────────────────────

/** GitHub CheckRun conclusions that indicate a non-passing state. */
const FAILING_CONCLUSIONS = new Set([
  'FAILURE',
  'CANCELLED',
  'TIMED_OUT',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
  'STALE',
]);

/** Pure function — checks whether a PR is eligible for auto-merge. */
export function checkMergeEligibility(pr: GqlPrNode): MergeCandidate {
  const blockReasons: MergeBlockReason[] = [];
  const labels = pr.labels.nodes.map((l) => l.name);

  if (pr.isDraft) {
    blockReasons.push('is-draft');
  }

  if (labels.includes(LABELS.AGENT_WORKING)) {
    blockReasons.push('agent-working');
  }

  if (labels.includes(LABELS.STAGE_MERGING)) {
    blockReasons.push('in-merge-queue');
  }

  if (pr.mergeable !== 'MERGEABLE') {
    blockReasons.push('not-mergeable');
  }

  const contexts =
    pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];

  const hasFailure = contexts.some(
    (c) =>
      (c.conclusion != null && FAILING_CONCLUSIONS.has(c.conclusion)) ||
      c.state === 'FAILURE' ||
      c.state === 'ERROR',
  );
  if (hasFailure) {
    blockReasons.push('ci-failing');
  }

  if (contexts.length > 0 && !hasFailure) {
    const hasPending = contexts.some(
      (c) =>
        (c.conclusion === null || c.conclusion === undefined) &&
        c.state !== 'SUCCESS',
    );
    if (hasPending) {
      blockReasons.push('ci-pending');
    }
  }

  const threads = pr.reviewThreads?.nodes ?? [];
  const unresolvedThreads = threads.filter(
    (t) => !t.isResolved && !t.isOutdated,
  );
  if (unresolvedThreads.length > 0) {
    blockReasons.push('unresolved-threads');
  }

  const body = pr.body ?? '';
  const uncheckedCheckboxes = [...body.matchAll(/^[\s]*-\s+\[ \]/gm)];
  if (uncheckedCheckboxes.length > 0) {
    blockReasons.push('unchecked-items');
  }

  return {
    number: pr.number,
    title: pr.title,
    branch: pr.headRefName,
    createdAt: pr.createdAt,
    headOid: pr.headRefOid,
    nodeId: pr.id,
    eligible: blockReasons.length === 0,
    blockReasons,
  };
}

/** Find all PRs labeled stage:approved and check their merge eligibility. Sorted oldest first. */
export function findMergeCandidates(prs: GqlPrNode[]): MergeCandidate[] {
  return prs
    .filter((pr) => {
      const labels = pr.labels.nodes.map((l) => l.name);
      return labels.includes(LABELS.STAGE_APPROVED);
    })
    .map(checkMergeEligibility)
    .sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
}
