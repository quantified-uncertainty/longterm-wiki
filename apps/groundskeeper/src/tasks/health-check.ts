import type { Config } from "../config.js";
import { getOctokit, parseRepo } from "../github.js";

const ISSUE_TITLE = "[Groundskeeper] Wiki server health check failure";

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
        body: `✅ Wiki server is back up at ${new Date().toISOString()}.`,
      });
      return {
        success: true,
        summary: `Server up, closed issue #${existingIssue.number}`,
      };
    }
    return { success: true, summary: "Server up" };
  }

  // Server is down
  if (existingIssue) {
    return {
      success: false,
      summary: `Server down, tracked in issue #${existingIssue.number}`,
    };
  }

  // Create a new issue
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
