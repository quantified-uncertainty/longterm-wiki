import type { Config } from "../config.js";
import { getOctokit, parseRepo } from "../github.js";
import { logger as rootLogger } from "../logger.js";

const logger = rootLogger.child({ task: "session-sweep" });

/** Timeout hours for stale session detection (sessions not updated in this long are swept). */
const STALE_TIMEOUT_HOURS = 4;

interface SweptSession {
  id: number;
  branch: string;
  issueNumber: number | null;
}

interface SweepResponse {
  swept: number;
  sessions: SweptSession[];
}

/**
 * Call the wiki-server sweep endpoint to mark stale active sessions as completed.
 * Returns the list of swept sessions (with issue numbers), or null on failure.
 */
async function callSweepEndpoint(
  config: Config,
  timeoutHours: number,
): Promise<SweepResponse | null> {
  const url = `${config.wikiServerUrl}/api/agent-sessions/sweep`;
  // Use project-scoped key (preferred) or legacy superkey (fallback).
  // The /api/agent-sessions/* routes require `project` scope.
  const apiKey =
    process.env["LONGTERMWIKI_PROJECT_KEY"] ??
    process.env["LONGTERMWIKI_SERVER_API_KEY"];

  if (!apiKey) {
    logger.warn(
      "Neither LONGTERMWIKI_PROJECT_KEY nor LONGTERMWIKI_SERVER_API_KEY is set — skipping sweep",
    );
    return null;
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ timeoutHours }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.error({ status: res.status, body: text.slice(0, 200) }, "Sweep endpoint failed");
      return null;
    }

    return (await res.json()) as SweepResponse;
  } catch (err) {
    logger.error(
      { error: err instanceof Error ? err.message : String(err) },
      "Sweep request failed",
    );
    return null;
  }
}

/**
 * Remove the claude-working label from a GitHub issue if it has that label.
 * Returns true if the label was removed (or wasn't present), false on error.
 */
async function removeClaudeWorkingLabel(
  config: Config,
  issueNumber: number,
): Promise<boolean> {
  const octokit = getOctokit(config);
  const { owner, repo } = parseRepo(config);

  try {
    // Check if the issue is closed and has the label
    const { data: issue } = await octokit.rest.issues.get({
      owner,
      repo,
      issue_number: issueNumber,
    });

    if (issue.state !== "closed") {
      logger.info({ issueNumber }, "Issue is still open, skipping label removal");
      return true;
    }

    const hasLabel = issue.labels.some(
      (label) => (typeof label === "string" ? label : label.name) === "claude-working",
    );

    if (!hasLabel) {
      logger.info({ issueNumber }, "Issue has no claude-working label, nothing to remove");
      return true;
    }

    await octokit.rest.issues.removeLabel({
      owner,
      repo,
      issue_number: issueNumber,
      name: "claude-working",
    });

    logger.info({ issueNumber }, "Removed claude-working label from closed issue");
    return true;
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err), issueNumber },
      "Failed to remove claude-working label",
    );
    return false;
  }
}

/**
 * Session sweep task:
 * 1. Marks stale active sessions (>STALE_TIMEOUT_HOURS old) as completed via wiki-server.
 * 2. For each swept session with a linked GitHub issue, removes the claude-working label
 *    if the issue is closed.
 *
 * Runs every 4 hours. Idempotent — safe to run multiple times.
 */
export async function sessionSweep(
  config: Config,
): Promise<{ success: boolean; summary?: string }> {
  // Step 1: Sweep stale sessions
  const sweepResult = await callSweepEndpoint(config, STALE_TIMEOUT_HOURS);

  if (!sweepResult) {
    return { success: false, summary: "Sweep endpoint call failed" };
  }

  logger.info({ swept: sweepResult.swept }, "Swept stale sessions");

  if (sweepResult.swept === 0) {
    return { success: true, summary: "No stale sessions to sweep" };
  }

  // Step 2: Remove claude-working label from closed issues linked to swept sessions
  const issueNumbers = sweepResult.sessions
    .map((s) => s.issueNumber)
    .filter((n): n is number => n !== null && n > 0);

  const uniqueIssueNumbers = [...new Set(issueNumbers)];

  if (uniqueIssueNumbers.length === 0) {
    return {
      success: true,
      summary: `Swept ${sweepResult.swept} stale session(s), no linked issues`,
    };
  }

  let labelsRemoved = 0;
  let labelErrors = 0;

  for (const issueNumber of uniqueIssueNumbers) {
    const ok = await removeClaudeWorkingLabel(config, issueNumber);
    if (ok) {
      labelsRemoved++;
    } else {
      labelErrors++;
    }
  }

  const summary = `Swept ${sweepResult.swept} stale session(s); claude-working label cleaned up for ${labelsRemoved}/${uniqueIssueNumbers.length} issue(s)${labelErrors > 0 ? ` (${labelErrors} error(s))` : ""}`;

  return {
    success: labelErrors === 0,
    summary,
  };
}
