import type { Config } from "../config.js";
import { getOctokit, parseRepo } from "../github.js";
import { runClaude } from "../claude.js";
import { sendDiscordNotification } from "../notify.js";

/**
 * Issue Responder — polls GitHub for issues labeled `groundskeeper-autofix`
 * and spawns Claude Code to work on them.
 *
 * Flow:
 * 1. Find open issues with the `groundskeeper-autofix` label
 * 2. Skip issues that already have `claude-working` label (another agent is on it)
 * 3. Skip issues that already have a linked PR from a `claude/` branch
 * 4. Add `claude-working` label + comment to claim the issue
 * 5. Spawn Claude Code with the issue context
 * 6. Comment with the result (success or failure)
 * 7. Remove `claude-working` label when done
 *
 * Safety:
 * - Only processes one issue per poll cycle to stay within AI budget
 * - Respects the daily run cap (checked inside runClaude)
 * - Does NOT close issues — leaves that to the PR/human review
 */

const TRIGGER_LABEL = "groundskeeper-autofix";
const WORKING_LABEL = "claude-working";

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

async function findClaimableIssues(config: Config) {
  const octokit = getOctokit(config);
  const { owner, repo } = parseRepo(config);

  const { data } = await octokit.rest.issues.listForRepo({
    owner,
    repo,
    labels: TRIGGER_LABEL,
    state: "open",
    sort: "created",
    direction: "asc", // oldest first
    per_page: 10,
  });

  // Filter out issues that are already being worked on
  return data.filter(
    (issue) =>
      !issue.labels.some(
        (label) =>
          (typeof label === "string" ? label : label.name) === WORKING_LABEL
      )
  );
}

async function hasLinkedClaudePR(
  config: Config,
  issueNumber: number
): Promise<boolean> {
  const octokit = getOctokit(config);
  const { owner, repo } = parseRepo(config);

  // Check for PRs that reference this issue
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

export async function issueResponder(
  config: Config
): Promise<{ success: boolean; summary?: string }> {
  await ensureLabelExists(
    config,
    TRIGGER_LABEL,
    "0e8a16",
    "Groundskeeper will auto-fix this issue"
  );

  const claimable = await findClaimableIssues(config);

  if (claimable.length === 0) {
    return { success: true, summary: "No issues to process" };
  }

  // Process only the oldest claimable issue per cycle
  const issue = claimable[0];
  const issueNumber = issue.number;

  // Double-check: skip if there's already a claude/ PR for this issue
  if (await hasLinkedClaudePR(config, issueNumber)) {
    return {
      success: true,
      summary: `Issue #${issueNumber} already has a linked PR, skipping`,
    };
  }

  const octokit = getOctokit(config);
  const { owner, repo } = parseRepo(config);

  // Claim the issue
  await octokit.rest.issues.addLabels({
    owner,
    repo,
    issue_number: issueNumber,
    labels: [WORKING_LABEL],
  });

  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body: `🤖 **Groundskeeper** is picking up this issue. Starting Claude Code session...`,
  });

  await sendDiscordNotification(
    config,
    `🔧 **Issue Responder** — working on #${issueNumber}: ${issue.title}`
  );

  // Build the prompt for Claude Code
  const prompt = buildPrompt(owner, repo, issueNumber, issue.title, issue.body ?? null);

  const result = await runClaude(config, {
    prompt,
    timeoutMs: 600_000, // 10 minutes
    maxTurns: 30,
  });

  // Remove the working label regardless of outcome
  try {
    await octokit.rest.issues.removeLabel({
      owner,
      repo,
      issue_number: issueNumber,
      name: WORKING_LABEL,
    });
  } catch {
    // Label may already be removed
  }

  if (result.success) {
    // Truncate output for the comment
    const outputPreview =
      result.output.length > 3000
        ? result.output.slice(0, 3000) + "\n\n... (truncated)"
        : result.output;

    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body: `✅ **Groundskeeper** finished working on this issue (${Math.round(result.durationMs / 1000)}s).\n\n<details>\n<summary>Claude Code output</summary>\n\n\`\`\`\n${outputPreview}\n\`\`\`\n\n</details>`,
    });

    await sendDiscordNotification(
      config,
      `✅ **Issue Responder** — finished #${issueNumber} in ${Math.round(result.durationMs / 1000)}s`
    );

    return {
      success: true,
      summary: `Processed issue #${issueNumber}: ${issue.title}`,
    };
  } else {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body: `❌ **Groundskeeper** could not resolve this issue automatically.\n\nError: ${result.output.slice(0, 1000)}`,
    });

    await sendDiscordNotification(
      config,
      `❌ **Issue Responder** — failed on #${issueNumber}: ${result.output.slice(0, 200)}`
    );

    return {
      success: false,
      summary: `Failed on issue #${issueNumber}: ${result.output.slice(0, 200)}`,
    };
  }
}

function buildPrompt(
  owner: string,
  repo: string,
  issueNumber: number,
  title: string,
  body: string | null
): string {
  return `You are the Groundskeeper agent for the ${owner}/${repo} repository.

A GitHub issue has been assigned to you for automatic resolution.

## Issue #${issueNumber}: ${title}

${body ?? "(no description)"}

## Instructions

1. Read the issue carefully and understand what needs to be fixed
2. Search the codebase to find the relevant files
3. Make the necessary changes
4. Run tests to verify your changes don't break anything: \`pnpm test\`
5. Create a new branch: \`git checkout -b claude/fix-issue-${issueNumber}\`
6. Commit your changes with a descriptive message that includes "Closes #${issueNumber}"
7. Push the branch: \`git push -u origin claude/fix-issue-${issueNumber}\`
8. Create a PR using: \`gh pr create --title "Fix: ${title.replace(/"/g, '\\"')}" --body "Closes #${issueNumber}"\`

## Safety rules

- Do NOT force-push or modify the main branch
- Do NOT skip tests or pre-commit hooks
- If the issue is unclear or too complex, leave a comment explaining why and stop
- Keep changes minimal and focused on the issue`;
}
