/**
 * Job Failure Triage Task
 *
 * Periodically checks for recurring job failure patterns and files GitHub
 * issues for patterns that don't already have open issues. This ensures
 * persistent failures are surfaced to developers rather than silently
 * accumulating in the jobs table.
 *
 * Flow:
 *   1. Fetch /api/jobs/failure-patterns (recurring failures in the last 24h)
 *   2. For each pattern with count >= threshold:
 *      a. Search for an existing open GitHub issue matching the pattern
 *      b. If no match, file a new issue with type, error, counts, sample IDs
 *   3. Log results and return summary
 */

import type { Config } from "../config.js";
import { getOctokit, parseRepo } from "../github.js";
import { apiRequest } from "../wiki-server.js";
import { logger as rootLogger } from "../logger.js";

const logger = rootLogger.child({ task: "job-failure-triage" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FailurePattern {
  type: string;
  errorPattern: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  sampleJobIds: number[];
}

interface FailurePatternsResponse {
  patterns: FailurePattern[];
  hours: number;
  minCount: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Label applied to all auto-filed job failure issues. */
const ISSUE_LABEL = "job-failure";

/** Prefix for issue titles to make them searchable. */
const ISSUE_TITLE_PREFIX = "[Job Failure]";

/** Maximum number of issues to file per run to avoid flooding. */
const MAX_ISSUES_PER_RUN = 3;

/** Comment cooldown: skip adding "still failing" comments if one was posted recently. */
const COMMENT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a canonical search key from a failure pattern.
 * Used both for the issue title and for searching existing issues.
 */
function issueTitle(pattern: FailurePattern): string {
  // Truncate error to keep titles readable
  const errorSnippet = pattern.errorPattern.length > 60
    ? pattern.errorPattern.slice(0, 57) + "..."
    : pattern.errorPattern;
  return `${ISSUE_TITLE_PREFIX} ${pattern.type}: ${errorSnippet}`;
}

/**
 * Build the issue body with diagnostic information.
 */
function issueBody(pattern: FailurePattern): string {
  const sampleIds = pattern.sampleJobIds.length > 0
    ? pattern.sampleJobIds.join(", ")
    : "none available";

  return [
    `**Job type:** \`${pattern.type}\``,
    `**Error pattern:** \`${pattern.errorPattern}\``,
    `**Occurrences:** ${pattern.count} in the last 24 hours`,
    `**First seen:** ${pattern.firstSeen}`,
    `**Last seen:** ${pattern.lastSeen}`,
    `**Sample job IDs:** ${sampleIds}`,
    "",
    "This issue was automatically filed by the groundskeeper job-failure-triage task.",
    "It will be updated with comments if the pattern persists.",
    "",
    "---",
    "",
    "### Investigation steps",
    "",
    "1. Check the sample job IDs above via the wiki-server API or jobs dashboard",
    `2. Look at the \`${pattern.type}\` handler in \`crux/lib/job-handlers/\``,
    "3. Fix the root cause and close this issue",
  ].join("\n");
}

/**
 * Search for an open issue that matches this failure pattern.
 * Returns the issue number if found, undefined otherwise.
 */
async function findMatchingIssue(
  config: Config,
  pattern: FailurePattern
): Promise<{ number: number; hasRecentComment: boolean } | undefined> {
  const octokit = getOctokit(config);
  const { owner, repo } = parseRepo(config);

  // Search by the job type and the ISSUE_TITLE_PREFIX in title
  const searchQuery = `repo:${owner}/${repo} is:issue is:open in:title "${ISSUE_TITLE_PREFIX} ${pattern.type}"`;

  const { data } = await octokit.rest.search.issuesAndPullRequests({
    q: searchQuery,
    per_page: 10,
  });

  // Find an issue whose title matches this specific error pattern.
  // We match on the job type prefix since the error snippet may be truncated
  // differently. Check if the error pattern appears in the issue body for
  // more precise matching.
  for (const issue of data.items) {
    // Must start with our prefix and contain the job type
    if (!issue.title.startsWith(`${ISSUE_TITLE_PREFIX} ${pattern.type}`)) {
      continue;
    }

    // Check for error pattern match in body (first 60 chars to handle truncation)
    const errorPrefix = pattern.errorPattern.slice(0, 60);
    if (issue.body?.includes(errorPrefix)) {
      // Check if there's a recent comment (within cooldown window)
      let hasRecentComment = false;
      try {
        const since = new Date(Date.now() - COMMENT_COOLDOWN_MS).toISOString();
        const { data: comments } = await octokit.rest.issues.listComments({
          owner,
          repo,
          issue_number: issue.number,
          since,
          per_page: 1,
        });
        hasRecentComment = comments.length > 0;
      } catch {
        // If comment check fails, allow commenting (fail-open)
        hasRecentComment = false;
      }

      return { number: issue.number, hasRecentComment };
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Main task
// ---------------------------------------------------------------------------

export async function jobFailureTriage(
  config: Config
): Promise<{ success: boolean; summary?: string }> {
  // 1. Fetch failure patterns from wiki-server
  const result = await apiRequest<FailurePatternsResponse>(
    config,
    "GET",
    "/api/jobs/failure-patterns?hours=24&minCount=3",
  );

  if (!result.ok || !result.data) {
    logger.warn(
      { error: result.error },
      "Could not fetch failure patterns from wiki-server"
    );
    return {
      success: true, // Don't trip circuit breaker for API failures
      summary: "Could not reach wiki-server — skipped job failure triage",
    };
  }

  const { patterns } = result.data;

  if (patterns.length === 0) {
    return { success: true, summary: "No recurring failure patterns detected" };
  }

  logger.info(
    { patternCount: patterns.length },
    `Found ${patterns.length} recurring failure pattern(s)`
  );

  // 2. Process each pattern (up to MAX_ISSUES_PER_RUN new issues)
  let issuesCreated = 0;
  let issuesUpdated = 0;
  let issuesSkipped = 0;
  const errors: string[] = [];

  for (const pattern of patterns) {
    try {
      const existing = await findMatchingIssue(config, pattern);

      if (existing) {
        if (existing.hasRecentComment) {
          // Already has a recent update — skip
          issuesSkipped++;
          logger.debug(
            { type: pattern.type, issueNumber: existing.number },
            "Skipping — existing issue has recent comment"
          );
          continue;
        }

        // Post a "still failing" comment
        const octokit = getOctokit(config);
        const { owner, repo } = parseRepo(config);

        try {
          await octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number: existing.number,
            body: [
              `**Still failing** as of ${new Date().toISOString()}`,
              "",
              `- Occurrences in last 24h: **${pattern.count}**`,
              `- Last seen: ${pattern.lastSeen}`,
              `- Sample job IDs: ${pattern.sampleJobIds.join(", ") || "none"}`,
            ].join("\n"),
          });
          issuesUpdated++;
          logger.info(
            { type: pattern.type, issueNumber: existing.number, count: pattern.count },
            `Updated existing issue #${existing.number}`
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(
            { error: msg, issueNumber: existing.number },
            "Failed to post comment on existing issue"
          );
        }
        continue;
      }

      // No existing issue — create one (respecting per-run cap)
      if (issuesCreated >= MAX_ISSUES_PER_RUN) {
        issuesSkipped++;
        logger.info(
          { type: pattern.type },
          "Skipping — max issues per run reached"
        );
        continue;
      }

      const octokit = getOctokit(config);
      const { owner, repo } = parseRepo(config);

      // Ensure the label exists (create if missing)
      try {
        await octokit.rest.issues.getLabel({ owner, repo, name: ISSUE_LABEL });
      } catch {
        try {
          await octokit.rest.issues.createLabel({
            owner,
            repo,
            name: ISSUE_LABEL,
            color: "d93f0b", // red
            description: "Recurring job failure detected by groundskeeper",
          });
        } catch (labelErr) {
          // Label creation may fail due to race conditions — not fatal
          logger.debug(
            { error: labelErr instanceof Error ? labelErr.message : String(labelErr) },
            "Label creation failed (may already exist)"
          );
        }
      }

      const { data: newIssue } = await octokit.rest.issues.create({
        owner,
        repo,
        title: issueTitle(pattern),
        body: issueBody(pattern),
        labels: [ISSUE_LABEL, "groundskeeper"],
      });

      issuesCreated++;
      logger.info(
        { type: pattern.type, issueNumber: newIssue.number, count: pattern.count },
        `Created issue #${newIssue.number} for ${pattern.type} failures`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${pattern.type}: ${msg}`);
      logger.error(
        { error: msg, type: pattern.type },
        `Failed to process failure pattern for ${pattern.type}`
      );
    }
  }

  // 3. Build summary
  const parts: string[] = [];
  parts.push(`${patterns.length} pattern(s) found`);
  if (issuesCreated > 0) parts.push(`${issuesCreated} issue(s) created`);
  if (issuesUpdated > 0) parts.push(`${issuesUpdated} issue(s) updated`);
  if (issuesSkipped > 0) parts.push(`${issuesSkipped} skipped`);
  if (errors.length > 0) parts.push(`${errors.length} error(s)`);

  const summary = parts.join(", ");

  if (errors.length > 0) {
    logger.warn({ errors }, `Job failure triage completed with errors: ${summary}`);
    return { success: false, summary };
  }

  return { success: true, summary };
}
