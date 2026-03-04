import type { Config } from "../config.js";
import { getOctokit, parseRepo } from "../github.js";
import { runClaude } from "../claude.js";
import { sendDiscordNotification } from "../notify.js";
import { logger as rootLogger } from "../logger.js";
import { sleep } from "../sleep.js";

/**
 * Issue Responder — polls GitHub for issues/PRs labeled `groundskeeper-autofix`
 * (or with a `/groundskeeper` comment) and spawns Claude Code to work on them.
 *
 * Triggering:
 * - Label an issue or PR with `groundskeeper-autofix`
 * - Or post a comment starting with `/groundskeeper` on any issue or PR
 *
 * For issues: creates a new branch, fixes, opens a PR
 * For PRs: checks out the existing branch, reads review comments, pushes fixes
 *
 * Safety:
 * - Only processes one item per poll cycle to stay within AI budget
 * - Respects the daily run cap (checked inside runClaude)
 * - Does NOT close issues or merge PRs — leaves that to humans
 * - Uses optimistic claim-then-verify to prevent race conditions
 */

const TRIGGER_LABEL = "groundskeeper-autofix";
const WORKING_LABEL = "claude-working";
const COMMENT_TRIGGER = "/groundskeeper";

/** Machine-parseable markers for comment detection (not user-facing text). */
const CLAIM_MARKER = "<!-- groundskeeper-claim -->";
const RESPONSE_MARKER = "<!-- groundskeeper-response -->";

/** Delay between sequential GitHub API calls to avoid rate limits. */
const API_CALL_DELAY_MS = 250;

/** Max retries for label removal. */
const LABEL_REMOVE_MAX_RETRIES = 3;
/** Base delay for exponential backoff on label removal retries. */
const LABEL_REMOVE_BASE_DELAY_MS = 1000;

const logger = rootLogger.child({ task: "issue-responder" });

interface WorkItem {
  number: number;
  title: string;
  body: string | null;
  isPR: boolean;
  /** For PRs: the head branch to check out */
  branch?: string;
  /** For comment-triggered work: the comment body with instructions */
  triggerComment?: string;
}

async function ensureLabelExists(
  config: Config,
  labelName: string,
  color: string,
  description: string
): Promise<void> {
  const octokit = getOctokit(config);
  const { owner, repo } = parseRepo(config);
  try {
    await octokit.rest.issues.getLabel({ owner, repo, name: labelName });
  } catch {
    await octokit.rest.issues.createLabel({
      owner,
      repo,
      name: labelName,
      color,
      description,
    });
  }
}

function hasLabel(
  labels: (string | { name?: string })[],
  name: string
): boolean {
  return labels.some(
    (label) => (typeof label === "string" ? label : label.name) === name
  );
}

/** Find issues/PRs with the trigger label that aren't already being worked on. */
async function findLabeledItems(config: Config): Promise<WorkItem[]> {
  const octokit = getOctokit(config);
  const { owner, repo } = parseRepo(config);

  const { data } = await octokit.rest.issues.listForRepo({
    owner,
    repo,
    labels: TRIGGER_LABEL,
    state: "open",
    sort: "created",
    direction: "asc",
    per_page: 10,
  });

  const items: WorkItem[] = [];
  for (const issue of data) {
    if (hasLabel(issue.labels, WORKING_LABEL)) continue;

    const isPR = !!issue.pull_request;
    let branch: string | undefined;

    if (isPR) {
      await sleep(API_CALL_DELAY_MS);
      const { data: pr } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: issue.number,
      });
      branch = pr.head.ref;
    }

    items.push({
      number: issue.number,
      title: issue.title,
      body: issue.body ?? null,
      isPR,
      branch,
    });
  }

  return items;
}

/** Find issues/PRs with a recent `/groundskeeper` comment that haven't been acted on. */
async function findCommentTriggeredItems(
  config: Config
): Promise<WorkItem[]> {
  const octokit = getOctokit(config);
  const { owner, repo } = parseRepo(config);

  // Search for recent comments containing the trigger phrase
  // Look back 30 minutes to avoid re-processing old comments
  const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  const { data: comments } = await octokit.rest.issues.listCommentsForRepo({
    owner,
    repo,
    since,
    sort: "created",
    direction: "desc",
    per_page: 20,
  });

  const triggerComments = comments.filter(
    (c) =>
      c.body?.startsWith(COMMENT_TRIGGER) &&
      !c.user?.login?.includes("[bot]") &&
      c.user?.type !== "Bot"
  );

  if (triggerComments.length === 0) return [];

  // Deduplicate by issue number, keeping the newest comment
  const seen = new Set<number>();
  const items: WorkItem[] = [];

  for (const comment of triggerComments) {
    const issueUrl = comment.issue_url;
    const issueNumber = parseInt(issueUrl.split("/").pop()!, 10);
    if (seen.has(issueNumber)) continue;
    seen.add(issueNumber);

    await sleep(API_CALL_DELAY_MS);

    // Check the issue isn't already being worked on
    const { data: issue } = await octokit.rest.issues.get({
      owner,
      repo,
      issue_number: issueNumber,
    });

    if (issue.state !== "open") continue;
    if (hasLabel(issue.labels, WORKING_LABEL)) continue;

    // Check we haven't already responded to this comment
    // Uses machine-parseable marker to avoid false positives from user comments
    await sleep(API_CALL_DELAY_MS);
    const { data: issueComments } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
      since: comment.created_at,
      per_page: 10,
    });
    const alreadyResponded = issueComments.some(
      (c) =>
        c.body?.includes(RESPONSE_MARKER) &&
        c.id !== comment.id &&
        new Date(c.created_at) > new Date(comment.created_at)
    );
    if (alreadyResponded) continue;

    const isPR = !!issue.pull_request;
    let branch: string | undefined;

    if (isPR) {
      await sleep(API_CALL_DELAY_MS);
      const { data: pr } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: issueNumber,
      });
      branch = pr.head.ref;
    }

    items.push({
      number: issueNumber,
      title: issue.title,
      body: issue.body ?? null,
      isPR,
      branch,
      triggerComment: comment.body ?? undefined,
    });
  }

  return items;
}

async function hasLinkedClaudePR(
  config: Config,
  issueNumber: number
): Promise<boolean> {
  const octokit = getOctokit(config);
  const { owner, repo } = parseRepo(config);

  const { data: prs } = await octokit.rest.pulls.list({
    owner,
    repo,
    state: "open",
    per_page: 50,
  });

  return prs.some(
    (pr) =>
      pr.head.ref.startsWith("claude/") &&
      pr.body?.includes(`#${issueNumber}`)
  );
}

/**
 * Claim an issue by adding the working label and posting a claim comment.
 * After claiming, verifies no other instance claimed concurrently.
 *
 * Returns `true` if claim succeeded, `false` if another instance won the race.
 */
async function claimItem(
  config: Config,
  item: WorkItem
): Promise<boolean> {
  const octokit = getOctokit(config);
  const { owner, repo } = parseRepo(config);
  const itemType = item.isPR ? "PR" : "issue";

  // Step 1: Add the working label immediately (atomic GitHub operation)
  await octokit.rest.issues.addLabels({
    owner,
    repo,
    issue_number: item.number,
    labels: [WORKING_LABEL],
  });

  // Step 2: Post claim comment with machine-parseable marker
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: item.number,
    body: `${CLAIM_MARKER}\n🤖 **Groundskeeper** is picking up this ${itemType}. Starting Claude Code session...`,
  });

  // Step 3: Verify no concurrent claim by checking for other claim comments
  // A small delay to let any concurrent writes settle
  await sleep(API_CALL_DELAY_MS);

  const { data: recentComments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: item.number,
    per_page: 10,
  });

  // Look for claim markers — if there are multiple, another instance raced us
  const claimComments = recentComments.filter((c) =>
    c.body?.includes(CLAIM_MARKER)
  );

  if (claimComments.length > 1) {
    // Multiple claims detected — the earliest comment wins
    const sorted = claimComments.sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
    const ourClaim = claimComments[claimComments.length - 1]; // We posted last (most likely)
    const winner = sorted[0];

    if (winner.id !== ourClaim.id) {
      // We lost the race — back off
      logger.warn(
        { issueNumber: item.number, claimCount: claimComments.length },
        "Race condition detected: another instance claimed this item first"
      );

      // Remove our label claim (best effort)
      await removeLabelWithRetry(config, item.number);

      return false;
    }
  }

  return true;
}

/**
 * Remove the working label with exponential backoff retry.
 * Prevents orphaned labels when the API call fails transiently.
 */
async function removeLabelWithRetry(
  config: Config,
  issueNumber: number,
  labelName: string = WORKING_LABEL
): Promise<void> {
  const octokit = getOctokit(config);
  const { owner, repo } = parseRepo(config);

  for (let attempt = 0; attempt < LABEL_REMOVE_MAX_RETRIES; attempt++) {
    try {
      await octokit.rest.issues.removeLabel({
        owner,
        repo,
        issue_number: issueNumber,
        name: labelName,
      });
      return; // Success
    } catch (error) {
      const isLastAttempt = attempt === LABEL_REMOVE_MAX_RETRIES - 1;
      if (isLastAttempt) {
        logger.error(
          { issueNumber, labelName, attempt, error },
          `Failed to remove label "${labelName}" after all retries — label may be orphaned`
        );
        return; // Give up, but don't throw
      }

      const delayMs = LABEL_REMOVE_BASE_DELAY_MS * Math.pow(2, attempt);
      logger.warn(
        { issueNumber, labelName, attempt, delayMs, error },
        `Failed to remove label "${labelName}", retrying...`
      );
      await sleep(delayMs);
    }
  }
}

/** Fetch review comments on a PR to include as context. */
async function getPRReviewContext(
  config: Config,
  prNumber: number
): Promise<string> {
  const octokit = getOctokit(config);
  const { owner, repo } = parseRepo(config);

  const [{ data: reviews }, { data: reviewComments }] = await Promise.all([
    octokit.rest.pulls.listReviews({ owner, repo, pull_number: prNumber, per_page: 20 }),
    octokit.rest.pulls.listReviewComments({ owner, repo, pull_number: prNumber, per_page: 30 }),
  ]);

  const parts: string[] = [];

  const changeRequests = reviews.filter((r) => r.state === "CHANGES_REQUESTED" || r.body);
  if (changeRequests.length > 0) {
    parts.push("### Review feedback");
    for (const review of changeRequests) {
      if (review.body) {
        parts.push(`**${review.user?.login ?? "reviewer"}** (${review.state}):\n${review.body}`);
      }
    }
  }

  if (reviewComments.length > 0) {
    parts.push("### Inline review comments");
    for (const c of reviewComments.slice(-15)) {
      const file = c.path;
      const line = c.line ?? c.original_line ?? "?";
      parts.push(`**${c.user?.login ?? "reviewer"}** on \`${file}:${line}\`:\n${c.body}`);
    }
  }

  return parts.join("\n\n");
}

export async function issueResponder(
  config: Config
): Promise<{ success: boolean; summary?: string }> {
  await ensureLabelExists(
    config,
    TRIGGER_LABEL,
    "0e8a16",
    "Groundskeeper will auto-fix this issue"
  );

  // Gather work items from both label and comment triggers
  const [labeledItems, commentItems] = await Promise.all([
    findLabeledItems(config),
    findCommentTriggeredItems(config),
  ]);

  // Merge, deduplicating by number (label takes priority)
  const seen = new Set(labeledItems.map((i) => i.number));
  const allItems = [
    ...labeledItems,
    ...commentItems.filter((i) => !seen.has(i.number)),
  ];

  if (allItems.length === 0) {
    return { success: true, summary: "No issues to process" };
  }

  // Process only one item per cycle
  const item = allItems[0];

  // For issues (not PRs), skip if there's already a claude/ PR
  if (!item.isPR && (await hasLinkedClaudePR(config, item.number))) {
    return {
      success: true,
      summary: `Issue #${item.number} already has a linked PR, skipping`,
    };
  }

  // Claim the item with race-condition protection
  const claimed = await claimItem(config, item);
  if (!claimed) {
    return {
      success: true,
      summary: `Issue #${item.number} claimed by another instance, skipping`,
    };
  }

  const octokit = getOctokit(config);
  const { owner, repo } = parseRepo(config);
  const itemType = item.isPR ? "PR" : "issue";

  await sendDiscordNotification(
    config,
    `🔧 **Issue Responder** — working on ${itemType} #${item.number}: ${item.title}`
  );

  // Build the prompt
  let prompt: string;
  if (item.isPR) {
    const reviewContext = await getPRReviewContext(config, item.number);
    prompt = buildPRPrompt(owner, repo, item, reviewContext);
  } else {
    prompt = buildIssuePrompt(owner, repo, item);
  }

  const result = await runClaude(config, {
    prompt,
    timeoutMs: 600_000, // 10 minutes
    maxTurns: 30,
  });

  // Remove both the working label and the trigger label to prevent re-processing loops.
  // The trigger label is removed regardless of success/failure — on failure, the human
  // can re-add it to retry. Without this, the issue gets picked up every poll cycle.
  await removeLabelWithRetry(config, item.number);
  await removeLabelWithRetry(config, item.number, TRIGGER_LABEL);

  if (result.success) {
    const outputPreview =
      result.output.length > 3000
        ? result.output.slice(0, 3000) + "\n\n... (truncated)"
        : result.output;

    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: item.number,
      body: `${RESPONSE_MARKER}\n✅ **Groundskeeper** finished working on this ${itemType} (${Math.round(result.durationMs / 1000)}s).\n\n<details>\n<summary>Claude Code output</summary>\n\n\`\`\`\n${outputPreview}\n\`\`\`\n\n</details>`,
    });

    await sendDiscordNotification(
      config,
      `✅ **Issue Responder** — finished ${itemType} #${item.number} in ${Math.round(result.durationMs / 1000)}s`
    );

    return {
      success: true,
      summary: `Processed ${itemType} #${item.number}: ${item.title}`,
    };
  } else {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: item.number,
      body: `${RESPONSE_MARKER}\n❌ **Groundskeeper** could not resolve this ${itemType} automatically.\n\nError: ${result.output.slice(0, 1000)}`,
    });

    await sendDiscordNotification(
      config,
      `❌ **Issue Responder** — failed on ${itemType} #${item.number}: ${result.output.slice(0, 200)}`
    );

    return {
      success: false,
      summary: `Failed on ${itemType} #${item.number}: ${result.output.slice(0, 200)}`,
    };
  }
}

function buildIssuePrompt(
  owner: string,
  repo: string,
  item: WorkItem
): string {
  const extra = item.triggerComment
    ? `\n\n## Trigger comment\n\nA user posted this comment requesting your help:\n\n> ${item.triggerComment}\n`
    : "";

  return `You are the Groundskeeper agent for the ${owner}/${repo} repository.

A GitHub issue has been assigned to you for automatic resolution.

## Issue #${item.number}: ${item.title}

${item.body ?? "(no description)"}${extra}

## Instructions

1. Read the issue carefully and understand what needs to be fixed
2. Search the codebase to find the relevant files
3. Make the necessary changes
4. Run tests to verify your changes don't break anything: \`pnpm test\`
5. Create a new branch: \`git checkout -b claude/fix-issue-${item.number}\`
6. Commit your changes with a descriptive message that includes "Closes #${item.number}"
7. Push the branch: \`git push -u origin claude/fix-issue-${item.number}\`
8. Create a PR using: \`gh pr create --title "Fix: ${item.title.replace(/"/g, '\\"')}" --body "Closes #${item.number}"\`

## Safety rules

- Do NOT force-push or modify the main branch
- Do NOT skip tests or pre-commit hooks
- If the issue is unclear or too complex, leave a comment explaining why and stop
- Keep changes minimal and focused on the issue`;
}

function buildPRPrompt(
  owner: string,
  repo: string,
  item: WorkItem,
  reviewContext: string
): string {
  const extra = item.triggerComment
    ? `\n\n## Trigger comment\n\nA user posted this comment requesting your help:\n\n> ${item.triggerComment}\n`
    : "";

  return `You are the Groundskeeper agent for the ${owner}/${repo} repository.

A pull request has been tagged for you to fix.

## PR #${item.number}: ${item.title}

${item.body ?? "(no description)"}${extra}

${reviewContext || "(no review comments)"}

## Instructions

1. Check out the PR branch: \`git fetch origin ${item.branch} && git checkout ${item.branch}\`
2. Read the PR description and review comments above to understand what needs fixing
3. If there are review comments requesting changes, address them
4. If CI is failing, investigate and fix the failures
5. Run tests: \`pnpm test\`
6. Commit your fixes with a clear message
7. Push to the same branch: \`git push origin ${item.branch}\`

## Safety rules

- Do NOT force-push — use regular push only
- Do NOT skip tests or pre-commit hooks
- Do NOT modify the main branch
- If the requested changes are unclear or too complex, leave a comment explaining why and stop
- Keep changes minimal and focused on what was requested`;
}
