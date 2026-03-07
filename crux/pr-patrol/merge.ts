/**
 * PR Patrol — Merge queue execution (daemon-specific)
 *
 * Pure merge eligibility checking lives in crux/lib/pr-analysis/merge-check.ts.
 * This module handles the actual merge queue enqueue and undraft execution with:
 *   - GitHub GraphQL API calls (enqueuePullRequestForMerge, undraft mutation)
 *   - Label management (stage:merging)
 *   - JSONL logging
 *   - Comment posting
 */

import { githubApi, githubGraphQL } from '../lib/github.ts';
import { LABELS } from '../lib/labels.ts';
import {
  checkMergeEligibility as libCheckMergeEligibility,
  findMergeCandidates as libFindMergeCandidates,
} from '../lib/pr-analysis/index.ts';
import type {
  MergeCandidate,
  MergeOutcome,
  PatrolConfig,
} from './types.ts';
import { appendJsonl, JSONL_FILE, log } from './state.ts';
import {
  buildEnqueuedComment,
  buildEnqueueFailedComment,
  postEventComment,
} from './comments.ts';

// ── Re-exports for backward compatibility ────────────────────────────────

export { libCheckMergeEligibility as checkMergeEligibility };
export { libFindMergeCandidates as findMergeCandidates };

// ── Undraft execution ────────────────────────────────────────────────────

export async function undraftPr(prNum: number, config: PatrolConfig): Promise<boolean> {
  log(`→ Undrafting PR #${prNum} (all eligibility checks pass)`);

  try {
    // GitHub REST API doesn't support undrafting — must use GraphQL mutation
    const prData = await githubApi<{ node_id: string }>(
      `/repos/${config.repo}/pulls/${prNum}`,
    );
    await githubGraphQL(
      `mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }`,
      { id: prData.node_id },
    );

    log(`✓ PR #${prNum} marked as ready for review`);
    appendJsonl(JSONL_FILE, {
      type: 'undraft_result',
      pr_num: prNum,
      outcome: 'undrafted',
    });
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`✗ Failed to undraft PR #${prNum}: ${msg}`);
    appendJsonl(JSONL_FILE, {
      type: 'undraft_result',
      pr_num: prNum,
      outcome: 'error',
      reason: msg,
    });
    return false;
  }
}

// ── Label helpers ────────────────────────────────────────────────────────

async function addLabel(prNum: number, repo: string, label: string): Promise<void> {
  await githubApi(`/repos/${repo}/issues/${prNum}/labels`, {
    method: 'POST',
    body: { labels: [label] },
  });
}

async function removeLabel(prNum: number, repo: string, label: string): Promise<void> {
  await githubApi(`/repos/${repo}/issues/${prNum}/labels/${encodeURIComponent(label)}`, {
    method: 'DELETE',
  }).catch((e: unknown) => {
    // Label may not exist — not worth failing for
    log(`  Warning: could not remove label '${label}' from PR #${prNum}: ${e instanceof Error ? e.message : String(e)}`);
  });
}

// ── Merge queue enqueue ──────────────────────────────────────────────────

const ENQUEUE_MUTATION = `mutation($prId: ID!, $expectedHeadOid: GitObjectID) {
  enqueuePullRequestForMerge(input: {
    pullRequestId: $prId
    expectedHeadOid: $expectedHeadOid
  }) {
    mergeQueueEntry {
      id
      position
    }
  }
}`;

/**
 * Enqueue a PR into the GitHub merge queue.
 *
 * Adds the `stage:merging` label before enqueuing so that subsequent cycles
 * see the PR as already in the queue and don't double-enqueue.
 * On failure, removes the label and posts an error comment.
 */
export async function enqueuePr(
  candidate: MergeCandidate,
  config: PatrolConfig,
): Promise<MergeOutcome> {
  log(`→ Enqueuing PR #${candidate.number} into merge queue (${candidate.title})`);
  log(`  Branch: ${candidate.branch}`);

  if (config.dryRun) {
    log('  [DRY RUN] Would enqueue this PR into the merge queue');
    appendJsonl(JSONL_FILE, {
      type: 'merge_result',
      pr_num: candidate.number,
      outcome: 'dry-run' as MergeOutcome,
    });
    return 'dry-run';
  }

  try {
    // Add stage:merging label first to prevent double-enqueue on next cycle
    await addLabel(candidate.number, config.repo, LABELS.STAGE_MERGING);

    // Enqueue via GraphQL mutation — uses node ID and head SHA for optimistic concurrency
    await githubGraphQL(ENQUEUE_MUTATION, {
      prId: candidate.nodeId,
      expectedHeadOid: candidate.headOid,
    });

    log(`✓ PR #${candidate.number} added to merge queue`);

    await postEventComment(candidate.number, config.repo, buildEnqueuedComment())
      .catch((e2: unknown) => log(`  Warning: could not post enqueue comment: ${e2 instanceof Error ? e2.message : String(e2)}`));

    appendJsonl(JSONL_FILE, {
      type: 'merge_result',
      pr_num: candidate.number,
      outcome: 'enqueued' as MergeOutcome,
    });
    return 'enqueued';
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`✗ Failed to enqueue PR #${candidate.number}: ${msg}`);

    // Remove stage:merging label since enqueue failed
    await removeLabel(candidate.number, config.repo, LABELS.STAGE_MERGING);

    await postEventComment(candidate.number, config.repo, buildEnqueueFailedComment(msg))
      .catch((e2: unknown) => log(`  Warning: could not post enqueue failure comment: ${e2 instanceof Error ? e2.message : String(e2)}`));

    appendJsonl(JSONL_FILE, {
      type: 'merge_result',
      pr_num: candidate.number,
      outcome: 'error' as MergeOutcome,
      reason: msg,
    });
    return 'error';
  }
}
