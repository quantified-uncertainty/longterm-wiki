/**
 * PR Analysis — Main branch CI status check.
 *
 * Pure GitHub API wrapper — no cooldown logic, no state management.
 * Callers (like PR Patrol) add their own cooldown/abandoned checks on top.
 */

import { githubApi, REPO } from '../github.ts';
import type { MainBranchStatus } from './types.ts';

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
      return {
        isRed: true,
        runId: latest.id,
        sha: latest.head_sha,
        htmlUrl: latest.html_url,
      };
    }

    return notRed;
  } catch {
    // Best-effort: if the API call fails (network, auth, rate-limit), assume CI is not red.
    // Callers handle their own error reporting if needed.
    return notRed;
  }
}
