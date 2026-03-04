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

/** Minimum interval between "still down" comments on the same issue (ms). */
const COMMENT_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Number of consecutive health check failures required before creating an
 * issue or escalating. Filters out transient blips (e.g. slow DB responses
 * that exceed the timeout but recover on the next check cycle).
 */
const CONSECUTIVE_FAILURES_THRESHOLD = 3;

/** Tracks consecutive health check failures across invocations. */
let consecutiveFailures = 0;

/**
 * Simple in-memory lock to prevent parallel health check runs from both
 * creating a new issue when they simultaneously see "no open issue."
 */
let issueCreationInProgress = false;

/**
 * Search for an existing open health-check issue by title.
 * Returns the issue if found, or undefined.
 */
async function findOpenHealthIssue(config: Config) {
  const octokit = getOctokit(config);
  const { owner, repo } = parseRepo(config);

  const { data } = await octokit.rest.search.issuesAndPullRequests({
    q: `repo:${owner}/${repo} is:issue is:open in:title "${ISSUE_TITLE}"`,
    per_page: 5,
  });

  return data.items.find((issue) => issue.title === ISSUE_TITLE);
}

/**
 * Check whether any comment was posted on the issue within the cooldown window.
 *
 * Uses the `since` parameter to ask GitHub for only comments created after
 * the cooldown threshold. If any are returned, we're still in cooldown.
 *
 * NOTE: The GitHub Issues listComments API does NOT support `sort` or
 * `direction` parameters (those are silently ignored). Using `per_page: 1`
 * without them returns the OLDEST comment, not the newest. The `since`
 * approach avoids this pitfall entirely.
 */
async function hasRecentComment(
  config: Config,
  issueNumber: number
): Promise<boolean> {
  try {
    const octokit = getOctokit(config);
    const { owner, repo } = parseRepo(config);

    const since = new Date(Date.now() - COMMENT_COOLDOWN_MS).toISOString();

    const { data: comments } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
      since,
      per_page: 1,
    });

    return comments.length > 0;
  } catch (error) {
    logger.warn(
      { err: error, issueNumber },
      "Failed to check for recent comments"
    );
    // On failure, allow commenting (same as before — fail-open)
    return false;
  }
}

/**
 * Check whether enough time has elapsed since the last comment on an issue
 * to allow posting a new "still down" comment.
 */
async function shouldPostStillDownComment(
  config: Config,
  issueNumber: number
): Promise<boolean> {
  const recent = await hasRecentComment(config, issueNumber);

  if (recent) {
    logger.info(
      {
        issueNumber,
        cooldownMs: COMMENT_COOLDOWN_MS,
      },
      "Skipping 'still down' comment — recent comment exists within cooldown window"
    );
    return false;
  }

  // No recent comments (or failed to fetch) — allow commenting
  return true;
}

export async function healthCheck(
  config: Config
): Promise<{ success: boolean; summary?: string }> {
  let serverUp = false;

  try {
    // Use /healthz — lightweight endpoint with no DB queries, so timeouts
    // reflect actual server unreachability rather than slow DB responses.
    const healthUrl = config.wikiServerUrl.replace(/\/$/, "") + "/healthz";
    const response = await fetch(healthUrl, {
      signal: AbortSignal.timeout(10_000),
    });
    serverUp = response.ok;
  } catch {
    serverUp = false;
  }

  const octokit = getOctokit(config);
  const { owner, repo } = parseRepo(config);

  let existingIssue: Awaited<ReturnType<typeof findOpenHealthIssue>>;
  try {
    existingIssue = await findOpenHealthIssue(config);
  } catch (error) {
    logger.error({ err: error }, "Failed to search for existing health issue");
    return {
      success: serverUp,
      summary: serverUp
        ? "Server up, but failed to check for existing issue"
        : "Server down, but failed to check for existing issue",
    };
  }

  if (serverUp) {
    if (consecutiveFailures > 0) {
      logger.info(
        { previousFailures: consecutiveFailures },
        "Server recovered after consecutive failures"
      );
    }
    consecutiveFailures = 0;

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
      try {
        await octokit.rest.issues.update({
          owner,
          repo,
          issue_number: existingIssue.number,
          state: "closed",
          state_reason: "completed",
        });
      } catch (error) {
        logger.error(
          { err: error, issueNumber: existingIssue.number },
          "Failed to close health issue"
        );
      }

      try {
        await octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: existingIssue.number,
          body: `Server is back up at ${new Date().toISOString()}.`,
        });
      } catch (error) {
        logger.error(
          { err: error, issueNumber: existingIssue.number },
          "Failed to post recovery comment"
        );
      }

      return {
        success: true,
        summary: `Server up, closed issue #${existingIssue.number}`,
      };
    }
    return { success: true, summary: "Server up" };
  }

  // Server is down — track the failure for outage window detection
  consecutiveFailures++;
  recordFailure();

  // Don't escalate until we've seen enough consecutive failures to rule out
  // transient blips (e.g. a single slow response exceeding the timeout).
  if (consecutiveFailures < CONSECUTIVE_FAILURES_THRESHOLD) {
    logger.info(
      {
        consecutiveFailures,
        threshold: CONSECUTIVE_FAILURES_THRESHOLD,
      },
      "Health check failed but below threshold — not escalating yet"
    );
    return {
      success: false,
      summary: `Server down (${consecutiveFailures}/${CONSECUTIVE_FAILURES_THRESHOLD} failures, waiting before escalating)`,
    };
  }

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
    // Rate-limit "still down" comments: only post if >30 min since last comment
    const shouldComment = await shouldPostStillDownComment(
      config,
      existingIssue.number
    );

    if (shouldComment) {
      try {
        await octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: existingIssue.number,
          body: `Server is still down at ${new Date().toISOString()}. Checked \`${config.wikiServerUrl}/health\`.`,
        });
      } catch (error) {
        logger.error(
          { err: error, issueNumber: existingIssue.number },
          "Failed to post 'still down' comment"
        );
      }
    }

    return {
      success: false,
      summary: `Server down, tracked in issue #${existingIssue.number}${shouldComment ? " (comment posted)" : " (comment rate-limited)"}`,
    };
  }

  // Guard against parallel issue creation
  if (issueCreationInProgress) {
    logger.warn(
      "Issue creation already in progress — skipping to avoid duplicates"
    );
    return {
      success: false,
      summary: "Server down, issue creation in progress by another run",
    };
  }

  issueCreationInProgress = true;
  try {
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
  } catch (error) {
    logger.error({ err: error }, "Failed to create health check issue");
    return {
      success: false,
      summary: "Server down, failed to create issue",
    };
  } finally {
    issueCreationInProgress = false;
  }
}

// Exported for testing
export {
  COMMENT_COOLDOWN_MS,
  CONSECUTIVE_FAILURES_THRESHOLD,
  findOpenHealthIssue,
  hasRecentComment,
  shouldPostStillDownComment,
};

// Exported for testing — reset in-memory state
export function _resetIssueCreationLock(): void {
  issueCreationInProgress = false;
}

export function _resetConsecutiveFailures(): void {
  consecutiveFailures = 0;
}

export function _getConsecutiveFailures(): number {
  return consecutiveFailures;
}
