/**
 * CI Main Branch Health Check
 *
 * Detects the "silent CI death" scenario: when the main branch CI workflow
 * stops producing any results at all (YAML syntax errors, missing permissions,
 * deleted workflow files, etc.) so zero jobs run and zero failures are reported.
 *
 * This is distinct from the existing `checkActions` function, which only checks
 * whether the most-recent CI run succeeded. If CI never runs, there are no
 * recent runs to check.
 *
 * The check:
 *   1. Queries completed CI runs on `main` branch in the last 24 hours.
 *   2. Also queries *all* CI runs on `main` (regardless of conclusion) in 24h
 *      to distinguish "CI ran but failed" from "CI never ran".
 *   3. Alerts if zero runs (of any kind) triggered in the last 24 hours.
 *   4. Alerts if CI ran but had 0 successful runs in the last 24 hours.
 */

import type { CheckResult } from '../health-check.ts';
import { githubApi, REPO } from '../../lib/github.ts';

interface WorkflowRun {
  id: number;
  status: string;
  conclusion: string | null;
  created_at: string;
  head_branch: string;
  html_url: string;
}

interface WorkflowRunsResponse {
  workflow_runs: WorkflowRun[];
  total_count: number;
}

/** Hours since an ISO timestamp (positive = in the past). */
export function hoursAgoCI(isoString: string, now: number = Date.now()): number {
  const ms = now - new Date(isoString).getTime();
  return ms / 3_600_000;
}

/** Returns true if a workflow run is within the given age threshold (in hours). */
export function isWithinHours(isoString: string, thresholdHours: number, now: number = Date.now()): boolean {
  return hoursAgoCI(isoString, now) <= thresholdHours;
}

const LOOKBACK_HOURS = 24;
const CI_WORKFLOW = 'ci.yml';

export async function checkCiMainHealth(): Promise<CheckResult> {
  const name = 'CI main branch';
  const detail: string[] = [];

  if (!process.env.GITHUB_TOKEN) {
    return {
      name,
      ok: false,
      summary: 'GITHUB_TOKEN not set',
      detail: ['Set GITHUB_TOKEN to enable CI main branch health checks'],
    };
  }

  const now = Date.now();
  const since = new Date(now - LOOKBACK_HOURS * 3_600_000).toISOString();

  // Fetch all completed runs on main in the last 24h
  let allRuns: WorkflowRun[] = [];
  try {
    const resp = await githubApi<WorkflowRunsResponse>(
      `/repos/${REPO}/actions/workflows/${CI_WORKFLOW}/runs?branch=main&created=>=${since}&per_page=25`
    );
    allRuns = resp.workflow_runs ?? [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name,
      ok: false,
      summary: `GitHub API error fetching CI runs: ${msg}`,
      detail: [`Could not query CI workflow runs: ${msg}`],
    };
  }

  // Filter to runs actually created within the lookback window
  // (The `created` query param may not be supported on all GitHub API versions;
  // filter client-side as a safety net.)
  const recentRuns = allRuns.filter((r) => isWithinHours(r.created_at, LOOKBACK_HOURS, now));

  detail.push(`Lookback: last ${LOOKBACK_HOURS}h`);
  detail.push(`CI runs on main (last ${LOOKBACK_HOURS}h): ${recentRuns.length}`);

  if (recentRuns.length === 0) {
    // Could mean:
    //   a) No commits pushed to main in 24h (normal over weekends)
    //   b) Workflow YAML is broken (silent failure mode we're guarding against)
    // Either way, flag it so a human can check.
    detail.push(`WARN  No CI runs triggered on main in the last ${LOOKBACK_HOURS}h`);
    detail.push('      This may be normal (no pushes to main) or indicate a broken workflow.');
    detail.push(`      Check: https://github.com/${REPO}/actions/workflows/${CI_WORKFLOW}`);

    return {
      name,
      ok: false,
      summary: `No CI runs on main in the last ${LOOKBACK_HOURS}h — workflow may be broken or no recent pushes`,
      detail,
    };
  }

  // We have recent runs — count by conclusion
  const successful = recentRuns.filter((r) => r.conclusion === 'success');
  const failed = recentRuns.filter((r) => r.conclusion === 'failure');
  const inProgress = recentRuns.filter((r) => r.status === 'in_progress' || r.status === 'queued' || r.status === 'waiting');
  const other = recentRuns.filter(
    (r) => r.conclusion !== 'success' && r.conclusion !== 'failure' && r.status !== 'in_progress' && r.status !== 'queued' && r.status !== 'waiting'
  );

  detail.push(`  Successful: ${successful.length}`);
  detail.push(`  Failed:     ${failed.length}`);
  detail.push(`  In-progress/queued: ${inProgress.length}`);
  if (other.length > 0) {
    detail.push(`  Other (cancelled, skipped, etc.): ${other.length}`);
  }

  // If there are in-progress runs, CI is actively running — not broken
  if (successful.length > 0) {
    const latestSuccess = successful[0];
    const ageH = Math.round(hoursAgoCI(latestSuccess.created_at, now));
    detail.push(`PASS  Last successful CI run: ${ageH}h ago (run #${latestSuccess.id})`);
    return {
      name,
      ok: true,
      summary: `${successful.length} successful CI run(s) on main in the last ${LOOKBACK_HOURS}h`,
      detail,
    };
  }

  // Runs exist but none succeeded
  if (inProgress.length > 0) {
    detail.push(`INFO  ${inProgress.length} CI run(s) currently in progress — no completed success yet`);
    return {
      name,
      ok: true,
      summary: `CI is running (${inProgress.length} in-progress, no success yet in last ${LOOKBACK_HOURS}h)`,
      detail,
    };
  }

  // Runs exist, all completed, none succeeded
  const latestRun = recentRuns[0];
  const ageH = Math.round(hoursAgoCI(latestRun.created_at, now));
  detail.push(`FAIL  ${recentRuns.length} CI run(s) on main in last ${LOOKBACK_HOURS}h, 0 successful`);
  detail.push(`      Latest run: conclusion='${latestRun.conclusion}' ${ageH}h ago`);
  detail.push(`      See: ${latestRun.html_url}`);

  return {
    name,
    ok: false,
    summary: `${recentRuns.length} CI run(s) on main in last ${LOOKBACK_HOURS}h but 0 successful (latest: '${latestRun.conclusion}')`,
    detail,
  };
}
