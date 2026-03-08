/**
 * PR Analysis — Main branch CI status check.
 *
 * Pure GitHub API wrapper — no cooldown logic, no state management.
 * Callers (like PR Patrol) add their own cooldown/abandoned checks on top.
 */

import { githubApi, REPO } from '../github.ts';
import type { MainBranchStatus, RecentMerge } from './types.ts';

// ── Types ────────────────────────────────────────────────────────────────────

interface WorkflowRun {
  id: number;
  status: string;
  conclusion: string | null;
  created_at: string;
  head_sha: string;
  html_url: string;
}

interface WorkflowRunsResponse {
  workflow_runs: WorkflowRun[];
  total_count: number;
}

// ── Constants ────────────────────────────────────────────────────────────────

const CI_WORKFLOW = 'ci.yml';

// ── Main branch CI status ────────────────────────────────────────────────────

/**
 * Check whether the main branch CI is passing or failing.
 * Returns status without side effects — no logging, no state updates.
 */
export async function checkMainBranch(repo?: string): Promise<MainBranchStatus> {
  const r = repo ?? REPO;
  const notRed: MainBranchStatus = { isRed: false, runId: null, sha: '', htmlUrl: '' };

  try {
    const resp = await githubApi<WorkflowRunsResponse>(
      `/repos/${r}/actions/workflows/${CI_WORKFLOW}/runs?branch=main&status=completed&per_page=5`,
    );

    const runs = resp.workflow_runs ?? [];
    if (runs.length === 0) return notRed;

    const latest = runs[0];
    // Intentionally narrower than merge-check.ts FAILING_CONCLUSIONS:
    // main-branch alert only fires on hard 'failure', not 'cancelled'/'timed_out'.
    // Cancelled/timed-out runs on main are transient and self-heal on re-run.
    if (latest.conclusion === 'failure') {
      // Find the last green run to help identify culprits
      const lastGreen = runs.find((r) => r.conclusion === 'success');
      return {
        isRed: true,
        runId: latest.id,
        sha: latest.head_sha,
        htmlUrl: latest.html_url,
        lastGreenSha: lastGreen?.head_sha,
        lastGreenAt: lastGreen?.created_at,
      };
    }

    return notRed;
  } catch {
    // Best-effort: if the API call fails (network, auth, rate-limit), assume CI is not red.
    // Callers handle their own error reporting if needed.
    return notRed;
  }
}

// ── Recent merge identification ─────────────────────────────────────────────

interface PullRequestListItem {
  number: number;
  title: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
  user: { login: string } | null;
}

/**
 * Find PRs merged since a given timestamp.
 * Used to identify likely culprits when main CI goes red.
 */
export async function findRecentMerges(repo?: string, since?: string): Promise<RecentMerge[]> {
  if (!since) return [];
  const r = repo ?? REPO;

  try {
    const pulls = await githubApi<PullRequestListItem[]>(
      `/repos/${r}/pulls?state=closed&sort=updated&direction=desc&per_page=10`,
    );

    const sinceTime = new Date(since).getTime();
    return pulls
      .filter((pr) => pr.merged_at && new Date(pr.merged_at).getTime() >= sinceTime)
      .map((pr) => ({
        prNumber: pr.number,
        title: pr.title,
        mergedAt: pr.merged_at!,
        mergedBy: pr.user?.login ?? 'unknown',
        sha: pr.merge_commit_sha ?? '',
      }));
  } catch {
    // Fail-open: culprit identification is informational only
    return [];
  }
}
