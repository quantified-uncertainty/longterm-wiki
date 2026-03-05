/**
 * PR & Issue Quality Health Check
 *
 * Checks:
 *   - Recent PRs with empty/missing body (<20 chars)
 *   - Stale open PRs (>7 days since last update)
 *   - Issues stuck with claude-working label (>8 hours)
 *   - Open bug count (informational)
 *
 * Optionally auto-removes stale claude-working labels (self-healing).
 */

import type { CheckResult } from '../health-check.ts';
import { githubApi, REPO } from '../../lib/github.ts';

interface PullRequest {
  number: number;
  title: string;
  body: string | null;
  created_at: string;
  updated_at: string;
  state: string;
}

interface Issue {
  number: number;
  title: string;
  created_at: string;
  updated_at: string;
  labels: Array<{ name: string }>;
}

/** How many hours ago an ISO timestamp was. */
export function hoursAgoFromNow(isoString: string, now: number = Date.now()): number {
  const ms = now - new Date(isoString).getTime();
  return Math.round(ms / 3_600_000);
}

const STALE_PR_THRESHOLD_H = 7 * 24; // 7 days
const STUCK_LABEL_THRESHOLD_H = 8; // 8 hours

export async function checkPrQuality(options?: {
  cleanupStaleLabels?: boolean;
}): Promise<CheckResult> {
  const name = 'PR & issue quality';
  const detail: string[] = [];
  const failures: string[] = [];
  const cleanupStaleLabels = options?.cleanupStaleLabels ?? false;

  if (!process.env.GITHUB_TOKEN) {
    return {
      name,
      ok: false,
      summary: 'GITHUB_TOKEN not set',
      detail: ['Set GITHUB_TOKEN to enable PR/issue quality checks'],
    };
  }

  // ── Pull request quality checks ──────────────────────────────────────

  let recentPrs: PullRequest[] = [];
  try {
    recentPrs = await githubApi<PullRequest[]>(
      `/repos/${REPO}/pulls?state=all&per_page=30&sort=created&direction=desc`,
    );
  } catch (err) {
    detail.push(`SKIP  PRs: ${err instanceof Error ? err.message : String(err)}`);
  }

  detail.push(`PRs fetched: ${recentPrs.length} recent PRs reviewed`);

  // Check for PRs with empty/missing body
  const emptyBodyPrs = recentPrs.filter(
    (pr) => !pr.body || pr.body.trim().length < 20,
  );
  if (emptyBodyPrs.length > 0) {
    failures.push(`${emptyBodyPrs.length} PR(s) missing descriptions`);
    for (const pr of emptyBodyPrs) {
      detail.push(`WARN  PR #${pr.number} ${pr.title.slice(0, 50)} — missing description`);
    }
  } else {
    detail.push('PASS  All recent PRs have descriptions');
  }

  // Check for stale open PRs (>7 days since last update)
  let openPrs: PullRequest[] = [];
  try {
    openPrs = await githubApi<PullRequest[]>(
      `/repos/${REPO}/pulls?state=open&per_page=20&sort=updated&direction=asc`,
    );
  } catch (err) {
    detail.push(`SKIP  Open PRs: ${err instanceof Error ? err.message : String(err)}`);
  }

  const now = Date.now();
  const stalePrs = openPrs.filter((pr) => {
    const lastActivity = pr.updated_at || pr.created_at;
    return hoursAgoFromNow(lastActivity, now) > STALE_PR_THRESHOLD_H;
  });

  if (stalePrs.length > 0) {
    detail.push(`WARN  ${stalePrs.length} open PR(s) with no activity for 7+ days`);
    for (const pr of stalePrs) {
      detail.push(`       #${pr.number} ${pr.title.slice(0, 50)}`);
    }
  } else {
    detail.push('PASS  No stale open PRs');
  }

  // ── Issue quality checks ─────────────────────────────────────────────

  // Check for claude-working label issues stuck >8 hours
  let stuckIssues: Issue[] = [];
  try {
    stuckIssues = await githubApi<Issue[]>(
      `/repos/${REPO}/issues?labels=claude-working&state=open&per_page=20`,
    );
  } catch (err) {
    detail.push(`SKIP  claude-working issues: ${err instanceof Error ? err.message : String(err)}`);
  }

  const stuckOnes = stuckIssues.filter((issue) => {
    const lastActivity = issue.updated_at || issue.created_at;
    return hoursAgoFromNow(lastActivity, now) > STUCK_LABEL_THRESHOLD_H;
  });

  if (stuckOnes.length > 0) {
    failures.push(`${stuckOnes.length} issue(s) stuck with claude-working label for 8+ hours`);

    if (cleanupStaleLabels) {
      for (const issue of stuckOnes) {
        try {
          await githubApi(
            `/repos/${REPO}/issues/${issue.number}/labels/${encodeURIComponent('claude-working')}`,
            { method: 'DELETE' },
          );
          detail.push(`WARN  #${issue.number} ${issue.title.slice(0, 50)} — auto-removed stale claude-working label`);
        } catch (err) {
          // 404 means label was already removed — that's fine
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes('404')) {
            detail.push(`WARN  #${issue.number} — failed to remove label: ${msg}`);
          } else {
            detail.push(`WARN  #${issue.number} ${issue.title.slice(0, 50)} — label already removed`);
          }
        }
      }
    } else {
      for (const issue of stuckOnes) {
        detail.push(`WARN  #${issue.number} ${issue.title.slice(0, 50)} — stuck with claude-working`);
      }
    }
  } else {
    detail.push('PASS  No stuck claude-working sessions');
  }

  // Count open bugs (informational)
  try {
    const bugs = await githubApi<Issue[]>(
      `/repos/${REPO}/issues?labels=bug&state=open&per_page=100`,
    );
    detail.push(`INFO  ${bugs.length} open bug(s)`);
  } catch (err) {
    detail.push(`SKIP  Bug count: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (failures.length > 0) {
    return { name, ok: false, summary: 'PR/issue quality issues found', detail };
  }
  return { name, ok: true, summary: 'PR and issue quality looks good', detail };
}
