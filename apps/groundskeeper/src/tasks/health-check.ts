import type { Config } from "../config.js";
import { getOctokit, parseRepo } from "../github.js";
import {
  recordFailure,
  getCurrentOutage,
  clearOutage,
  addToBuffer,
  flushBuffer,
  backfillOutageIncident,
} from "../incident-buffer.js";
import { logger as rootLogger } from "../logger.js";
import { recordIncident } from "../wiki-server.js";

const logger = rootLogger.child({ task: "health-check" });

const ISSUE_TITLE = "[Groundskeeper] Wiki server health check failure";

/**
 * Minimum time (ms) after an issue is closed before we create a new one.
 * If the server flaps (recovers briefly then fails again), we reopen the
 * recently-closed issue instead of creating a brand new one.
 */
const REOPEN_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

async function findOpenHealthIssue(config: Config) {
  const octokit = getOctokit(config);
  const { owner, repo } = parseRepo(config);

  // Search by title using the search API — more reliable than filtering
  // by labels, which can have indexing delays or permission issues.
  const { data } = await octokit.rest.search.issuesAndPullRequests({
    q: `repo:${owner}/${repo} is:issue is:open in:title "${ISSUE_TITLE}"`,
    per_page: 5,
  });

  return data.items.find((issue) => issue.title === ISSUE_TITLE);
}

/**
 * Find the most recently closed health check issue.
 * Returns it only if it was closed within the reopen window.
 */
async function findRecentlyClosedHealthIssue(config: Config) {
  const octokit = getOctokit(config);
  const { owner, repo } = parseRepo(config);

  const { data } = await octokit.rest.search.issuesAndPullRequests({
    q: `repo:${owner}/${repo} is:issue is:closed in:title "${ISSUE_TITLE}"`,
    sort: "updated",
    order: "desc",
    per_page: 1,
  });

  const issue = data.items.find((i) => i.title === ISSUE_TITLE);
  if (!issue?.closed_at) return undefined;

  const closedAt = new Date(issue.closed_at).getTime();
  if (Date.now() - closedAt < REOPEN_WINDOW_MS) {
    return issue;
  }

  return undefined;
}

export async function healthCheck(
  config: Config
): Promise<{ success: boolean; summary?: string }> {
  let serverUp = false;

  try {
    const healthUrl = config.wikiServerUrl.replace(/\/$/, "") + "/health";
    const response = await fetch(healthUrl, {
      signal: AbortSignal.timeout(10_000),
    });
    serverUp = response.ok;
  } catch {
    serverUp = false;
  }

  const octokit = getOctokit(config);
  const { owner, repo } = parseRepo(config);
  const existingIssue = await findOpenHealthIssue(config);

  if (serverUp) {
    // Recovery path: if there was an active outage, backfill the incident
    // and flush any buffered incidents now that the server is reachable.
    const outage = getCurrentOutage();
    if (outage) {
      await backfillOutageIncident(config, outage);
      clearOutage();
      logger.info("Outage window closed — backfill incident recorded");
    }

    // Flush any incidents that were buffered while the server was down
    const flushed = await flushBuffer(config);
    if (flushed > 0) {
      logger.info({ flushed }, "Flushed buffered incidents on recovery");
    }

    // Server is up — close any existing issue
    if (existingIssue) {
      await octokit.rest.issues.update({
        owner,
        repo,
        issue_number: existingIssue.number,
        state: "closed",
        state_reason: "completed",
      });
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: existingIssue.number,
        body: `Wiki server is back up at ${new Date().toISOString()}.`,
      });
      return {
        success: true,
        summary: `Server up, closed issue #${existingIssue.number}`,
      };
    }
    return { success: true, summary: "Server up" };
  }

  // Server is down — track the failure for outage window detection
  recordFailure();

  // Try to record incident to wiki-server; if it fails (expected when the
  // wiki-server itself is down), buffer it locally for later flushing.
  const incidentPayload = {
    service: "wiki-server",
    severity: "critical",
    title: "Wiki server health check failure",
    detail: `Server at ${config.wikiServerUrl} is not responding to /health endpoint`,
    checkSource: "groundskeeper",
  };

  const recorded = await recordIncident(config, incidentPayload);
  if (!recorded) {
    addToBuffer({
      ...incidentPayload,
      timestamp: new Date().toISOString(),
    });
    logger.info("Incident buffered locally (wiki-server unreachable)");
  }

  // Add comment to existing open issue instead of creating duplicates
  if (existingIssue) {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: existingIssue.number,
      body: `⚠️ Server still down at ${new Date().toISOString()}.`,
    });
    return {
      success: false,
      summary: `Server down, updated issue #${existingIssue.number}`,
    };
  }

  // No open issue — check if one was closed recently (server flapping)
  const recentlyClosed = await findRecentlyClosedHealthIssue(config);
  if (recentlyClosed) {
    await octokit.rest.issues.update({
      owner,
      repo,
      issue_number: recentlyClosed.number,
      state: "open",
    });
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: recentlyClosed.number,
      body: `⚠️ Server is down again at ${new Date().toISOString()}. Reopening — last recovery was less than 30 minutes ago.`,
    });
    return {
      success: false,
      summary: `Server down, reopened issue #${recentlyClosed.number}`,
    };
  }

  // No open or recently-closed issue — create a new one
  const { data: newIssue } = await octokit.rest.issues.create({
    owner,
    repo,
    title: ISSUE_TITLE,
    body: `The wiki server at \`${config.wikiServerUrl}\` is not responding.\n\nDetected at: ${new Date().toISOString()}\n\nThis issue will be closed automatically when the server recovers.`,
    labels: ["groundskeeper"],
  });

  return {
    success: false,
    summary: `Server down, created issue #${newIssue.number}`,
  };
}
