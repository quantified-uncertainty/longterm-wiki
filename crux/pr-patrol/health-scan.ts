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
import { gitSafe } from '../lib/git.ts';
import { RATCHET_BASELINES, type RatchetConfig } from './ratchet-config.ts';

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

/**
 * Min bumps in the bad direction within the window before ratchet-drift fires.
 * Chosen at 3 because 2 can easily be legitimate rebase-flurry; 3+ is when
 * the "we're papering over something" pattern emerges.
 */
export const RATCHET_DRIFT_MIN_BUMPS = 3;

/**
 * Sliding window for ratchet-drift detection. 24h aligns with the retrospective
 * incident where a baseline moved 3+ times in the same night.
 */
export const RATCHET_DRIFT_WINDOW_HOURS = 24;

/**
 * Score bonus for a ratchet-drift signal. Below deploy-stuck + main-ci-red but
 * still above every per-PR issue so it surfaces before the patrol re-dispatches
 * another bump attempt.
 */
export const RATCHET_DRIFT_SCORE = 150;

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

export type HealthIssueType = 'deploy-stuck' | 'main-ci-red' | 'ratchet-drift';

export interface HealthIssue {
  type: HealthIssueType;
  score: number;
  /** Human-readable summary suitable for coordinator escalation. */
  reason: string;
  /** Most-relevant link (failing run URL, failing commit URL). */
  url?: string;
  detectedAt: string;
}

/**
 * One observation of a ratchet baseline at a specific commit.
 * `total === null` means the file didn't exist at that commit (or couldn't be
 * read / parsed) — the evaluator treats it as "no data point" and skips it.
 */
export interface BaselineObservation {
  commit: string;
  committedAt: Date;
  total: number | null;
}

export interface RatchetDriftForFile {
  file: string;
  name: string;
  /** How the total moved — only populated when drift is flagged. */
  direction: 'up' | 'down' | null;
  /** Number of bumps in the bad direction within the window. */
  bumpCount: number;
  /** The specific bumps that tripped the threshold (oldest → newest). */
  bumps: Array<{
    commit: string;
    committedAt: string;
    from: number;
    to: number;
  }>;
  /** True when the count exceeds the threshold in the bad direction. */
  drifted: boolean;
  reason: string;
}

export interface RatchetDriftResult {
  healthy: boolean;
  reason: string;
  drifts: RatchetDriftForFile[];
}

export interface HealthScanResult {
  healthy: boolean;
  deploy: DeployStatusResult;
  mainCi: MainCiResult;
  ratchet: RatchetDriftResult;
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
 * Given observations of a ratchet baseline (oldest → newest) and a window,
 * decide whether the file has drifted in the bad direction.
 *
 * Rules:
 *  - Only observations within `windowHours` of `now` are considered.
 *  - Consecutive observations where `total` changed and both values are
 *    non-null form a "bump". Direction = sign(to - from).
 *  - Bumps in the bad direction count; bumps in the good direction RESET
 *    the counter — we only care about unchecked drift. (A legitimate fix
 *    that moves the number down shouldn't be hidden by yesterday's bad bump.)
 *  - Drift fires when bad-direction bumps ≥ `minBumps`.
 */
export function evaluateRatchetDrift(
  file: string,
  name: string,
  observations: BaselineObservation[],
  options: {
    badDirection: 'up' | 'down';
    now?: Date;
    windowHours?: number;
    minBumps?: number;
  },
): RatchetDriftForFile {
  const now = options.now ?? new Date();
  const windowHours = options.windowHours ?? RATCHET_DRIFT_WINDOW_HOURS;
  const minBumps = options.minBumps ?? RATCHET_DRIFT_MIN_BUMPS;
  const windowStart = now.getTime() - windowHours * 3_600_000;

  // Keep only observations inside the window — sorted oldest → newest so
  // consecutive-pair deltas flow naturally.
  const inWindow = observations
    .filter((o) => o.committedAt.getTime() >= windowStart)
    .sort((a, b) => a.committedAt.getTime() - b.committedAt.getTime());

  // A good-direction bump resets the counter; bad-direction bumps accumulate.
  // Track the counter + the bumps that contributed to the current streak so
  // the escalation message can name them.
  let badBumps: RatchetDriftForFile['bumps'] = [];

  for (let i = 1; i < inWindow.length; i++) {
    const prev = inWindow[i - 1];
    const curr = inWindow[i];
    if (prev.total === null || curr.total === null) continue;
    if (curr.total === prev.total) continue;

    const direction: 'up' | 'down' = curr.total > prev.total ? 'up' : 'down';
    if (direction === options.badDirection) {
      badBumps.push({
        commit: curr.commit,
        committedAt: curr.committedAt.toISOString(),
        from: prev.total,
        to: curr.total,
      });
    } else {
      // A fix in the good direction invalidates the streak.
      badBumps = [];
    }
  }

  const bumpCount = badBumps.length;
  const drifted = bumpCount >= minBumps;

  if (drifted) {
    const arrow = options.badDirection === 'up' ? '↑' : '↓';
    const first = badBumps[0];
    const last = badBumps[bumpCount - 1];
    return {
      file,
      name,
      direction: options.badDirection,
      bumpCount,
      bumps: badBumps,
      drifted: true,
      reason:
        `${name} baseline bumped ${bumpCount}× ${arrow} in the last ${windowHours}h ` +
        `(${first.from} → ${last.to}). Do NOT bump again — investigate the underlying cause.`,
    };
  }

  return {
    file,
    name,
    direction: bumpCount > 0 ? options.badDirection : null,
    bumpCount,
    bumps: badBumps,
    drifted: false,
    reason:
      bumpCount === 0
        ? `${name} baseline stable over the last ${windowHours}h`
        : `${name} baseline bumped ${bumpCount}× (below ≥${minBumps} threshold — monitoring)`,
  };
}

/**
 * Collapse a list of per-file drift results into the aggregate RatchetDriftResult.
 * Pure.
 */
export function combineRatchetDrift(drifts: RatchetDriftForFile[]): RatchetDriftResult {
  const drifted = drifts.filter((d) => d.drifted);
  if (drifted.length === 0) {
    return {
      healthy: true,
      reason:
        drifts.length === 0
          ? 'no ratchet baselines registered'
          : 'all ratchet baselines within thresholds',
      drifts,
    };
  }

  return {
    healthy: false,
    reason: drifted.map((d) => d.reason).join(' | '),
    drifts,
  };
}

/**
 * Read a registered ratchet's history over the last `windowHours` via git log
 * and evaluate for drift. Each commit that touched the file contributes one
 * observation; the file is read at that commit via `git show`.
 *
 * Unlike `checkDeployStatus` / `checkMainCi`, this scanner is local-only — no
 * network, no GitHub API. It runs against the current working tree's git repo.
 */
export function checkRatchetDriftForFile(
  config: RatchetConfig,
  options: { now?: Date; windowHours?: number; minBumps?: number } = {},
): RatchetDriftForFile {
  const windowHours = options.windowHours ?? RATCHET_DRIFT_WINDOW_HOURS;
  const since = `${windowHours} hours ago`;

  // One commit per line: `<sha> <unix-ts>`
  const logResult = gitSafe(
    'log',
    `--since=${since}`,
    '--format=%H %ct',
    '--',
    config.file,
  );

  if (!logResult.ok || !logResult.output) {
    return {
      file: config.file,
      name: config.name,
      direction: null,
      bumpCount: 0,
      bumps: [],
      drifted: false,
      reason:
        !logResult.ok
          ? `git log failed for ${config.file}: ${logResult.stderr || 'unknown error'}`
          : `${config.name} baseline: no commits in the last ${windowHours}h`,
    };
  }

  // git log is newest-first; we want oldest-first for evaluation.
  const lines = logResult.output.split('\n').filter(Boolean).reverse();

  // Include the "before" state: the parent of the earliest in-window commit.
  // Without it we'd miss bump #1 (can't compute from/to for the first commit).
  const firstCommit = lines[0]?.split(' ')[0];
  const observations: BaselineObservation[] = [];

  if (firstCommit) {
    const parentTotal = readBaselineTotal(`${firstCommit}^`, config);
    if (parentTotal !== null) {
      const parentTs = commitTimestamp(`${firstCommit}^`);
      if (parentTs) {
        observations.push({
          commit: `${firstCommit}^`,
          committedAt: parentTs,
          total: parentTotal,
        });
      }
    }
  }

  for (const line of lines) {
    const [sha, ts] = line.split(' ');
    if (!sha || !ts) continue;
    observations.push({
      commit: sha,
      committedAt: new Date(Number.parseInt(ts, 10) * 1000),
      total: readBaselineTotal(sha, config),
    });
  }

  return evaluateRatchetDrift(config.file, config.name, observations, {
    badDirection: config.badDirection,
    now: options.now,
    windowHours,
    minBumps: options.minBumps,
  });
}

/** Run the drift scan across every registered baseline. */
export function checkRatchetDrift(
  options: { now?: Date; windowHours?: number; minBumps?: number } = {},
  baselines: readonly RatchetConfig[] = RATCHET_BASELINES,
): RatchetDriftResult {
  const drifts = baselines.map((cfg) => checkRatchetDriftForFile(cfg, options));
  return combineRatchetDrift(drifts);
}

function readBaselineTotal(ref: string, config: RatchetConfig): number | null {
  const result = gitSafe('show', `${ref}:${config.file}`);
  if (!result.ok) return null;
  try {
    const parsed = JSON.parse(result.output);
    const value = (parsed as Record<string, unknown>)[config.totalField];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function commitTimestamp(ref: string): Date | null {
  const result = gitSafe('show', '-s', '--format=%ct', ref);
  if (!result.ok) return null;
  const ts = Number.parseInt(result.output, 10);
  if (!Number.isFinite(ts)) return null;
  return new Date(ts * 1000);
}

/**
 * Combine deploy + main-CI evaluations into a single HealthScanResult.
 * Pure — takes the two sub-results and assembles the issue list for the queue.
 */
export function combineHealth(
  deploy: DeployStatusResult,
  mainCi: MainCiResult,
  ratchet: RatchetDriftResult,
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

  for (const drift of ratchet.drifts) {
    if (!drift.drifted) continue;
    issues.push({
      type: 'ratchet-drift',
      score: RATCHET_DRIFT_SCORE,
      reason: drift.reason,
      detectedAt,
    });
  }

  return {
    healthy: deploy.healthy && mainCi.healthy && ratchet.healthy,
    deploy,
    mainCi,
    ratchet,
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
  const ratchet = checkRatchetDrift({ now });
  return combineHealth(deploy, mainCi, ratchet, now);
}
