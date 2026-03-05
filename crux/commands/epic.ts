/**
 * Epic Command Handlers
 *
 * Manage multi-issue epics via GitHub Discussions. Epics are "living documents"
 * — a pinned Discussion body tracks the plan while comments form a timeline of
 * agent activity (claims, completions, blockers).
 *
 * GitHub Discussions are used instead of Issues for epics because:
 *   - Two-level threading naturally groups agent sessions
 *   - Discussion body is semantically a "document" (editable plan), not a ticket
 *   - Category-based separation (epics vs. Q&A vs. activity logs)
 *   - Up to 4 global pins for visibility
 *
 * Individual tasks remain as GitHub Issues (with assignees, PR auto-close, etc.).
 * Epics link to issues; issues reference the epic discussion number.
 *
 * Requires: GITHUB_TOKEN with `discussion` scope, Discussions enabled on the repo.
 *
 * Usage:
 *   crux epic list                         List open epics
 *   crux epic create <title> [--body=...]  Create a new epic discussion
 *   crux epic view <N>                     View epic with task status + comments
 *   crux epic comment <N> <message>        Post a status update comment
 *   crux epic update <N> --body=...        Update the epic body (living document)
 *   crux epic link <N> --issue=M           Link an issue to the epic
 *   crux epic unlink <N> --issue=M         Unlink an issue from the epic
 *   crux epic status <N>                   Show progress summary (open/closed linked issues)
 *   crux epic close <N>                    Close a completed epic
 *   crux epic categories                   List available discussion categories
 */

import { readFileSync } from 'fs';
import { createLogger } from '../lib/output.ts';
import { githubGraphQL, githubApi, REPO, getRepoNodeId } from '../lib/github.ts';
import { currentBranch } from '../lib/session/session-checklist.ts';
import type { CommandOptions, CommandResult } from '../lib/command-types.ts';
import { parseRequiredInt } from '../lib/cli.ts';

const [OWNER, REPO_NAME] = REPO.split('/');

// ---------------------------------------------------------------------------
// GraphQL response types
// ---------------------------------------------------------------------------

interface DiscussionCategory {
  id: string;
  name: string;
  description: string;
  isAnswerable: boolean;
}

interface DiscussionLabel {
  name: string;
}

interface DiscussionAuthor {
  login: string;
}

interface DiscussionCommentReply {
  id: string;
  body: string;
  author: DiscussionAuthor | null;
  createdAt: string;
}

interface DiscussionComment {
  id: string;
  body: string;
  author: DiscussionAuthor | null;
  createdAt: string;
  replies: { nodes: DiscussionCommentReply[] };
}

interface Discussion {
  id: string;
  number: number;
  title: string;
  body: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  closed: boolean;
  category: { name: string };
  labels: { nodes: DiscussionLabel[] };
  comments: {
    totalCount: number;
    nodes: DiscussionComment[];
  };
}

interface GitHubIssueBasic {
  number: number;
  title: string;
  state: string;
  html_url: string;
  labels: Array<{ name: string }>;
}

// ---------------------------------------------------------------------------
// Queries & mutations
// ---------------------------------------------------------------------------

const QUERIES = {
  listCategories: `
    query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        discussionCategories(first: 25) {
          nodes { id name description isAnswerable }
        }
      }
    }
  `,

  listDiscussions: `
    query($owner: String!, $name: String!, $categoryId: ID) {
      repository(owner: $owner, name: $name) {
        discussions(
          first: 25,
          orderBy: { field: UPDATED_AT, direction: DESC },
          categoryId: $categoryId
        ) {
          nodes {
            id number title body url createdAt updatedAt closed
            category { name }
            labels(first: 10) { nodes { name } }
            comments { totalCount }
          }
        }
      }
    }
  `,

  getDiscussion: `
    query($owner: String!, $name: String!, $num: Int!) {
      repository(owner: $owner, name: $name) {
        discussion(number: $num) {
          id number title body url createdAt updatedAt closed
          category { name }
          labels(first: 10) { nodes { name } }
          comments(first: 50) {
            totalCount
            nodes {
              id body createdAt
              author { login }
              replies(first: 20) {
                nodes {
                  id body createdAt
                  author { login }
                }
              }
            }
          }
        }
      }
    }
  `,

  createDiscussion: `
    mutation($repositoryId: ID!, $categoryId: ID!, $title: String!, $body: String!) {
      createDiscussion(input: {
        repositoryId: $repositoryId,
        categoryId: $categoryId,
        title: $title,
        body: $body
      }) {
        discussion { id number url }
      }
    }
  `,

  addComment: `
    mutation($discussionId: ID!, $body: String!) {
      addDiscussionComment(input: { body: $body, discussionId: $discussionId }) {
        comment { id url }
      }
    }
  `,

  updateDiscussion: `
    mutation($discussionId: ID!, $body: String!) {
      updateDiscussion(input: { discussionId: $discussionId, body: $body }) {
        discussion { id updatedAt }
      }
    }
  `,

  closeDiscussion: `
    mutation($discussionId: ID!, $reason: DiscussionCloseReason!) {
      closeDiscussion(input: { discussionId: $discussionId, reason: $reason }) {
        discussion { id }
      }
    }
  `,

  pinDiscussion: `
    mutation($discussionId: ID!) {
      pinDiscussion(input: { discussionId: $discussionId }) {
        discussion { id }
      }
    }
  `,

  addLabels: `
    mutation($labelableId: ID!, $labelIds: [ID!]!) {
      addLabelsToLabelable(input: { labelableId: $labelableId, labelIds: $labelIds }) {
        labelable { ... on Discussion { id } }
      }
    }
  `,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find the "Epics" discussion category (or a fallback).
 * Creates the category suggestion if none is found.
 */
async function findEpicCategory(): Promise<DiscussionCategory | null> {
  const data = await githubGraphQL<{
    repository: { discussionCategories: { nodes: DiscussionCategory[] } };
  }>(QUERIES.listCategories, { owner: OWNER, name: REPO_NAME });

  const cats = data.repository.discussionCategories.nodes;

  // Try exact match first, then case-insensitive, then common alternatives
  const names = ['Epics', 'epics', 'Epic', 'Agent Epics'];
  for (const name of names) {
    const cat = cats.find((c) => c.name === name);
    if (cat) return cat;
  }

  // Fallback: "General" or first category
  return cats.find((c) => c.name === 'General') || cats[0] || null;
}

/**
 * Extract linked issue numbers from an epic body.
 * Looks for patterns like `- #123`, `- [ ] #123`, `- [x] #123`, `Closes #123`.
 */
function extractLinkedIssues(body: string): number[] {
  const issueNums = new Set<number>();
  // Match: - #N, - [ ] #N, - [x] #N, #N in task lists, Closes #N
  const patterns = [
    /[-*]\s*\[[ x]\]\s*#(\d+)/gi,
    /[-*]\s*#(\d+)/g,
    /(?:closes|fixes|resolves)\s+#(\d+)/gi,
    /\bhttps:\/\/github\.com\/[^/]+\/[^/]+\/issues\/(\d+)/g,
  ];
  for (const pat of patterns) {
    let match;
    while ((match = pat.exec(body)) !== null) {
      issueNums.add(parseInt(match[1], 10));
    }
  }
  return [...issueNums].sort((a, b) => a - b);
}

/**
 * Update the epic body to add or remove an issue link.
 * Inserts into a "## Tasks" section, creating it if needed.
 */
function updateBodyWithIssueLink(
  body: string,
  issueNum: number,
  issueTitle: string,
  action: 'add' | 'remove',
): string {
  const issueRef = `#${issueNum}`;

  if (action === 'remove') {
    // Remove lines containing the issue reference
    const lines = body.split('\n');
    const filtered = lines.filter((line) => {
      const trimmed = line.trim();
      return !(
        trimmed.includes(issueRef) &&
        (trimmed.startsWith('- ') || trimmed.startsWith('* '))
      );
    });
    return filtered.join('\n');
  }

  // Add: find or create ## Tasks section
  const alreadyLinked = extractLinkedIssues(body).includes(issueNum);
  if (alreadyLinked) return body; // Already linked

  const taskLine = `- [ ] ${issueRef} — ${issueTitle}`;

  // Try to insert after existing ## Tasks heading
  const tasksHeadingRe = /^## Tasks?\s*$/m;
  if (tasksHeadingRe.test(body)) {
    // Find the end of the tasks section (next heading or end of file)
    const lines = body.split('\n');
    const headingIdx = lines.findIndex((l) => tasksHeadingRe.test(l));
    // Find last task line in this section
    let insertIdx = headingIdx + 1;
    for (let i = headingIdx + 1; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith('## ')) break; // Next section
      if (trimmed.startsWith('- ') || trimmed.startsWith('* ') || trimmed === '') {
        insertIdx = i + 1;
      }
    }
    lines.splice(insertIdx, 0, taskLine);
    return lines.join('\n');
  }

  // No Tasks section — append one
  return body.trimEnd() + '\n\n## Tasks\n\n' + taskLine + '\n';
}

/**
 * Read body from --body-file flag or --body flag.
 */
function readBody(options: CommandOptions): string | null {
  const bodyFile = options.bodyFile as string | undefined;
  if (bodyFile) {
    try {
      return readFileSync(bodyFile, 'utf-8');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Error reading body file ${bodyFile}: ${msg}`);
    }
  }
  return (options.body as string) || null;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * List open epics (discussions in the Epics category).
 */
async function list(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(Boolean(options.ci));
  const c = log.colors;

  const category = await findEpicCategory();
  const variables: Record<string, unknown> = {
    owner: OWNER,
    name: REPO_NAME,
  };
  if (category) {
    variables.categoryId = category.id;
  }

  const data = await githubGraphQL<{
    repository: { discussions: { nodes: Discussion[] } };
  }>(QUERIES.listDiscussions, variables);

  const discussions = data.repository.discussions.nodes;
  const open = discussions.filter((d) => !d.closed);

  if (options.ci) {
    return {
      output: JSON.stringify(
        open.map((d) => ({
          number: d.number,
          title: d.title,
          url: d.url,
          comments: d.comments.totalCount,
          labels: d.labels.nodes.map((l) => l.name),
          updatedAt: d.updatedAt,
        })),
        null,
        2,
      ),
      exitCode: 0,
    };
  }

  if (open.length === 0) {
    let output = `${c.yellow}No open epics found.${c.reset}\n`;
    if (category) {
      output += `${c.dim}Category: ${category.name}${c.reset}\n`;
    }
    output += `\nCreate one with: ${c.cyan}crux epic create "Epic title"${c.reset}\n`;
    return { output, exitCode: 0 };
  }

  let output = `${c.bold}${c.blue}Open Epics${c.reset}\n\n`;
  for (const d of open) {
    const labels = d.labels.nodes.map((l) => l.name).join(', ');
    const linkedIssues = extractLinkedIssues(d.body);
    output += `  ${c.cyan}#${d.number}${c.reset} ${d.title}`;
    if (labels) output += ` ${c.dim}[${labels}]${c.reset}`;
    output += `\n`;
    output += `    ${c.dim}${d.comments.totalCount} comments · ${linkedIssues.length} linked issues · updated ${d.updatedAt.split('T')[0]}${c.reset}\n`;
    output += `    ${c.dim}${d.url}${c.reset}\n\n`;
  }

  return { output, exitCode: 0 };
}

/**
 * Create a new epic discussion.
 */
async function create(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(Boolean(options.ci));
  const c = log.colors;

  const title = args.filter((a) => !a.startsWith('--'))[0];
  if (!title) {
    return {
      output: `${c.red}Usage: crux epic create <title> [--body=...] [--body-file=...] [--pin]${c.reset}\n`,
      exitCode: 1,
    };
  }

  const category = await findEpicCategory();
  if (!category) {
    return {
      output: `${c.red}No discussion categories found. Enable Discussions on the repository first.${c.reset}\n`,
      exitCode: 1,
    };
  }

  const repoNodeId = await getRepoNodeId();
  const body = readBody(options) || buildDefaultEpicBody(title);

  const data = await githubGraphQL<{
    createDiscussion: { discussion: { id: string; number: number; url: string } };
  }>(QUERIES.createDiscussion, {
    repositoryId: repoNodeId,
    categoryId: category.id,
    title: `Epic: ${title}`,
    body,
  });

  const discussion = data.createDiscussion.discussion;

  // Optionally pin the discussion
  if (options.pin) {
    try {
      await githubGraphQL(QUERIES.pinDiscussion, {
        discussionId: discussion.id,
      });
    } catch (err) {
      // Non-fatal: pin might fail if 4 discussions are already pinned
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Could not pin discussion: ${msg}`);
    }
  }

  if (options.ci) {
    return {
      output: JSON.stringify({
        number: discussion.number,
        url: discussion.url,
        category: category.name,
      }),
      exitCode: 0,
    };
  }

  let output = `${c.green}✓${c.reset} Created epic #${discussion.number}: ${title}\n`;
  output += `  Category: ${c.dim}${category.name}${c.reset}\n`;
  output += `  URL: ${c.cyan}${discussion.url}${c.reset}\n`;
  if (options.pin) {
    output += `  ${c.green}Pinned to repository index${c.reset}\n`;
  }

  return { output, exitCode: 0 };
}

/**
 * Build default epic body with standard sections.
 */
function buildDefaultEpicBody(title: string): string {
  return [
    `## Objective`,
    ``,
    `<!-- Describe the goal of this epic -->`,
    ``,
    `## Tasks`,
    ``,
    `<!-- Link issues with: crux epic link <epic-num> --issue=N -->`,
    ``,
    `## Decisions`,
    ``,
    `<!-- Record key decisions as they are made -->`,
    ``,
    `## Blockers`,
    ``,
    `None currently.`,
    ``,
  ].join('\n');
}

/**
 * View an epic with comments and task status.
 */
async function view(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(Boolean(options.ci));
  const c = log.colors;

  const num = parseRequiredInt(args.filter((a) => !a.startsWith('--'))[0]);
  if (!num) {
    return {
      output: `${c.red}Usage: crux epic view <discussion-number>${c.reset}\n`,
      exitCode: 1,
    };
  }

  const data = await githubGraphQL<{
    repository: { discussion: Discussion | null };
  }>(QUERIES.getDiscussion, { owner: OWNER, name: REPO_NAME, num });

  const d = data.repository.discussion;
  if (!d) {
    return {
      output: `${c.red}Discussion #${num} not found.${c.reset}\n`,
      exitCode: 1,
    };
  }

  if (options.ci) {
    return { output: JSON.stringify(d, null, 2), exitCode: 0 };
  }

  const linkedIssues = extractLinkedIssues(d.body);
  const labels = d.labels.nodes.map((l) => l.name).join(', ');
  const status = d.closed ? `${c.red}CLOSED${c.reset}` : `${c.green}OPEN${c.reset}`;

  let output = `${c.bold}${c.blue}Epic #${d.number}: ${d.title}${c.reset}\n`;
  output += `Status: ${status}  Category: ${d.category.name}`;
  if (labels) output += `  Labels: ${labels}`;
  output += `\n`;
  output += `${c.dim}Created: ${d.createdAt.split('T')[0]}  Updated: ${d.updatedAt.split('T')[0]}${c.reset}\n`;
  output += `${c.dim}${d.url}${c.reset}\n\n`;

  // Body
  output += `${c.bold}Body:${c.reset}\n`;
  output += d.body
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n');
  output += '\n\n';

  // Linked issues summary
  if (linkedIssues.length > 0) {
    output += `${c.bold}Linked Issues:${c.reset} ${linkedIssues.map((n) => `#${n}`).join(', ')}\n`;
    output += `${c.dim}Run 'crux epic status ${d.number}' for detailed issue status.${c.reset}\n\n`;
  }

  // Recent comments
  const comments = d.comments.nodes;
  if (comments.length > 0) {
    output += `${c.bold}Comments (${d.comments.totalCount}):${c.reset}\n\n`;
    // Show last 10 comments
    const recent = comments.slice(-10);
    for (const comment of recent) {
      const author = comment.author?.login || 'unknown';
      const date = comment.createdAt.split('T')[0];
      output += `  ${c.cyan}@${author}${c.reset} ${c.dim}(${date})${c.reset}\n`;
      // Truncate long comments
      const bodyLines = comment.body.split('\n').slice(0, 5);
      for (const line of bodyLines) {
        output += `    ${line}\n`;
      }
      if (comment.body.split('\n').length > 5) {
        output += `    ${c.dim}... (truncated)${c.reset}\n`;
      }

      // Show replies
      if (comment.replies.nodes.length > 0) {
        for (const reply of comment.replies.nodes) {
          const rAuthor = reply.author?.login || 'unknown';
          const rDate = reply.createdAt.split('T')[0];
          output += `    ${c.dim}↳ @${rAuthor} (${rDate}): ${reply.body.split('\n')[0]}${c.reset}\n`;
        }
      }
      output += '\n';
    }
  }

  return { output, exitCode: 0 };
}

/**
 * Post a status update comment on an epic.
 */
async function comment(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(Boolean(options.ci));
  const c = log.colors;

  const positionals = args.filter((a) => !a.startsWith('--'));
  const num = parseRequiredInt(positionals[0]);
  const message = positionals.slice(1).join(' ') || readBody(options);

  if (!num || !message) {
    return {
      output: `${c.red}Usage: crux epic comment <discussion-number> <message>${c.reset}\n` +
        `${c.dim}Or: crux epic comment <N> --body-file=<path>${c.reset}\n`,
      exitCode: 1,
    };
  }

  // Fetch the discussion to get its node ID
  const data = await githubGraphQL<{
    repository: { discussion: { id: string; title: string; url: string } | null };
  }>(QUERIES.getDiscussion, { owner: OWNER, name: REPO_NAME, num });

  const d = data.repository.discussion;
  if (!d) {
    return {
      output: `${c.red}Discussion #${num} not found.${c.reset}\n`,
      exitCode: 1,
    };
  }

  // Add branch context if available
  let body = message;
  try {
    const branch = currentBranch();
    if (branch && !message.includes('Branch:')) {
      body = `**Branch:** \`${branch}\`\n\n${message}`;
    }
  } catch {
    // Not in a git repo — skip branch info
  }

  const result = await githubGraphQL<{
    addDiscussionComment: { comment: { id: string; url: string } };
  }>(QUERIES.addComment, { discussionId: d.id, body });

  if (options.ci) {
    return {
      output: JSON.stringify({ url: result.addDiscussionComment.comment.url }),
      exitCode: 0,
    };
  }

  let output = `${c.green}✓${c.reset} Comment posted on epic #${num}: ${d.title}\n`;
  output += `  ${c.dim}${result.addDiscussionComment.comment.url}${c.reset}\n`;

  return { output, exitCode: 0 };
}

/**
 * Update the epic body (living document).
 */
async function update(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(Boolean(options.ci));
  const c = log.colors;

  const num = parseRequiredInt(args.filter((a) => !a.startsWith('--'))[0]);
  if (!num) {
    return {
      output: `${c.red}Usage: crux epic update <discussion-number> --body=... | --body-file=<path>${c.reset}\n`,
      exitCode: 1,
    };
  }

  const newBody = readBody(options);
  if (!newBody) {
    return {
      output: `${c.red}Provide --body=... or --body-file=<path> with the new body.${c.reset}\n`,
      exitCode: 1,
    };
  }

  // Fetch discussion node ID
  const data = await githubGraphQL<{
    repository: { discussion: { id: string; title: string } | null };
  }>(QUERIES.getDiscussion, { owner: OWNER, name: REPO_NAME, num });

  const d = data.repository.discussion;
  if (!d) {
    return {
      output: `${c.red}Discussion #${num} not found.${c.reset}\n`,
      exitCode: 1,
    };
  }

  await githubGraphQL(QUERIES.updateDiscussion, {
    discussionId: d.id,
    body: newBody,
  });

  let output = `${c.green}✓${c.reset} Updated epic #${num}: ${d.title}\n`;
  return { output, exitCode: 0 };
}

/**
 * Link an issue to an epic by adding it to the epic body's task list.
 */
async function link(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(Boolean(options.ci));
  const c = log.colors;

  const num = parseRequiredInt(args.filter((a) => !a.startsWith('--'))[0]);
  const issueNum = parseRequiredInt(options.issue as string);

  if (!num || !issueNum) {
    return {
      output: `${c.red}Usage: crux epic link <epic-number> --issue=<issue-number>${c.reset}\n`,
      exitCode: 1,
    };
  }

  // Fetch both the epic and the issue
  const [epicData, issue] = await Promise.all([
    githubGraphQL<{
      repository: { discussion: Discussion | null };
    }>(QUERIES.getDiscussion, { owner: OWNER, name: REPO_NAME, num }),
    githubApi<GitHubIssueBasic>(`/repos/${REPO}/issues/${issueNum}`),
  ]);

  const d = epicData.repository.discussion;
  if (!d) {
    return {
      output: `${c.red}Discussion #${num} not found.${c.reset}\n`,
      exitCode: 1,
    };
  }

  // Update epic body with the issue link
  const newBody = updateBodyWithIssueLink(d.body, issueNum, issue.title, 'add');
  if (newBody === d.body) {
    return {
      output: `${c.yellow}Issue #${issueNum} is already linked to epic #${num}.${c.reset}\n`,
      exitCode: 0,
    };
  }

  await githubGraphQL(QUERIES.updateDiscussion, {
    discussionId: d.id,
    body: newBody,
  });

  // Post a cross-reference comment on the issue
  await githubApi(`/repos/${REPO}/issues/${issueNum}/comments`, {
    method: 'POST',
    body: {
      body: `Linked to epic: ${d.url} (#${num})`,
    },
  });

  let output = `${c.green}✓${c.reset} Linked issue #${issueNum} (${issue.title}) to epic #${num}\n`;
  output += `  ${c.dim}Epic body updated + cross-reference comment posted on issue.${c.reset}\n`;

  return { output, exitCode: 0 };
}

/**
 * Unlink an issue from an epic.
 */
async function unlink(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(Boolean(options.ci));
  const c = log.colors;

  const num = parseRequiredInt(args.filter((a) => !a.startsWith('--'))[0]);
  const issueNum = parseRequiredInt(options.issue as string);

  if (!num || !issueNum) {
    return {
      output: `${c.red}Usage: crux epic unlink <epic-number> --issue=<issue-number>${c.reset}\n`,
      exitCode: 1,
    };
  }

  const data = await githubGraphQL<{
    repository: { discussion: Discussion | null };
  }>(QUERIES.getDiscussion, { owner: OWNER, name: REPO_NAME, num });

  const d = data.repository.discussion;
  if (!d) {
    return {
      output: `${c.red}Discussion #${num} not found.${c.reset}\n`,
      exitCode: 1,
    };
  }

  const newBody = updateBodyWithIssueLink(d.body, issueNum, '', 'remove');
  if (newBody === d.body) {
    return {
      output: `${c.yellow}Issue #${issueNum} was not linked to epic #${num}.${c.reset}\n`,
      exitCode: 0,
    };
  }

  await githubGraphQL(QUERIES.updateDiscussion, {
    discussionId: d.id,
    body: newBody,
  });

  let output = `${c.green}✓${c.reset} Unlinked issue #${issueNum} from epic #${num}\n`;
  return { output, exitCode: 0 };
}

/**
 * Show progress summary for an epic — fetches linked issues and shows open/closed status.
 */
async function status(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(Boolean(options.ci));
  const c = log.colors;

  const num = parseRequiredInt(args.filter((a) => !a.startsWith('--'))[0]);
  if (!num) {
    return {
      output: `${c.red}Usage: crux epic status <discussion-number>${c.reset}\n`,
      exitCode: 1,
    };
  }

  const data = await githubGraphQL<{
    repository: { discussion: Discussion | null };
  }>(QUERIES.getDiscussion, { owner: OWNER, name: REPO_NAME, num });

  const d = data.repository.discussion;
  if (!d) {
    return {
      output: `${c.red}Discussion #${num} not found.${c.reset}\n`,
      exitCode: 1,
    };
  }

  const linkedIssueNums = extractLinkedIssues(d.body);

  if (linkedIssueNums.length === 0) {
    let output = `${c.bold}Epic #${num}: ${d.title}${c.reset}\n`;
    output += `${c.yellow}No linked issues found.${c.reset}\n`;
    output += `Link issues with: ${c.cyan}crux epic link ${num} --issue=N${c.reset}\n`;
    return { output, exitCode: 0 };
  }

  // Fetch all linked issues in parallel.
  // Individual fetch failures return null — the issue may have been deleted or
  // the user may not have access. This is intentional fire-and-forget for
  // non-critical display data.
  const issues = await Promise.all(
    linkedIssueNums.map((n) =>
      githubApi<GitHubIssueBasic>(`/repos/${REPO}/issues/${n}`).catch((e: unknown) => {
        console.warn(`Failed to fetch issue #${n}: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      })
    )
  );

  const validIssues = issues.filter((i): i is GitHubIssueBasic => i !== null);
  const openIssues = validIssues.filter((i) => i.state === 'open');
  const closedIssues = validIssues.filter((i) => i.state === 'closed');
  const progress = validIssues.length > 0
    ? Math.round((closedIssues.length / validIssues.length) * 100)
    : 0;

  if (options.ci) {
    return {
      output: JSON.stringify({
        epic: { number: num, title: d.title },
        total: validIssues.length,
        open: openIssues.length,
        closed: closedIssues.length,
        progress,
        issues: validIssues.map((i) => ({
          number: i.number,
          title: i.title,
          state: i.state,
        })),
      }, null, 2),
      exitCode: 0,
    };
  }

  // Progress bar
  const barWidth = 20;
  const filled = Math.round(barWidth * progress / 100);
  const bar = `${'█'.repeat(filled)}${'░'.repeat(barWidth - filled)}`;
  const progressColor = progress === 100 ? c.green : progress >= 50 ? c.yellow : c.red;

  let output = `${c.bold}${c.blue}Epic #${num}: ${d.title}${c.reset}\n\n`;
  output += `  Progress: ${progressColor}${bar} ${progress}%${c.reset}`;
  output += ` (${closedIssues.length}/${validIssues.length} done)\n\n`;

  // Open issues
  if (openIssues.length > 0) {
    output += `  ${c.bold}Open (${openIssues.length}):${c.reset}\n`;
    for (const issue of openIssues) {
      const labels = issue.labels.map((l) => l.name).join(', ');
      output += `    ${c.yellow}○${c.reset} #${issue.number} ${issue.title}`;
      if (labels) output += ` ${c.dim}[${labels}]${c.reset}`;
      output += '\n';
    }
    output += '\n';
  }

  // Closed issues
  if (closedIssues.length > 0) {
    output += `  ${c.bold}Closed (${closedIssues.length}):${c.reset}\n`;
    for (const issue of closedIssues) {
      output += `    ${c.green}●${c.reset} ${c.dim}#${issue.number} ${issue.title}${c.reset}\n`;
    }
    output += '\n';
  }

  return { output, exitCode: 0 };
}

/**
 * Close a completed epic.
 */
async function close(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(Boolean(options.ci));
  const c = log.colors;

  const num = parseRequiredInt(args.filter((a) => !a.startsWith('--'))[0]);
  if (!num) {
    return {
      output: `${c.red}Usage: crux epic close <discussion-number>${c.reset}\n`,
      exitCode: 1,
    };
  }

  const data = await githubGraphQL<{
    repository: { discussion: Discussion | null };
  }>(QUERIES.getDiscussion, { owner: OWNER, name: REPO_NAME, num });

  const d = data.repository.discussion;
  if (!d) {
    return {
      output: `${c.red}Discussion #${num} not found.${c.reset}\n`,
      exitCode: 1,
    };
  }

  if (d.closed) {
    return {
      output: `${c.yellow}Epic #${num} is already closed.${c.reset}\n`,
      exitCode: 0,
    };
  }

  const reason = (options.reason as string) === 'outdated' ? 'OUTDATED' : 'RESOLVED';

  await githubGraphQL(QUERIES.closeDiscussion, {
    discussionId: d.id,
    reason,
  });

  let output = `${c.green}✓${c.reset} Closed epic #${num}: ${d.title} (${reason.toLowerCase()})\n`;
  return { output, exitCode: 0 };
}

/**
 * List available discussion categories.
 */
async function categories(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(Boolean(options.ci));
  const c = log.colors;

  const data = await githubGraphQL<{
    repository: { discussionCategories: { nodes: DiscussionCategory[] } };
  }>(QUERIES.listCategories, { owner: OWNER, name: REPO_NAME });

  const cats = data.repository.discussionCategories.nodes;

  if (options.ci) {
    return { output: JSON.stringify(cats, null, 2), exitCode: 0 };
  }

  let output = `${c.bold}${c.blue}Discussion Categories${c.reset}\n\n`;
  for (const cat of cats) {
    output += `  ${c.cyan}${cat.name}${c.reset}`;
    if (cat.isAnswerable) output += ` ${c.dim}(Q&A)${c.reset}`;
    output += '\n';
    if (cat.description) {
      output += `    ${c.dim}${cat.description}${c.reset}\n`;
    }
  }

  return { output, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const commands = {
  default: list,
  list,
  create,
  view,
  comment,
  update,
  link,
  unlink,
  status,
  close,
  categories,
};

export function getHelp(): string {
  return `
\x1b[1mEpic Management (via GitHub Discussions)\x1b[0m

Manage multi-issue epics as living documents. Each epic is a GitHub Discussion
with a structured body (task list, decisions, blockers) and a comment timeline
of agent activity.

\x1b[1mUsage:\x1b[0m
  crux epic                                  List open epics
  crux epic list                             Same as above
  crux epic create <title> [--pin]           Create a new epic discussion
  crux epic view <N>                         View epic body + recent comments
  crux epic comment <N> <message>            Post a status update comment
  crux epic update <N> --body-file=<path>    Replace the epic body
  crux epic link <N> --issue=M               Link an issue to the epic
  crux epic unlink <N> --issue=M             Unlink an issue from the epic
  crux epic status <N>                       Progress bar + linked issue status
  crux epic close <N> [--reason=outdated]    Close a completed epic
  crux epic categories                       List discussion categories

\x1b[1mOptions:\x1b[0m
  --body=<text>          Inline body text
  --body-file=<path>     Read body from file (safer for markdown)
  --pin                  Pin the discussion to the repository index (create only)
  --issue=<N>            Issue number (for link/unlink)
  --reason=<reason>      Close reason: resolved (default) or outdated
  --ci                   JSON output

\x1b[1mExamples:\x1b[0m
  crux epic create "Auth System Overhaul" --pin
  crux epic link 42 --issue=123
  crux epic comment 42 "Starting work on OAuth provider support"
  crux epic status 42

\x1b[1mWorkflow:\x1b[0m
  1. Create an epic:     crux epic create "Project Name" --pin
  2. Link issues to it:  crux epic link <epic> --issue=<N>
  3. Track progress:     crux epic status <epic>
  4. Post updates:       crux epic comment <epic> "Status update..."
  5. Close when done:    crux epic close <epic>
`;
}
