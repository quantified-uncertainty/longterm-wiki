/**
 * PR Patrol — Fleet-level health scanner (QUA-298 Phase 1).
 *
 * Detects system-level health signals that per-PR scanners miss:
 *   - Last production deploy failed (or consecutive deploys failing)
 *   - Main CI red streak across multiple commits
 *
 * Phase 1 scope (this file): emit detections. Phase 3 wires them into the
 * patrol loop as a precondition gate. See QUA-297 for the full retrospective.
 *
 * Pure evaluation functions take already-fetched data, so they can be unit
 * tested without network. The outer `checkDeployStatus()` / `checkMainCi()`
 * wrappers do the I/O and then delegate to the pure functions.
 */

import { REPO, githubApi, githubGraphQL } from '../lib/github.ts';

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Workflow file for the wiki-server production deploy. A failure here means
 * the migration / build / smoke-test pipeline broke.
 */
export const WIKI_SERVER_DEPLOY_WORKFLOW = 'wiki-server-docker.yml';

/**
 * Min consecutive failed deploys (from most recent, on production branch)
 * before we consider the deploy pipeline stuck. Requires ≥2 to avoid flapping
 * on a single transient failure.
 */
export const DEPLOY_STUCK_MIN_CONSECUTIVE_FAILURES = 2;

/**
 * Min consecutive failed main-CI runs before we flag a red streak. Set higher
 * than deploy (3 vs 2) because main CI historically flaps more often than
 * production deploys.
 */
export const MAIN_CI_RED_STREAK_MIN = 3;

/**
 * If the most recent successful deploy is older than this, the pipeline is
 * considered stale — even if no explicit failure is observed yet. Catches the
 * case where CI hasn't run at all for hours.
 */
export const DEPLOY_STALE_THRESHOLD_HOURS = 6;

/** Score bonus for the deploy-stuck signal. Must outrank all per-PR issues. */
export const DEPLOY_STUCK_SCORE = 200;

/** Score bonus for a main-CI red streak. Below deploy-stuck but above per-PR. */
export const MAIN_CI_RED_SCORE = 180;

// ── Types ────────────────────────────────────────────────────────────────────

export interface WorkflowRun {
  id: number;
  conclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | null;
  status: string;
  createdAt: string;
  htmlUrl: string;
  displayTitle: string;
  headBranch: string;
}

export interface CommitStatus {
  sha: string;
  url: string;
  createdAt: string;
  /** Aggregate CI conclusion across check runs + commit status for this commit. */
  conclusion: 'success' | 'failure' | 'pending' | 'neutral' | null;
}

export interface DeployStatusResult {
  healthy: boolean;
  reason: string;
  lastSuccessfulDeployAt: Date | null;
  failingDeploys: WorkflowRun[];
}

export interface MainCiResult {
  healthy: boolean;
  reason: string;
  failingCount: number;
  redStreakStarted: Date | null;
  failingCommits: CommitStatus[];
}

export type HealthIssueType = 'deploy-stuck' | 'main-ci-red';

export interface HealthIssue {
  type: HealthIssueType;
  score: number;
  /** Human-readable summary suitable for coordinator escalation. */
  reason: string;
  /** Most-relevant link (failing run URL, failing commit URL). */
  url?: string;
  detectedAt: string;
}

export interface HealthScanResult {
  healthy: boolean;
  deploy: DeployStatusResult;
  mainCi: MainCiResult;
  issues: HealthIssue[];
}

// ── Pure evaluators (no I/O — unit-testable) ─────────────────────────────────

/**
 * Given recent workflow runs on the production branch (newest first), decide
 * whether the deploy pipeline is healthy.
 *
 * Rules:
 *  - ≥ DEPLOY_STUCK_MIN_CONSECUTIVE_FAILURES failures at the head → unhealthy
 *  - Last successful deploy older than DEPLOY_STALE_THRESHOLD_HOURS AND at least
 *    one failure since → unhealthy (age + hint of breakage)
 *  - Otherwise healthy, even if there's a single old failure buried in the list
 *
 * Note: "no deploys in 6h" alone is not flagged — the repo may simply be quiet.
 * A failure since the last success is required to rule out "nothing to deploy".
 */
export function evaluateDeployStatus(
  runs: WorkflowRun[],
  now: Date = new Date(),
): DeployStatusResult {
  if (runs.length === 0) {
    return {
      healthy: true,
      reason: 'no recent deploy runs observed',
      lastSuccessfulDeployAt: null,
      failingDeploys: [],
    };
  }

  // Skip LEADING in-progress runs (conclusion null). An in-progress run at the
  // head shouldn't hide a failing streak underneath — treat it as "not yet
  // resolved" and look at what's already settled.
  let headIdx = 0;
  while (headIdx < runs.length && runs[headIdx].conclusion === null) headIdx++;
  const resolved = runs.slice(headIdx);

  let consecutiveFailures = 0;
  for (const run of resolved) {
    if (run.conclusion === 'failure') consecutiveFailures++;
    else break;
  }

  const lastSuccess = resolved.find((r) => r.conclusion === 'success') ?? null;
  const lastSuccessfulDeployAt = lastSuccess ? new Date(lastSuccess.createdAt) : null;
  const failingDeploys = resolved.slice(0, consecutiveFailures);

  if (consecutiveFailures >= DEPLOY_STUCK_MIN_CONSECUTIVE_FAILURES) {
    const last = resolved[0];
    const reason =
      `${consecutiveFailures} consecutive production deploy failures ` +
      `(most recent: ${last.displayTitle} at ${last.createdAt})`;
    return {
      healthy: false,
      reason,
      lastSuccessfulDeployAt,
      failingDeploys,
    };
  }

  if (lastSuccessfulDeployAt && consecutiveFailures >= 1) {
    const ageHours = (now.getTime() - lastSuccessfulDeployAt.getTime()) / 3_600_000;
    if (ageHours > DEPLOY_STALE_THRESHOLD_HOURS) {
      return {
        healthy: false,
        reason:
          `last successful deploy was ${ageHours.toFixed(1)}h ago and ` +
          `there has been at least one failure since`,
        lastSuccessfulDeployAt,
        failingDeploys,
      };
    }
  }

  return {
    healthy: true,
    reason:
      consecutiveFailures === 0
        ? 'latest production deploy succeeded'
        : `single deploy failure observed (not yet ≥${DEPLOY_STUCK_MIN_CONSECUTIVE_FAILURES} consecutive — likely a flap)`,
    lastSuccessfulDeployAt,
    failingDeploys,
  };
}

/**
 * Given recent commits on main (newest first), decide whether CI is healthy.
 * A red streak of ≥ MAIN_CI_RED_STREAK_MIN at the head of the list is unhealthy.
 * Pending checks at the head are skipped (not counted as either pass or fail).
 */
export function evaluateMainCi(commits: CommitStatus[]): MainCiResult {
  // Skip LEADING pending / null commits only. Stripping pending globally would
  // collapse [fail, pending, fail, fail] into a fake 3-streak. Pending in the
  // middle of the list breaks the streak like any other non-failure would.
  let start = 0;
  while (
    start < commits.length &&
    (commits[start].conclusion === 'pending' || commits[start].conclusion === null)
  ) {
    start++;
  }
  const resolved = commits.slice(start);

  if (resolved.length === 0) {
    return {
      healthy: true,
      reason: 'no resolved main CI runs observed',
      failingCount: 0,
      redStreakStarted: null,
      failingCommits: [],
    };
  }

  let streak = 0;
  for (const c of resolved) {
    if (c.conclusion === 'failure') streak++;
    else break;
  }

  const failingCommits = resolved.slice(0, streak);
  const redStreakStarted =
    failingCommits.length > 0
      ? new Date(failingCommits[failingCommits.length - 1].createdAt)
      : null;

  if (streak >= MAIN_CI_RED_STREAK_MIN) {
    return {
      healthy: false,
      reason: `main CI has ${streak} consecutive failing commits (streak started ${redStreakStarted?.toISOString()})`,
      failingCount: streak,
      redStreakStarted,
      failingCommits,
    };
  }

  return {
    healthy: true,
    reason:
      streak === 0
        ? 'latest main CI runs succeeded'
        : `${streak} main CI failure(s) observed (below ≥${MAIN_CI_RED_STREAK_MIN} threshold — likely a flap)`,
    failingCount: streak,
    redStreakStarted,
    failingCommits,
  };
}

/**
 * Combine deploy + main-CI evaluations into a single HealthScanResult.
 * Pure — takes the two sub-results and assembles the issue list for the queue.
 */
export function combineHealth(
  deploy: DeployStatusResult,
  mainCi: MainCiResult,
  now: Date = new Date(),
): HealthScanResult {
  const issues: HealthIssue[] = [];
  const detectedAt = now.toISOString();

  if (!deploy.healthy) {
    issues.push({
      type: 'deploy-stuck',
      score: DEPLOY_STUCK_SCORE,
      reason: deploy.reason,
      url: deploy.failingDeploys[0]?.htmlUrl,
      detectedAt,
    });
  }

  if (!mainCi.healthy) {
    issues.push({
      type: 'main-ci-red',
      score: MAIN_CI_RED_SCORE,
      reason: mainCi.reason,
      url: mainCi.failingCommits[0]?.url,
      detectedAt,
    });
  }

  return {
    healthy: deploy.healthy && mainCi.healthy,
    deploy,
    mainCi,
    issues,
  };
}

// ── I/O wrappers ─────────────────────────────────────────────────────────────

interface ListRunsResponse {
  workflow_runs: Array<{
    id: number;
    conclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | null;
    status: string;
    created_at: string;
    html_url: string;
    display_title: string;
    head_branch: string;
  }>;
}

/**
 * Fetch the last N production-branch runs for the wiki-server deploy workflow
 * and evaluate health.
 */
export async function checkDeployStatus(
  options: {
    workflow?: string;
    branch?: string;
    limit?: number;
    now?: Date;
  } = {},
): Promise<DeployStatusResult> {
  const workflow = options.workflow ?? WIKI_SERVER_DEPLOY_WORKFLOW;
  const branch = options.branch ?? 'production';
  const limit = options.limit ?? 5;

  const resp = await githubApi<ListRunsResponse>(
    `/repos/${REPO}/actions/workflows/${encodeURIComponent(workflow)}/runs` +
      `?branch=${encodeURIComponent(branch)}&per_page=${limit}`,
  );

  const runs: WorkflowRun[] = resp.workflow_runs.map((r) => ({
    id: r.id,
    conclusion: r.conclusion,
    status: r.status,
    createdAt: r.created_at,
    htmlUrl: r.html_url,
    displayTitle: r.display_title,
    headBranch: r.head_branch,
  }));

  return evaluateDeployStatus(runs, options.now);
}

interface MainCommitsGql {
  repository: {
    ref: {
      target: {
        history: {
          nodes: Array<{
            oid: string;
            committedDate: string;
            url: string;
            statusCheckRollup: {
              state: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'ERROR' | 'EXPECTED' | 'NEUTRAL';
            } | null;
          }>;
        };
      };
    };
  };
}

const MAIN_COMMITS_QUERY = /* GraphQL */ `
  query MainCiCommits($owner: String!, $name: String!, $first: Int!) {
    repository(owner: $owner, name: $name) {
      ref(qualifiedName: "refs/heads/main") {
        target {
          ... on Commit {
            history(first: $first) {
              nodes {
                oid
                committedDate
                url
                statusCheckRollup {
                  state
                }
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * Fetch the last N commits on main and their aggregate CI conclusion, then
 * evaluate for a red streak.
 */
export async function checkMainCi(
  options: {
    limit?: number;
    repo?: string;
  } = {},
): Promise<MainCiResult> {
  const limit = options.limit ?? 5;
  const [owner, name] = (options.repo ?? REPO).split('/');

  const data = await githubGraphQL<MainCommitsGql>(MAIN_COMMITS_QUERY, {
    owner,
    name,
    first: limit,
  });

  const nodes = data.repository?.ref?.target?.history?.nodes ?? [];

  const commits: CommitStatus[] = nodes.map((n) => ({
    sha: n.oid,
    url: n.url,
    createdAt: n.committedDate,
    conclusion: mapRollupState(n.statusCheckRollup?.state ?? null),
  }));

  return evaluateMainCi(commits);
}

export function mapRollupState(
  state: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'ERROR' | 'EXPECTED' | 'NEUTRAL' | null,
): CommitStatus['conclusion'] {
  if (state === 'SUCCESS') return 'success';
  if (state === 'FAILURE' || state === 'ERROR') return 'failure';
  if (state === 'PENDING' || state === 'EXPECTED') return 'pending';
  if (state === 'NEUTRAL') return 'neutral';
  return null;
}

/**
 * Run both scanners and combine into one HealthScanResult. Intended to be
 * called at the start of each patrol cycle (Phase 3 wiring).
 *
 * Throws if either GitHub call fails (5xx, rate limit, network). Phase 3 is
 * responsible for deciding policy on scanner failure — a transient API hiccup
 * shouldn't silently look like "healthy".
 */
export async function healthScan(now: Date = new Date()): Promise<HealthScanResult> {
  const [deploy, mainCi] = await Promise.all([
    checkDeployStatus({ now }),
    checkMainCi(),
  ]);
  return combineHealth(deploy, mainCi, now);
}
