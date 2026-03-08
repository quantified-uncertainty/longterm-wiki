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
import { appendJsonl, cl, JSONL_FILE, log } from './state.ts';
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
  log(`${cl.bold}→${cl.reset} Undrafting PR ${cl.cyan}#${prNum}${cl.reset} (all eligibility checks pass)`);

  try {
    // GitHub REST API doesn't support undrafting — must use GraphQL mutation
    const prData = await githubApi<{ node_id: string }>(
      `/repos/${config.repo}/pulls/${prNum}`,
    );
    await githubGraphQL(
      `mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }`,
      { id: prData.node_id },
    );

    log(`${cl.green}✓ PR #${prNum} marked as ready for review${cl.reset}`);
    appendJsonl(JSONL_FILE, {
      type: 'undraft_result',
      pr_num: prNum,
      outcome: 'undrafted',
    });
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`${cl.red}✗ Failed to undraft PR #${prNum}: ${msg}${cl.reset}`);
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

// ── Merge queue queries ──────────────────────────────────────────────────

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

/** Check whether a PR is currently in the merge queue (read-only). */
const QUEUE_STATUS_QUERY = `query($prId: ID!) {
  node(id: $prId) {
    ... on PullRequest {
      mergeQueueEntry { id position }
    }
  }
}`;

async function isInMergeQueue(nodeId: string): Promise<boolean> {
  try {
    const data = await githubGraphQL<{
      node: { mergeQueueEntry: { id: string; position: number } | null } | null;
    }>(QUEUE_STATUS_QUERY, { prId: nodeId });
    return data.node?.mergeQueueEntry != null;
  } catch {
    // If the query fails, assume indeterminate — safer to keep the label
    return true;
  }
}

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
  log(`${cl.bold}→${cl.reset} Enqueuing PR ${cl.cyan}#${candidate.number}${cl.reset} into merge queue (${candidate.title})`);
  log(`  Branch: ${cl.dim}${candidate.branch}${cl.reset}`);

  if (config.dryRun) {
    log(`  ${cl.dim}[DRY RUN] Would enqueue this PR into the merge queue${cl.reset}`);
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

    log(`${cl.green}✓ PR #${candidate.number} added to merge queue${cl.reset}`);

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
    log(`${cl.red}✗ Failed to enqueue PR #${candidate.number}: ${msg}${cl.reset}`);

    // The enqueue may have succeeded despite the thrown error (e.g. transport
    // error after GitHub accepted the mutation). Check actual queue state
    // before removing the label to avoid clearing it incorrectly.
    const actuallyInQueue = await isInMergeQueue(candidate.nodeId);
    if (actuallyInQueue) {
      log(`  PR #${candidate.number} is actually in the merge queue — keeping stage:merging label`);
      appendJsonl(JSONL_FILE, {
        type: 'merge_result',
        pr_num: candidate.number,
        outcome: 'enqueued' as MergeOutcome,
        reason: `enqueue succeeded despite error: ${msg}`,
      });
      return 'enqueued';
    }

    // Confirmed not in queue — safe to remove label
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

// ── Merge queue reconciliation ───────────────────────────────────────────

/**
 * Reconcile `stage:merging` labels against actual merge queue state.
 *
 * GitHub can eject PRs from the merge queue (CI failure in the merge group,
 * manual dequeue, base branch changes) without notifying us. This leaves
 * stale `stage:merging` labels that block both re-enqueuing and auto-rebasing.
 *
 * Call this at the start of each cycle to clean up.
 */
export async function reconcileMergeQueueLabels(
  allPrs: Array<{ id: string; number: number; labels: { nodes: Array<{ name: string }> } }>,
  config: PatrolConfig,
): Promise<void> {
  const prsWithMergingLabel = allPrs.filter((pr) =>
    pr.labels.nodes.some((l) => l.name === LABELS.STAGE_MERGING),
  );

  if (prsWithMergingLabel.length === 0) return;

  log(`Reconciling ${prsWithMergingLabel.length} PR(s) with stage:merging label...`);

  for (const pr of prsWithMergingLabel) {
    const inQueue = await isInMergeQueue(pr.id);
    if (!inQueue) {
      log(`  PR #${pr.number}: not in merge queue — removing stale stage:merging label`);
      await removeLabel(pr.number, config.repo, LABELS.STAGE_MERGING);
    }
  }
}
