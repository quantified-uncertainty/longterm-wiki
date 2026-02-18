/**
 * Issues Command Handlers
 *
 * Track Claude Code work on GitHub issues: list, prioritize, signal start/done.
 *
 * Usage:
 *   crux issues                      List open issues ranked by priority
 *   crux issues list                 Same as above
 *   crux issues next                 Show the single next issue to work on
 *   crux issues start <N>            Signal start: comment + add claude-working label
 *   crux issues done <N> [--pr=URL]  Signal completion: comment + remove label
 */

import { execSync } from 'child_process';
import { createLogger } from '../lib/output.ts';
import { githubApi, REPO } from '../lib/github.ts';
import type { CommandResult } from '../lib/cli.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GitHubIssueResponse {
  number: number;
  title: string;
  body: string | null;
  labels: Array<{ name: string }>;
  created_at: string;
  updated_at: string;
  html_url: string;
  pull_request?: unknown;
}

interface GitHubLabelResponse {
  name: string;
}

interface RankedIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  url: string;
  priority: number; // 0 = highest
  inProgress: boolean;
}

interface CommandOptions {
  ci?: boolean;
  json?: boolean;
  pr?: string;
  limit?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLAUDE_WORKING_LABEL = 'claude-working';
const CLAUDE_WORKING_COLOR = '0075ca';
const CLAUDE_WORKING_DESC = 'Claude Code is actively working on this';

const SKIP_LABELS = new Set(['wontfix', 'on-hold', 'invalid', 'duplicate', "won't fix"]);

/** Priority order: lower number = higher priority */
const PRIORITY_LABELS: Record<string, number> = {
  P0: 0,
  p0: 0,
  'priority:critical': 0,
  P1: 1,
  p1: 1,
  'priority:high': 1,
  P2: 2,
  p2: 2,
  'priority:medium': 2,
  P3: 3,
  p3: 3,
  'priority:low': 3,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function issuePriority(labels: string[]): number {
  let best = 99;
  for (const label of labels) {
    const p = PRIORITY_LABELS[label];
    if (p !== undefined && p < best) best = p;
  }
  return best;
}

function currentBranch(): string {
  try {
    return execSync('git branch --show-current', { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown-branch';
  }
}

async function ensureLabelExists(): Promise<void> {
  try {
    await githubApi<GitHubLabelResponse>(
      `/repos/${REPO}/labels/${encodeURIComponent(CLAUDE_WORKING_LABEL)}`
    );
  } catch {
    // Label doesn't exist — create it
    await githubApi(`/repos/${REPO}/labels`, {
      method: 'POST',
      body: {
        name: CLAUDE_WORKING_LABEL,
        color: CLAUDE_WORKING_COLOR,
        description: CLAUDE_WORKING_DESC,
      },
    });
  }
}

async function fetchOpenIssues(): Promise<RankedIssue[]> {
  const data = await githubApi<GitHubIssueResponse[]>(
    `/repos/${REPO}/issues?state=open&per_page=100&sort=created&direction=asc`
  );

  if (!Array.isArray(data)) return [];

  return data
    .filter(i => !i.pull_request)
    .map(i => {
      const labels = (i.labels || []).map(l => l.name);
      return {
        number: i.number,
        title: i.title,
        body: (i.body || '').trim(),
        labels,
        createdAt: i.created_at.slice(0, 10),
        updatedAt: i.updated_at.slice(0, 10),
        url: i.html_url,
        priority: issuePriority(labels),
        inProgress: labels.includes(CLAUDE_WORKING_LABEL),
      };
    })
    .filter(i => !i.labels.some(l => SKIP_LABELS.has(l)));
}

function rankIssues(issues: RankedIssue[]): RankedIssue[] {
  return [...issues].sort((a, b) => {
    // Primary: priority label (lower = more urgent)
    if (a.priority !== b.priority) return a.priority - b.priority;
    // Secondary: older issues first (smaller date string = earlier = higher priority)
    return a.createdAt.localeCompare(b.createdAt);
  });
}

function formatIssueRow(issue: RankedIssue, c: Record<string, string>): string {
  const priorityLabel = issue.priority < 99 ? `P${issue.priority}` : '  ';
  const inProgressMark = issue.inProgress ? `${c.yellow}[claude-working]${c.reset} ` : '';
  const labelStr = issue.labels
    .filter(l => l !== CLAUDE_WORKING_LABEL)
    .map(l => `${c.dim}${l}${c.reset}`)
    .join(' ');

  return (
    `  ${c.cyan}#${String(issue.number).padEnd(5)}${c.reset}` +
    `${c.bold}[${priorityLabel}]${c.reset} ` +
    `${inProgressMark}${issue.title}` +
    (labelStr ? `\n         ${labelStr}` : '') +
    `  ${c.dim}(${issue.createdAt})${c.reset}`
  );
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * List all open issues ranked by priority.
 */
async function list(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;
  const limit = parseInt(options.limit as string || '30', 10);

  const issues = await fetchOpenIssues();
  const ranked = rankIssues(issues);
  const shown = ranked.slice(0, limit);
  const inProgress = issues.filter(i => i.inProgress);

  let output = '';
  output += `${c.bold}${c.blue}Open Issues (${issues.length})${c.reset}\n`;
  output += `${c.dim}Ranked by priority label, then age. Issues with \`${CLAUDE_WORKING_LABEL}\` label are in-flight.${c.reset}\n\n`;

  if (inProgress.length > 0) {
    output += `${c.bold}${c.yellow}In Progress (${inProgress.length}):${c.reset}\n`;
    for (const i of inProgress) {
      output += `${formatIssueRow(i, c)}\n`;
    }
    output += '\n';
  }

  const notInProgress = shown.filter(i => !i.inProgress);
  output += `${c.bold}Queue:${c.reset}\n`;
  for (const issue of notInProgress) {
    output += `${formatIssueRow(issue, c)}\n`;
  }

  if (ranked.length > limit) {
    output += `\n${c.dim}...and ${ranked.length - limit} more. Use --limit=N to see more.${c.reset}\n`;
  }

  output += `\n${c.dim}Commands:${c.reset}\n`;
  output += `  ${c.dim}crux issues next        — show next issue to pick up${c.reset}\n`;
  output += `  ${c.dim}crux issues start <N>   — announce start + add label${c.reset}\n`;
  output += `  ${c.dim}crux issues done <N>    — announce completion + remove label${c.reset}\n`;

  if (options.json) {
    return { output: JSON.stringify(ranked, null, 2), exitCode: 0 };
  }

  return { output, exitCode: 0 };
}

/**
 * Show the single next issue to work on (highest priority, not in-progress).
 */
async function next(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  const issues = await fetchOpenIssues();
  const ranked = rankIssues(issues);
  const available = ranked.filter(i => !i.inProgress);

  if (available.length === 0) {
    const msg = issues.length === 0
      ? 'No open issues found.'
      : `All ${issues.length} open issues are already labeled \`${CLAUDE_WORKING_LABEL}\` or filtered out.`;
    return { output: `${c.yellow}${msg}${c.reset}\n`, exitCode: 0 };
  }

  const top = available[0];

  let output = '';
  output += `${c.bold}${c.blue}Next Issue: #${top.number}${c.reset}\n\n`;
  output += `${c.bold}${top.title}${c.reset}\n`;
  output += `${c.dim}${top.url}${c.reset}\n`;

  if (top.labels.length > 0) {
    output += `Labels: ${top.labels.map(l => `${c.cyan}${l}${c.reset}`).join(', ')}\n`;
  }
  output += `Created: ${top.createdAt}\n\n`;

  if (top.body) {
    const bodyPreview = top.body.length > 600 ? top.body.slice(0, 600) + '\n...(truncated)' : top.body;
    output += `${c.bold}Description:${c.reset}\n${bodyPreview}\n\n`;
  }

  if (available.length > 1) {
    output += `${c.dim}Also queued (${available.length - 1} more):${c.reset}\n`;
    for (const alt of available.slice(1, 4)) {
      output += `  ${c.dim}#${alt.number}: ${alt.title}${c.reset}\n`;
    }
    if (available.length > 4) {
      output += `  ${c.dim}...and ${available.length - 4} more${c.reset}\n`;
    }
    output += '\n';
  }

  output += `${c.bold}To start work:${c.reset}\n`;
  output += `  pnpm crux issues start ${top.number}\n`;

  if (options.json) {
    return { output: JSON.stringify(top, null, 2), exitCode: 0 };
  }

  return { output, exitCode: 0 };
}

/**
 * Signal start of work: post a comment and add the claude-working label.
 */
async function start(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  const issueNum = parseInt(args[0], 10);
  if (!issueNum || isNaN(issueNum)) {
    return {
      output: `${c.red}Usage: crux issues start <issue-number>${c.reset}\n`,
      exitCode: 1,
    };
  }

  // Fetch issue details
  const issue = await githubApi<GitHubIssueResponse>(`/repos/${REPO}/issues/${issueNum}`);
  const branch = currentBranch();

  // Ensure label exists
  await ensureLabelExists();

  // Add the label
  await githubApi(`/repos/${REPO}/issues/${issueNum}/labels`, {
    method: 'POST',
    body: { labels: [CLAUDE_WORKING_LABEL] },
  });

  // Post start comment
  const body =
    `🤖 Claude Code starting work on this issue.\n\n` +
    `**Branch:** \`${branch}\`\n\n` +
    `Will post an update here when a PR is ready for review.`;

  await githubApi(`/repos/${REPO}/issues/${issueNum}/comments`, {
    method: 'POST',
    body: { body },
  });

  let output = '';
  output += `${c.green}✓${c.reset} Started tracking issue #${issueNum}: ${issue.title}\n`;
  output += `  Branch: ${c.cyan}${branch}${c.reset}\n`;
  output += `  Label \`${CLAUDE_WORKING_LABEL}\` added.\n`;
  output += `  Comment posted on ${issue.html_url}\n`;

  return { output, exitCode: 0 };
}

/**
 * Signal completion: post a comment and remove the claude-working label.
 */
async function done(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  const issueNum = parseInt(args[0], 10);
  if (!issueNum || isNaN(issueNum)) {
    return {
      output: `${c.red}Usage: crux issues done <issue-number> [--pr=URL]${c.reset}\n`,
      exitCode: 1,
    };
  }

  const prUrl = options.pr as string | undefined;

  // Fetch issue details
  const issue = await githubApi<GitHubIssueResponse>(`/repos/${REPO}/issues/${issueNum}`);

  // Post completion comment
  const body = prUrl
    ? `🤖 Claude Code has finished work on this issue.\n\n**PR ready for review:** ${prUrl}`
    : `🤖 Claude Code has finished work on this issue. A PR will be opened shortly.`;

  await githubApi(`/repos/${REPO}/issues/${issueNum}/comments`, {
    method: 'POST',
    body: { body },
  });

  // Remove the claude-working label (ignore errors — may not exist)
  try {
    await githubApi(
      `/repos/${REPO}/issues/${issueNum}/labels/${encodeURIComponent(CLAUDE_WORKING_LABEL)}`,
      { method: 'DELETE' }
    );
  } catch {
    // Label may not have been applied — that's fine
  }

  let output = '';
  output += `${c.green}✓${c.reset} Marked issue #${issueNum} as done: ${issue.title}\n`;
  if (prUrl) output += `  PR: ${prUrl}\n`;
  output += `  Label \`${CLAUDE_WORKING_LABEL}\` removed.\n`;
  output += `  Comment posted on ${issue.html_url}\n`;

  return { output, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Command registry
// ---------------------------------------------------------------------------

export const commands = {
  default: list,
  list,
  next,
  start,
  done,
};

export function getHelp(): string {
  return `
Issues Domain - Track Claude Code work on GitHub issues

Commands:
  list            List open issues ranked by priority (default)
  next            Show the single next issue to pick up
  start <N>       Signal start: post comment + add \`claude-working\` label
  done <N>        Signal completion: post comment + remove label

Options:
  --limit=N       Max issues to show in list (default: 30)
  --pr=URL        PR URL to include in the completion comment (for 'done')
  --json          JSON output

Priority ranking:
  Issues are ranked by priority label (P0 > P1 > P2 > P3 > unlabeled),
  then by age (older = higher priority within same tier).
  Issues labeled \`claude-working\` are shown separately as in-progress.
  Issues labeled \`wontfix\`, \`on-hold\`, \`invalid\`, or \`duplicate\` are excluded.

Examples:
  crux issues                        List all open issues
  crux issues next                   Show next issue to pick up
  crux issues start 239              Announce start on issue #239
  crux issues done 239 --pr=https://github.com/.../pull/42
                                     Announce completion with PR link

Slash command:
  /next-issue    Claude Code command for the full "pick up next issue" workflow
`;
}
