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

import { createLogger } from '../lib/output.ts';
import { githubApi, REPO } from '../lib/github.ts';
import { currentBranch } from '../lib/session-checklist.ts';
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

interface ScoreBreakdown {
  priority: number;
  bugBonus: number;
  claudeReadyBonus: number;
  effortAdjustment: number;
  recencyBonus: number;
  ageBonus: number;
  total: number;
}

interface RankedIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  url: string;
  priority: number; // 0 = highest (legacy compat)
  score: number; // higher = better
  scoreBreakdown: ScoreBreakdown;
  inProgress: boolean;
  blocked: boolean;
}

interface CommandOptions {
  ci?: boolean;
  json?: boolean;
  pr?: string;
  limit?: string;
  scores?: boolean;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLAUDE_WORKING_LABEL = 'claude-working';
const CLAUDE_WORKING_COLOR = '0075ca';
const CLAUDE_WORKING_DESC = 'Claude Code is actively working on this';

const SKIP_LABELS = new Set(['wontfix', 'on-hold', 'invalid', 'duplicate', "won't fix"]);

/** Labels that indicate an issue is blocked or waiting */
const BLOCKED_LABELS = new Set([
  'blocked',
  'waiting',
  'needs-info',
  'needs-response',
  'needs-discussion',
  'waiting-for-upstream',
  'stalled',
]);

/** Patterns in issue body that suggest blocking */
const BLOCKED_BODY_PATTERNS = [
  /\bblocked by\b/i,
  /\bwaiting (for|on)\b/i,
  /\bdepends on #\d+/i,
];

/** Labels indicating this is a bug report */
const BUG_LABELS = new Set(['bug', 'defect', 'regression', 'crash', 'fix']);

/** Labels indicating effort level */
const HIGH_EFFORT_LABELS = new Set(['effort:high', 'large', 'epic', 'size:xl', 'size:l']);
const LOW_EFFORT_LABELS = new Set(['effort:low', 'small', 'size:xs', 'size:s', 'good first issue', 'easy']);

/** Label for human-curated "well-scoped for AI" issues */
const CLAUDE_READY_LABEL = 'claude-ready';

/** Priority label → base score */
const PRIORITY_SCORES: Record<string, number> = {
  P0: 1000,
  p0: 1000,
  'priority:critical': 1000,
  P1: 500,
  p1: 500,
  'priority:high': 500,
  P2: 200,
  p2: 200,
  'priority:medium': 200,
  P3: 100,
  p3: 100,
  'priority:low': 100,
};

/** Legacy priority order (lower = higher priority) — kept for RankedIssue.priority */
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
// Scoring
// ---------------------------------------------------------------------------

function issuePriority(labels: string[]): number {
  let best = 99;
  for (const label of labels) {
    const p = PRIORITY_LABELS[label];
    if (p !== undefined && p < best) best = p;
  }
  return best;
}

function scoreIssue(labels: string[], body: string, createdAt: string, updatedAt: string): ScoreBreakdown {
  // 1. Priority base score
  let priorityScore = 50; // unlabeled default
  for (const label of labels) {
    const s = PRIORITY_SCORES[label];
    if (s !== undefined && s > priorityScore) priorityScore = s;
  }

  // 2. Bug bonus (+50 for bugs — concrete failures are actionable)
  const bugBonus = labels.some(l => BUG_LABELS.has(l)) ? 50 : 0;

  // 3. Claude-ready multiplier (1.5×, applied after other bonuses)
  const isClaudeReady = labels.includes(CLAUDE_READY_LABEL);

  // 4. Effort adjustment
  let effortAdjustment = 0;
  if (labels.some(l => LOW_EFFORT_LABELS.has(l))) effortAdjustment = +20;
  else if (labels.some(l => HIGH_EFFORT_LABELS.has(l))) effortAdjustment = -20;

  // 5. Recency bonus (+15 if updated within 7 days — someone cares about it)
  const daysSinceUpdate = (Date.now() - new Date(updatedAt).getTime()) / (1000 * 60 * 60 * 24);
  const recencyBonus = daysSinceUpdate <= 7 ? 15 : 0;

  // 6. Age bonus (older issues get up to +10 — avoid starvation)
  const daysSinceCreate = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
  const ageBonus = Math.min(10, Math.floor(daysSinceCreate / 30)); // +1 per month, cap 10

  const baseTotal = priorityScore + bugBonus + effortAdjustment + recencyBonus + ageBonus;
  const claudeReadyBonus = isClaudeReady ? Math.round(baseTotal * 0.5) : 0;
  const total = baseTotal + claudeReadyBonus;

  return {
    priority: priorityScore,
    bugBonus,
    claudeReadyBonus,
    effortAdjustment,
    recencyBonus,
    ageBonus,
    total,
  };
}

function isBlocked(labels: string[], body: string): boolean {
  if (labels.some(l => BLOCKED_LABELS.has(l))) return true;
  return BLOCKED_BODY_PATTERNS.some(p => p.test(body));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
      const body = (i.body || '').trim();
      const breakdown = scoreIssue(labels, body, i.created_at, i.updated_at);
      return {
        number: i.number,
        title: i.title,
        body,
        labels,
        createdAt: i.created_at.slice(0, 10),
        updatedAt: i.updated_at.slice(0, 10),
        url: i.html_url,
        priority: issuePriority(labels),
        score: breakdown.total,
        scoreBreakdown: breakdown,
        inProgress: labels.includes(CLAUDE_WORKING_LABEL),
        blocked: isBlocked(labels, body),
      };
    })
    .filter(i => !i.labels.some(l => SKIP_LABELS.has(l)));
}

function rankIssues(issues: RankedIssue[]): RankedIssue[] {
  return [...issues].sort((a, b) => {
    // Higher score = higher priority
    if (a.score !== b.score) return b.score - a.score;
    // Tiebreak: older issues first
    return a.createdAt.localeCompare(b.createdAt);
  });
}

function formatScoreBreakdown(bd: ScoreBreakdown, c: Record<string, string>): string {
  const parts: string[] = [];
  parts.push(`priority:${bd.priority}`);
  if (bd.bugBonus) parts.push(`bug:+${bd.bugBonus}`);
  if (bd.claudeReadyBonus) parts.push(`claude-ready:+${bd.claudeReadyBonus}`);
  if (bd.effortAdjustment > 0) parts.push(`effort:+${bd.effortAdjustment}`);
  if (bd.effortAdjustment < 0) parts.push(`effort:${bd.effortAdjustment}`);
  if (bd.recencyBonus) parts.push(`recent:+${bd.recencyBonus}`);
  if (bd.ageBonus) parts.push(`age:+${bd.ageBonus}`);
  return `${c.dim}[score:${bd.total} = ${parts.join(' ')}]${c.reset}`;
}

function formatIssueRow(issue: RankedIssue, c: Record<string, string>, showScores = false): string {
  const priorityLabel = issue.priority < 99 ? `P${issue.priority}` : '  ';
  const inProgressMark = issue.inProgress ? `${c.yellow}[claude-working]${c.reset} ` : '';
  const blockedMark = issue.blocked ? `${c.red}[blocked]${c.reset} ` : '';
  const claudeReadyMark = issue.labels.includes(CLAUDE_READY_LABEL) ? `${c.green}[claude-ready]${c.reset} ` : '';
  const labelStr = issue.labels
    .filter(l => l !== CLAUDE_WORKING_LABEL && l !== CLAUDE_READY_LABEL)
    .map(l => `${c.dim}${l}${c.reset}`)
    .join(' ');

  let row =
    `  ${c.cyan}#${String(issue.number).padEnd(5)}${c.reset}` +
    `${c.bold}[${priorityLabel}]${c.reset} ` +
    `${inProgressMark}${blockedMark}${claudeReadyMark}${issue.title}` +
    (labelStr ? `\n         ${labelStr}` : '') +
    `  ${c.dim}(${issue.createdAt})${c.reset}`;

  if (showScores) {
    row += `\n         ${formatScoreBreakdown(issue.scoreBreakdown, c)}`;
  }

  return row;
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
  const showScores = Boolean(options.scores);

  const issues = await fetchOpenIssues();
  const ranked = rankIssues(issues);
  const shown = ranked.slice(0, limit);
  const inProgress = issues.filter(i => i.inProgress);
  const blocked = ranked.filter(i => i.blocked && !i.inProgress);

  let output = '';
  output += `${c.bold}${c.blue}Open Issues (${issues.length})${c.reset}\n`;
  output += `${c.dim}Ranked by weighted score (priority + bug + effort + recency + age). `;
  output += `Use --scores to see score breakdowns.${c.reset}\n\n`;

  if (inProgress.length > 0) {
    output += `${c.bold}${c.yellow}In Progress (${inProgress.length}):${c.reset}\n`;
    for (const i of inProgress) {
      output += `${formatIssueRow(i, c, showScores)}\n`;
    }
    output += '\n';
  }

  if (blocked.length > 0) {
    output += `${c.bold}${c.red}Blocked (${blocked.length}):${c.reset}\n`;
    for (const i of blocked) {
      output += `${formatIssueRow(i, c, showScores)}\n`;
    }
    output += '\n';
  }

  const available = shown.filter(i => !i.inProgress && !i.blocked);
  output += `${c.bold}Queue:${c.reset}\n`;
  for (const issue of available) {
    output += `${formatIssueRow(issue, c, showScores)}\n`;
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
 * Show the single next issue to work on (highest score, not in-progress, not blocked).
 */
async function next(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;
  const showScores = Boolean(options.scores);

  const issues = await fetchOpenIssues();
  const ranked = rankIssues(issues);
  const available = ranked.filter(i => !i.inProgress && !i.blocked);

  if (available.length === 0) {
    const blockedCount = ranked.filter(i => i.blocked && !i.inProgress).length;
    const inProgressCount = issues.filter(i => i.inProgress).length;

    if (issues.length === 0) {
      return { output: `${c.yellow}No open issues found.${c.reset}\n`, exitCode: 0 };
    }

    let msg = `All ${issues.length} open issues are either:\n`;
    if (inProgressCount > 0) msg += `  • ${inProgressCount} labeled \`${CLAUDE_WORKING_LABEL}\` (in-flight)\n`;
    if (blockedCount > 0) msg += `  • ${blockedCount} blocked or waiting\n`;
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
  output += `Created: ${top.createdAt}\n`;

  if (showScores) {
    output += `Score: ${formatScoreBreakdown(top.scoreBreakdown, c)}\n`;
  }
  output += '\n';

  if (top.body) {
    const bodyPreview = top.body.length > 600 ? top.body.slice(0, 600) + '\n...(truncated)' : top.body;
    output += `${c.bold}Description:${c.reset}\n${bodyPreview}\n\n`;
  }

  const blockedIssues = ranked.filter(i => i.blocked && !i.inProgress);
  if (blockedIssues.length > 0) {
    output += `${c.dim}Blocked (${blockedIssues.length} issue${blockedIssues.length > 1 ? 's' : ''} waiting):${c.reset}\n`;
    for (const b of blockedIssues.slice(0, 3)) {
      output += `  ${c.dim}#${b.number}: ${b.title}${c.reset}\n`;
    }
    if (blockedIssues.length > 3) {
      output += `  ${c.dim}...and ${blockedIssues.length - 3} more${c.reset}\n`;
    }
    output += '\n';
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

  // Remove the claude-working label (404 = label wasn't applied — that's fine)
  try {
    await githubApi(
      `/repos/${REPO}/issues/${issueNum}/labels/${encodeURIComponent(CLAUDE_WORKING_LABEL)}`,
      { method: 'DELETE' }
    );
  } catch (err) {
    if (!(err instanceof Error && err.message.includes('returned 404'))) throw err;
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
  --scores        Show score breakdown for each issue
  --pr=URL        PR URL to include in the completion comment (for 'done')
  --json          JSON output

Scoring (weighted):
  Issues are ranked by a composite score combining:
    • Priority label: P0=1000, P1=500, P2=200, P3=100, unlabeled=50
    • Bug bonus: +50 for issues labeled 'bug', 'defect', 'regression', etc.
    • Claude-ready bonus: +50% for issues labeled 'claude-ready'
    • Effort adjustment: ±20 for effort:low / effort:high labels
    • Recency bonus: +15 if updated within 7 days
    • Age bonus: +1/month since creation (capped at +10)
  Blocked issues (labels: blocked/waiting/needs-info, or body text) are
  shown separately and excluded from the queue.

Examples:
  crux issues                        List all open issues
  crux issues --scores               List with score breakdowns visible
  crux issues next                   Show next issue to pick up
  crux issues next --scores          Show next issue with score breakdown
  crux issues start 239              Announce start on issue #239
  crux issues done 239 --pr=https://github.com/.../pull/42
                                     Announce completion with PR link

Slash command:
  /next-issue    Claude Code command for the full "pick up next issue" workflow
`;
}

// ---------------------------------------------------------------------------
// Exported for testing
// ---------------------------------------------------------------------------

export { scoreIssue, isBlocked };
