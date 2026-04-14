import type { Config } from "../config.js";
import { getOctokit, parseRepo } from "../github.js";
import { logger as rootLogger } from "../logger.js";
import { sendDiscordNotification } from "../notify.js";

const logger = rootLogger.child({ task: "e2e-post-deploy-watcher" });

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const WORKFLOW_FILE = "e2e-post-deploy.yml";
const FAILURE_THRESHOLD = 3;
const LOOKBACK_MS = TWENTY_FOUR_HOURS_MS;
// e2e-post-deploy fires once per production deploy (typically ≤10/day).
// 50 gives plenty of headroom so a 24h window is never silently truncated.
const FETCH_LIMIT = 50;

// Rate-limit Discord alerts per fingerprint. Module-level state; resets on
// process restart, same pattern as snapshot-retention.ts.
const lastAlertAt = new Map<string, number>();

/** Test-only: reset rate-limit state. */
export function __resetAlertRateLimitForTest(): void {
  lastAlertAt.clear();
}

interface RunRef {
  conclusion: string | null;
  htmlUrl: string;
  createdAt: string;
}

export interface WatcherEvaluation {
  failures: RunRef[];
  considered: number;
  shouldAlert: boolean;
}

/**
 * Pure evaluator: given recent runs (newest first) and a cutoff, count
 * failures within the window and decide whether the alert threshold is hit.
 * `failure` conclusion only; `cancelled` / `timed_out` / `startup_failure`
 * are treated as infra noise (matches evaluateWorkflowRedStreak in audits.ts).
 */
export function evaluateWatcher(
  runs: RunRef[],
  cutoffMs: number,
  threshold: number,
): WatcherEvaluation {
  const inWindow = runs.filter((r) => {
    const t = Date.parse(r.createdAt);
    return Number.isFinite(t) && t >= cutoffMs;
  });
  const failures = inWindow.filter((r) => r.conclusion === "failure");
  return {
    failures,
    considered: inWindow.length,
    shouldAlert: failures.length >= threshold,
  };
}

export async function e2ePostDeployWatcher(
  config: Config,
): Promise<{ success: boolean; summary?: string }> {
  const octokit = getOctokit(config);
  const { owner, repo } = parseRepo(config);

  let runs: RunRef[];
  try {
    const { data } = await octokit.rest.actions.listWorkflowRuns({
      owner,
      repo,
      workflow_id: WORKFLOW_FILE,
      per_page: FETCH_LIMIT,
      status: "completed",
    });
    // Sort newest-first explicitly so `failures[0]` in the alert is reliably
    // the most recent failing run regardless of GitHub's default ordering.
    runs = data.workflow_runs
      .map((r) => ({
        conclusion: r.conclusion,
        htmlUrl: r.html_url,
        createdAt: r.created_at,
      }))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "Failed to fetch workflow runs");
    // Fail-closed: we don't know if there's a red streak, so return failure
    // but don't spam Discord — the scheduler's consecutive-failure tracking
    // covers sustained GitHub API outages.
    return { success: false, summary: `Failed to fetch runs: ${msg}` };
  }

  const cutoff = Date.now() - LOOKBACK_MS;
  const evalResult = evaluateWatcher(runs, cutoff, FAILURE_THRESHOLD);

  const summary =
    `${evalResult.failures.length}/${evalResult.considered} ${WORKFLOW_FILE} ` +
    `runs failed in last 24h (threshold=${FAILURE_THRESHOLD})`;

  if (!evalResult.shouldAlert) {
    logger.info(
      { failures: evalResult.failures.length, considered: evalResult.considered },
      summary,
    );
    return { success: true, summary };
  }

  const fingerprint = `${WORKFLOW_FILE}:threshold=${FAILURE_THRESHOLD}`;
  const now = Date.now();
  const last = lastAlertAt.get(fingerprint) ?? 0;
  if (now - last < SIX_HOURS_MS) {
    logger.info(
      { fingerprint, lastAlertAgeMs: now - last },
      "Alert suppressed (rate-limited to 1 per 6h)",
    );
    return { success: true, summary: `${summary} (alert suppressed)` };
  }

  lastAlertAt.set(fingerprint, now);
  const mostRecentFailure = evalResult.failures[0];
  const message =
    `⚠️ **e2e-post-deploy red streak** — ${evalResult.failures.length}/${evalResult.considered} ` +
    `runs of \`${WORKFLOW_FILE}\` failed in the last 24h ` +
    `(threshold=${FAILURE_THRESHOLD}). ` +
    (mostRecentFailure
      ? `Most recent failure: ${mostRecentFailure.htmlUrl}. `
      : "") +
    `See QUA-411 / QUA-451.`;

  try {
    await sendDiscordNotification(config, message);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "Failed to send Discord alert");
    return { success: false, summary: `${summary} (Discord send failed: ${msg})` };
  }

  logger.warn({ failures: evalResult.failures.length }, `Alert fired: ${summary}`);
  return { success: true, summary: `${summary} (alert fired)` };
}
