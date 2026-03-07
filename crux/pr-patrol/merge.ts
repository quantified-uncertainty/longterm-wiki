/**
 * PR Patrol — Merge eligibility checking and execution
 */

import { githubApi, githubGraphQL } from '../lib/github.ts';
import type {
  GqlPrNode,
  MergeBlockReason,
  MergeCandidate,
  MergeOutcome,
  PatrolConfig,
} from './types.ts';
import { READY_TO_MERGE_LABEL } from './types.ts';
import { appendJsonl, JSONL_FILE, log } from './state.ts';
import {
  buildMergeComment,
  buildMergeFailedComment,
  postEventComment,
} from './comments.ts';

// ── Merge eligibility ────────────────────────────────────────────────────────

/** Pure function — checks whether a PR with ready-to-merge label is eligible for auto-merge. */
export function checkMergeEligibility(pr: GqlPrNode): MergeCandidate {
  const blockReasons: MergeBlockReason[] = [];
  const labels = pr.labels.nodes.map((l) => l.name);

  if (pr.isDraft) {
    blockReasons.push('is-draft');
  }

  if (labels.includes('claude-working')) {
    blockReasons.push('claude-working');
  }

  if (pr.mergeable !== 'MERGEABLE') {
    blockReasons.push('not-mergeable');
  }

  const contexts =
    pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];

  // GitHub CheckRun conclusions that indicate a non-passing state.
  // See: https://docs.github.com/en/graphql/reference/enums#checkconclusionstate
  const FAILING_CONCLUSIONS = new Set([
    'FAILURE',
    'CANCELLED',
    'TIMED_OUT',
    'ACTION_REQUIRED',
    'STARTUP_FAILURE',
    'STALE',
  ]);
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
    eligible: blockReasons.length === 0,
    blockReasons,
  };
}

/** Find all PRs labeled ready-to-merge and check their merge eligibility. Sorted oldest first. */
export function findMergeCandidates(prs: GqlPrNode[]): MergeCandidate[] {
  return prs
    .filter((pr) => {
      const labels = pr.labels.nodes.map((l) => l.name);
      return labels.includes(READY_TO_MERGE_LABEL);
    })
    .map(checkMergeEligibility)
    .sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
}

// ── Undraft execution ────────────────────────────────────────────────────────

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

// ── Merge execution ─────────────────────────────────────────────────────────

export async function mergePr(
  candidate: MergeCandidate,
  config: PatrolConfig,
): Promise<void> {
  log(`→ Merging PR #${candidate.number} (${candidate.title})`);
  log(`  Branch: ${candidate.branch}`);

  if (config.dryRun) {
    log('  [DRY RUN] Would squash-merge this PR');
    appendJsonl(JSONL_FILE, {
      type: 'merge_result',
      pr_num: candidate.number,
      outcome: 'dry-run' as MergeOutcome,
    });
    return;
  }

  try {
    // Pass head SHA for optimistic concurrency — GitHub returns 409 if
    // the PR head changed between our check and the merge request.
    await githubApi(
      `/repos/${config.repo}/pulls/${candidate.number}/merge`,
      {
        method: 'PUT',
        body: {
          merge_method: 'squash',
          sha: candidate.headOid,
        },
      },
    );

    log(`✓ PR #${candidate.number} merged successfully`);

    await postEventComment(candidate.number, config.repo, buildMergeComment())
      .catch((e2: unknown) => log(`  Warning: could not post merge comment: ${e2 instanceof Error ? e2.message : String(e2)}`));

    appendJsonl(JSONL_FILE, {
      type: 'merge_result',
      pr_num: candidate.number,
      outcome: 'merged' as MergeOutcome,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`✗ Failed to merge PR #${candidate.number}: ${msg}`);

    await postEventComment(candidate.number, config.repo, buildMergeFailedComment(msg))
      .catch((e2: unknown) => log(`  Warning: could not post merge failure comment: ${e2 instanceof Error ? e2.message : String(e2)}`));

    appendJsonl(JSONL_FILE, {
      type: 'merge_result',
      pr_num: candidate.number,
      outcome: 'error' as MergeOutcome,
      reason: msg,
    });
  }
}
