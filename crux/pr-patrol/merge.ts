/**
 * PR Patrol — Merge execution (daemon-specific)
 *
 * Pure merge eligibility checking lives in crux/lib/pr-analysis/merge-check.ts.
 * This module handles the actual merge and undraft execution with:
 *   - GitHub API calls (squash merge, undraft mutation)
 *   - JSONL logging
 *   - Comment posting
 */

import { githubApi, githubGraphQL } from '../lib/github.ts';
import {
  checkMergeEligibility as libCheckMergeEligibility,
  findMergeCandidates as libFindMergeCandidates,
} from '../lib/pr-analysis/index.ts';
import type {
  GqlPrNode,
  MergeCandidate,
  MergeOutcome,
  PatrolConfig,
} from './types.ts';
import { appendJsonl, JSONL_FILE, log } from './state.ts';
import {
  buildMergeComment,
  buildMergeFailedComment,
  postEventComment,
} from './comments.ts';

// ── Re-exports for backward compatibility ────────────────────────────────────

export { libCheckMergeEligibility as checkMergeEligibility };
export { libFindMergeCandidates as findMergeCandidates };

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
