/**
 * PR Analysis — Wiki-server deploy health check.
 *
 * Pure GitHub API wrapper — no daemon state, no logging.
 * Queries the wiki-server-docker.yml workflow for recent deploy status.
 */

import { githubApi, REPO } from '../github.ts';

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

export interface DeployHealthStatus {
  healthy: boolean;
  lastDeploy: {
    status: string; // 'success' | 'failure' | 'cancelled' | etc.
    sha: string;
    url: string;
    timestamp: string;
  } | null;
  failingSince: string | null; // ISO timestamp of first consecutive failure
}

// ── Constants ────────────────────────────────────────────────────────────────

const DEPLOY_WORKFLOW = 'wiki-server-docker.yml';

// ── Deploy health check ─────────────────────────────────────────────────────

/**
 * Check whether the wiki-server deploy pipeline is healthy.
 * Returns status without side effects — no logging, no state updates.
 */
export async function checkDeployHealth(repo?: string): Promise<DeployHealthStatus> {
  const r = repo ?? REPO;
  const notAvailable: DeployHealthStatus = { healthy: true, lastDeploy: null, failingSince: null };

  try {
    const resp = await githubApi<WorkflowRunsResponse>(
      `/repos/${r}/actions/workflows/${DEPLOY_WORKFLOW}/runs?per_page=5&status=completed`,
    );

    const runs = resp.workflow_runs ?? [];
    if (runs.length === 0) return notAvailable;

    const latest = runs[0];
    const lastDeploy = {
      status: latest.conclusion ?? 'unknown',
      sha: latest.head_sha,
      url: latest.html_url,
      timestamp: latest.created_at,
    };

    if (latest.conclusion === 'success') {
      return { healthy: true, lastDeploy, failingSince: null };
    }

    // Find when consecutive failures started (walk backward through runs)
    let failingSince = latest.created_at;
    for (const run of runs) {
      if (run.conclusion === 'success') break;
      failingSince = run.created_at;
    }

    return { healthy: false, lastDeploy, failingSince };
  } catch {
    // Fail-open: if we can't check deploy health, assume it's fine.
    // Callers handle their own error reporting if needed.
    return notAvailable;
  }
}
