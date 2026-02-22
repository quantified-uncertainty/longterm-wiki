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
 *   crux issues cleanup              Detect stale claude-working labels + potential duplicates
 *   crux issues close <N> [--reason] Close an issue with an optional comment
 */

import { createLogger, type Colors } from '../lib/output.ts';
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
  recommendedModel: ModelName | null;
  missingSections: string[]; // empty = well-formatted
}

interface CommandOptions {
  ci?: boolean;
  json?: boolean;
  pr?: string;
  limit?: string;
  scores?: boolean;
  // create options
  model?: string;
  problem?: string;
  fix?: string;
  depends?: string;
  criteria?: string;
  cost?: string;
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

// ---------------------------------------------------------------------------
// Model extraction
// ---------------------------------------------------------------------------

/** Recognized model names for issue recommendations */
const MODEL_NAMES = ['haiku', 'sonnet', 'opus'] as const;
type ModelName = (typeof MODEL_NAMES)[number];

/**
 * Extract recommended model from an issue's title or body.
 * Looks for:
 *   - Body: "**Haiku**", "**Sonnet**", "**Opus**" (as the lead word in Recommended Model section)
 *   - Title: [haiku], [sonnet], [opus] suffix
 */
function extractModel(title: string, body: string): ModelName | null {
  // Check body: look for "## Recommended Model" section header + model name
  // Handles blank lines between header and value (e.g., "## Recommended Model\n\n**Sonnet**...")
  const sectionMatch = body.match(/##\s+recommended\s+model[^\n]*\n[\s\S]{0,10}?(haiku|sonnet|opus)/i);
  if (sectionMatch) return sectionMatch[1].toLowerCase() as ModelName;

  // Check title: [haiku], [sonnet], [opus]
  const titleMatch = title.match(/\[(haiku|sonnet|opus)\]/i);
  if (titleMatch) return titleMatch[1].toLowerCase() as ModelName;

  return null;
}

/**
 * Check whether an issue body has required sections for a well-formatted issue.
 * Returns a list of missing section names.
 */
function checkIssueSections(title: string, body: string): string[] {
  const missing: string[] = [];

  // Must have a non-trivial body
  if (body.trim().length < 80) {
    return ['body (too short or empty)'];
  }

  // Must have a problem/description section
  const hasProblem =
    /##\s+(problem|summary|description|context|background)/i.test(body) ||
    body.trim().length > 300; // long freeform body counts
  if (!hasProblem) missing.push('## Problem / ## Summary section');

  // Must have acceptance criteria or checkboxes
  const hasCriteria =
    /##\s+(acceptance\s+criteria|ac|success\s+criteria|definition\s+of\s+done)/i.test(body) ||
    /- \[ \]/.test(body);
  if (!hasCriteria) missing.push('Acceptance Criteria (## section or - [ ] checkboxes)');

  // Must have model recommendation
  const hasModel = extractModel(title, body) !== null;
  if (!hasModel) missing.push('Recommended Model (## section or [haiku/sonnet/opus] in title)');

  return missing;
}

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
        recommendedModel: extractModel(i.title, body),
        missingSections: checkIssueSections(i.title, body),
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

function formatScoreBreakdown(bd: ScoreBreakdown, c: Colors): string {
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

const MODEL_COLORS: Record<ModelName, string> = {
  haiku: '\x1b[36m',   // cyan
  sonnet: '\x1b[33m',  // yellow
  opus: '\x1b[35m',    // magenta
};

function formatIssueRow(issue: RankedIssue, c: Colors, showScores = false): string {
  const priorityLabel = issue.priority < 99 ? `P${issue.priority}` : '  ';
  const inProgressMark = issue.inProgress ? `${c.yellow}[claude-working]${c.reset} ` : '';
  const blockedMark = issue.blocked ? `${c.red}[blocked]${c.reset} ` : '';
  const claudeReadyMark = issue.labels.includes(CLAUDE_READY_LABEL) ? `${c.green}[claude-ready]${c.reset} ` : '';
  const labelStr = issue.labels
    .filter(l => l !== CLAUDE_WORKING_LABEL && l !== CLAUDE_READY_LABEL)
    .map(l => `${c.dim}${l}${c.reset}`)
    .join(' ');

  // Model badge
  let modelBadge = '';
  if (issue.recommendedModel) {
    const modelColor = MODEL_COLORS[issue.recommendedModel];
    modelBadge = ` ${modelColor}[${issue.recommendedModel}]${c.reset}`;
  }

  // Format warning for missing sections (dim, only shown with --scores or when explicitly formatting)
  const warningStr = issue.missingSections.length > 0
    ? `${c.dim}  ⚠ missing: ${issue.missingSections.join(', ')}${c.reset}`
    : '';

  let row =
    `  ${c.cyan}#${String(issue.number).padEnd(5)}${c.reset}` +
    `${c.bold}[${priorityLabel}]${c.reset} ` +
    `${inProgressMark}${blockedMark}${claudeReadyMark}${issue.title}${modelBadge}` +
    (labelStr ? `\n         ${labelStr}` : '') +
    `  ${c.dim}(${issue.createdAt})${c.reset}`;

  if (showScores) {
    row += `\n         ${formatScoreBreakdown(issue.scoreBreakdown, c)}`;
  }

  if (warningStr && showScores) {
    row += `\n         ${warningStr}`;
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
 * Build a structured issue body from template parameters.
 */
function buildIssueBody(opts: {
  problem?: string;
  fix?: string;
  depends?: string;
  criteria?: string;
  model?: string;
  cost?: string;
}): string {
  const sections: string[] = [];

  if (opts.problem) {
    sections.push(`## Problem\n\n${opts.problem}`);
  }

  if (opts.fix) {
    sections.push(`## Proposed Fix\n\n${opts.fix}`);
  }

  // Dependencies (only add section if explicitly specified)
  const depsRaw = opts.depends ? opts.depends.split(',').map(d => d.trim()).filter(Boolean) : [];
  if (depsRaw.length > 0) {
    const depLinks = depsRaw.map(d => `#${d.replace('#', '')}`).join(', ');
    sections.push(`## Dependencies\n\nDepends on: ${depLinks}`);
  }

  // Recommended Model
  if (opts.model) {
    const modelName = opts.model.toLowerCase();
    const costNote = opts.cost ? ` Estimated cost: ${opts.cost}.` : '';
    sections.push(`## Recommended Model\n\n**${modelName.charAt(0).toUpperCase() + modelName.slice(1)}** — well-scoped for this model.${costNote}`);
  }

  // Acceptance Criteria
  if (opts.criteria) {
    const items = opts.criteria.split('|').map(s => s.trim()).filter(Boolean);
    const checklist = items.map(item => `- [ ] ${item}`).join('\n');
    sections.push(`## Acceptance Criteria\n\n${checklist}`);
  }

  return sections.join('\n\n');
}

/**
 * Create a new GitHub issue.
 */
async function create(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  const title = args[0];
  if (!title) {
    return {
      output: `${c.red}Usage: crux issues create <title> [--label=X,Y] [--body="..."] [--model=haiku|sonnet|opus] [--problem="..."] [--fix="..."] [--depends=N,M] [--criteria="item1|item2"] [--cost="~$2-4"]${c.reset}\n`,
      exitCode: 1,
    };
  }

  const labels = options.label
    ? (options.label as string).split(',').map(l => l.trim()).filter(Boolean)
    : [];

  // Validate model if specified
  if (options.model && !(MODEL_NAMES as ReadonlyArray<string>).includes((options.model as string).toLowerCase())) {
    return {
      output: `${c.red}Invalid --model value: "${options.model}". Must be one of: ${MODEL_NAMES.join(', ')}${c.reset}\n`,
      exitCode: 1,
    };
  }

  // Use structured template if any structured args are provided, otherwise fall back to --body
  const hasStructuredArgs = options.problem || options.fix || options.depends || options.criteria || options.model;
  let body: string;
  if (hasStructuredArgs) {
    body = buildIssueBody({
      problem: options.problem as string | undefined,
      fix: typeof options.fix === 'string' ? options.fix : undefined,
      depends: options.depends as string | undefined,
      criteria: options.criteria as string | undefined,
      model: options.model as string | undefined,
      cost: options.cost as string | undefined,
    });
  } else {
    body = (options.body as string) || '';
  }

  interface CreateIssueResponse {
    number: number;
    html_url: string;
    title: string;
  }

  const issue = await githubApi<CreateIssueResponse>(`/repos/${REPO}/issues`, {
    method: 'POST',
    body: {
      title,
      ...(body ? { body } : {}),
      ...(labels.length > 0 ? { labels } : {}),
    },
  });

  let output = '';
  output += `${c.green}✓${c.reset} Created issue #${issue.number}: ${issue.title}\n`;
  output += `  ${c.cyan}${issue.html_url}${c.reset}\n`;
  if (labels.length > 0) {
    output += `  Labels: ${labels.join(', ')}\n`;
  }
  if (!body) {
    output += `  ${c.yellow}⚠ No body provided — consider adding --problem, --model, and --criteria flags${c.reset}\n`;
  } else {
    const missing = checkIssueSections(title, body);
    if (missing.length > 0) {
      output += `  ${c.yellow}⚠ Missing sections: ${missing.join(', ')}${c.reset}\n`;
      output += `  ${c.dim}Fix with: crux issues update-body ${issue.number} --problem="..." --model=sonnet --criteria="item1|item2"${c.reset}\n`;
    }
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

/**
 * Detect stale claude-working labels and potential duplicate issues.
 *
 * Checks:
 * 1. Issues with `claude-working` whose associated branches don't exist on remote
 * 2. Issues with very similar titles (potential duplicates)
 */
async function cleanup(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;
  const fix = Boolean(options.fix);

  const issues = await fetchOpenIssues();
  let output = '';
  let problemCount = 0;

  // --- 1. Stale claude-working labels ---
  const inProgress = issues.filter(i => i.inProgress);
  if (inProgress.length > 0) {
    output += `${c.bold}Checking ${inProgress.length} claude-working issue(s) for stale labels...${c.reset}\n\n`;

    for (const issue of inProgress) {
      // Look for a branch reference in comments
      const comments = await githubApi<Array<{ body: string; created_at: string }>>(
        `/repos/${REPO}/issues/${issue.number}/comments?per_page=10&sort=created&direction=desc`
      );

      // Extract branch name from the start comment pattern
      const branchPattern = /\*\*Branch:\*\*\s*`([^`]+)`/;
      let branchName: string | null = null;
      for (const comment of comments) {
        const match = comment.body.match(branchPattern);
        if (match) {
          branchName = match[1];
          break;
        }
      }

      if (!branchName) {
        output += `  ${c.yellow}⚠${c.reset} #${issue.number}: ${issue.title}\n`;
        output += `    ${c.dim}No branch reference found in comments — may be stale${c.reset}\n`;
        problemCount++;
        continue;
      }

      // Check if branch exists on remote
      try {
        await githubApi(`/repos/${REPO}/branches/${encodeURIComponent(branchName)}`);
        output += `  ${c.green}✓${c.reset} #${issue.number}: ${issue.title}\n`;
        output += `    ${c.dim}Branch ${branchName} exists${c.reset}\n`;
      } catch {
        output += `  ${c.red}✗${c.reset} #${issue.number}: ${issue.title}\n`;
        output += `    ${c.dim}Branch ${branchName} does not exist — label is stale${c.reset}\n`;
        problemCount++;

        if (fix) {
          // Remove the stale label
          try {
            await githubApi(
              `/repos/${REPO}/issues/${issue.number}/labels/${encodeURIComponent(CLAUDE_WORKING_LABEL)}`,
              { method: 'DELETE' }
            );
          } catch { /* 404 is fine */ }

          // Post a comment
          await githubApi(`/repos/${REPO}/issues/${issue.number}/comments`, {
            method: 'POST',
            body: {
              body: `Removing stale \`claude-working\` label — branch \`${branchName}\` no longer exists on remote. Issue is ready to be picked up again.`,
            },
          });
          output += `    ${c.green}→ Fixed: removed label and posted comment${c.reset}\n`;
        }
      }
    }
    output += '\n';
  } else {
    output += `${c.green}✓${c.reset} No claude-working issues found.\n\n`;
  }

  // --- 2. Duplicate detection ---
  output += `${c.bold}Checking for potential duplicates...${c.reset}\n\n`;

  const duplicates = findPotentialDuplicates(issues);
  if (duplicates.length === 0) {
    output += `  ${c.green}✓${c.reset} No potential duplicates detected.\n`;
  } else {
    for (const dup of duplicates) {
      output += `  ${c.yellow}⚠${c.reset} Potential duplicate pair:\n`;
      output += `    #${dup.a.number}: ${dup.a.title}\n`;
      output += `    #${dup.b.number}: ${dup.b.title}\n`;
      output += `    ${c.dim}Similarity: ${(dup.similarity * 100).toFixed(0)}%${c.reset}\n\n`;
      problemCount++;
    }
  }

  // --- Summary ---
  output += '\n';
  if (problemCount === 0) {
    output += `${c.green}✓ All clean — no stale labels or duplicates found.${c.reset}\n`;
  } else {
    output += `${c.yellow}Found ${problemCount} issue(s) to review.${c.reset}\n`;
    if (!fix && inProgress.length > 0) {
      output += `${c.dim}Run with --fix to auto-remove stale claude-working labels.${c.reset}\n`;
    }
  }

  return { output, exitCode: 0 };
}

/**
 * Find issue pairs with similar titles using word overlap (Jaccard similarity).
 */
function findPotentialDuplicates(issues: RankedIssue[]): Array<{ a: RankedIssue; b: RankedIssue; similarity: number }> {
  const THRESHOLD = 0.55;
  const results: Array<{ a: RankedIssue; b: RankedIssue; similarity: number }> = [];

  // Stopwords to exclude from comparison
  const stopwords = new Set([
    'a', 'an', 'the', 'and', 'or', 'to', 'for', 'of', 'in', 'on', 'is', 'are',
    'add', 'fix', 'update', 'all', 'with', 'from', 'new', '--', '—', '-',
  ]);

  function tokenize(title: string): Set<string> {
    return new Set(
      title.toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 2 && !stopwords.has(w))
    );
  }

  function jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 0;
    const intersection = new Set([...a].filter(x => b.has(x)));
    const union = new Set([...a, ...b]);
    return intersection.size / union.size;
  }

  const tokenized = issues.map(i => ({ issue: i, tokens: tokenize(i.title) }));

  for (let i = 0; i < tokenized.length; i++) {
    for (let j = i + 1; j < tokenized.length; j++) {
      const sim = jaccard(tokenized[i].tokens, tokenized[j].tokens);
      if (sim >= THRESHOLD) {
        results.push({
          a: tokenized[i].issue,
          b: tokenized[j].issue,
          similarity: sim,
        });
      }
    }
  }

  return results.sort((a, b) => b.similarity - a.similarity);
}

/**
 * Close an issue with an optional comment and reason.
 */
async function close(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  const issueNum = parseInt(args[0], 10);
  if (!issueNum || isNaN(issueNum)) {
    return {
      output: `${c.red}Usage: crux issues close <issue-number> [--reason="..."] [--duplicate=N]${c.reset}\n`,
      exitCode: 1,
    };
  }

  const reason = (options.reason as string) || '';
  const duplicateOf = options.duplicate ? parseInt(options.duplicate as string, 10) : null;

  // Fetch issue details
  const issue = await githubApi<GitHubIssueResponse>(`/repos/${REPO}/issues/${issueNum}`);

  // Post a closing comment if reason or duplicate provided
  if (reason || duplicateOf) {
    let body = '';
    if (duplicateOf) {
      body = `Closing as duplicate of #${duplicateOf}.`;
      if (reason) body += ` ${reason}`;
    } else {
      body = reason;
    }
    await githubApi(`/repos/${REPO}/issues/${issueNum}/comments`, {
      method: 'POST',
      body: { body },
    });
  }

  // Add duplicate label if closing as duplicate
  if (duplicateOf) {
    await githubApi(`/repos/${REPO}/issues/${issueNum}/labels`, {
      method: 'POST',
      body: { labels: ['duplicate'] },
    });
  }

  // Close the issue
  await githubApi(`/repos/${REPO}/issues/${issueNum}`, {
    method: 'PATCH',
    body: {
      state: 'closed',
      state_reason: duplicateOf ? 'not_planned' : 'completed',
    },
  });

  // Remove claude-working label if present
  const labels = (issue.labels || []).map(l => l.name);
  if (labels.includes(CLAUDE_WORKING_LABEL)) {
    try {
      await githubApi(
        `/repos/${REPO}/issues/${issueNum}/labels/${encodeURIComponent(CLAUDE_WORKING_LABEL)}`,
        { method: 'DELETE' }
      );
    } catch { /* 404 is fine */ }
  }

  let output = '';
  output += `${c.green}✓${c.reset} Closed issue #${issueNum}: ${issue.title}\n`;
  if (duplicateOf) output += `  Marked as duplicate of #${duplicateOf}\n`;
  if (reason) output += `  Comment: ${reason}\n`;

  return { output, exitCode: 0 };
}

/**
 * Update the body of an existing issue using structured template args.
 */
async function updateBody(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  const issueNum = parseInt(args[0], 10);
  if (!issueNum || isNaN(issueNum)) {
    return {
      output: `${c.red}Usage: crux issues update-body <issue-number> [--model=haiku|sonnet|opus] [--problem="..."] [--fix="..."] [--depends=N,M] [--criteria="item1|item2"] [--cost="~$2-4"]${c.reset}\n`,
      exitCode: 1,
    };
  }

  // Validate model if specified
  if (options.model && !(MODEL_NAMES as ReadonlyArray<string>).includes((options.model as string).toLowerCase())) {
    return {
      output: `${c.red}Invalid --model value: "${options.model}". Must be one of: ${MODEL_NAMES.join(', ')}${c.reset}\n`,
      exitCode: 1,
    };
  }

  // Fetch existing issue
  const issue = await githubApi<GitHubIssueResponse>(`/repos/${REPO}/issues/${issueNum}`);
  const existingBody = (issue.body || '').trim();

  const newBody = buildIssueBody({
    problem: options.problem as string | undefined,
    fix: options.fix as string | undefined,
    depends: options.depends as string | undefined,
    criteria: options.criteria as string | undefined,
    model: options.model as string | undefined,
    cost: options.cost as string | undefined,
  });

  if (!newBody) {
    return {
      output: `${c.red}No structured args provided. Use --problem, --fix, --model, --criteria, --depends, --cost.${c.reset}\n`,
      exitCode: 1,
    };
  }

  // Prepend to existing body (preserving any existing content if present)
  const combinedBody = existingBody
    ? `${newBody}\n\n---\n\n${existingBody}`
    : newBody;

  await githubApi(`/repos/${REPO}/issues/${issueNum}`, {
    method: 'PATCH',
    body: { body: combinedBody },
  });

  const remaining = checkIssueSections(issue.title, combinedBody);

  let output = `${c.green}✓${c.reset} Updated body for issue #${issueNum}: ${issue.title}\n`;
  output += `  ${c.cyan}${issue.html_url}${c.reset}\n`;
  if (remaining.length === 0) {
    output += `  ${c.green}✓ Issue now has all required sections.${c.reset}\n`;
  } else {
    output += `  ${c.yellow}⚠ Still missing: ${remaining.join(', ')}${c.reset}\n`;
  }

  return { output, exitCode: 0 };
}

/**
 * Lint GitHub issues for formatting compliance.
 * Checks: non-empty body, Problem section, Acceptance Criteria, Recommended Model.
 *
 * Usage:
 *   crux issues lint        Lint all open issues
 *   crux issues lint <N>    Lint a single issue
 */
async function lint(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  let issuesToCheck: Array<{ number: number; title: string; body: string; labels: string[]; url: string }>;

  const singleNum = args[0] ? parseInt(args[0], 10) : null;

  if (singleNum && !isNaN(singleNum)) {
    // Single issue
    const i = await githubApi<GitHubIssueResponse>(`/repos/${REPO}/issues/${singleNum}`);
    if (i.pull_request) {
      return { output: `${c.red}#${singleNum} is a pull request, not an issue.${c.reset}\n`, exitCode: 1 };
    }
    issuesToCheck = [{ number: i.number, title: i.title, body: (i.body || '').trim(), labels: (i.labels || []).map(l => l.name), url: i.html_url }];
  } else {
    // All open issues
    const issues = await fetchOpenIssues();
    issuesToCheck = issues.map(i => ({ number: i.number, title: i.title, body: i.body, labels: i.labels, url: i.url }));
  }

  let passCount = 0;
  let failCount = 0;
  let output = '';

  if (!singleNum) {
    output += `${c.bold}${c.blue}Issue Formatting Lint (${issuesToCheck.length} issues)${c.reset}\n\n`;
  }

  for (const issue of issuesToCheck) {
    const missing = checkIssueSections(issue.title, issue.body);
    const model = extractModel(issue.title, issue.body);

    if (missing.length === 0) {
      passCount++;
      if (singleNum) {
        // Show detail for single issue
        output += `${c.green}✓ PASS${c.reset} #${issue.number}: ${issue.title}\n`;
        output += `  ${c.dim}${issue.url}${c.reset}\n`;
        output += `  Recommended model: ${model ? `${c.cyan}${model}${c.reset}` : `${c.dim}(not specified)${c.reset}`}\n`;
      }
    } else {
      failCount++;
      output += `${c.red}✗ FAIL${c.reset} #${issue.number}: ${issue.title}\n`;
      output += `  ${c.dim}${issue.url}${c.reset}\n`;
      for (const m of missing) {
        output += `  ${c.yellow}→ Missing: ${m}${c.reset}\n`;
      }
      if (!singleNum) output += '\n';
    }
  }

  if (!singleNum) {
    const total = issuesToCheck.length;
    output += `\n${c.bold}Summary:${c.reset} `;
    output += `${c.green}${passCount} pass${c.reset}, ${failCount > 0 ? `${c.red}${failCount} fail${c.reset}` : `${c.dim}0 fail${c.reset}`}`;
    output += ` (${total} total)\n`;

    if (failCount > 0) {
      output += `\n${c.dim}Fix with: crux issues update-body <N> --problem="..." --model=sonnet --criteria="item1|item2"${c.reset}\n`;
    }
  }

  return { output, exitCode: failCount > 0 ? 1 : 0 };
}

// ---------------------------------------------------------------------------
// Command registry
// ---------------------------------------------------------------------------

export const commands = {
  default: list,
  list,
  next,
  create,
  'update-body': updateBody,
  lint,
  start,
  done,
  cleanup,
  close,
};

export function getHelp(): string {
  return `
Issues Domain - Track Claude Code work on GitHub issues

Commands:
  list                List open issues ranked by priority (default)
  next                Show the single next issue to pick up
  create <title>      Create a new GitHub issue (supports structured template)
  update-body <N>     Update an issue body using structured template args
  lint [N]            Check issue formatting (all issues, or single by number)
  start <N>           Signal start: post comment + add \`claude-working\` label
  done <N>            Signal completion: post comment + remove label
  cleanup             Detect stale claude-working labels + potential duplicates
  close <N>           Close an issue with optional comment

Options (list/next):
  --limit=N           Max issues to show in list (default: 30)
  --scores            Show score breakdown + formatting warnings per issue
  --json              JSON output

Options (create/update-body):
  --label=X,Y         Comma-separated labels to apply (for 'create')
  --body="..."        Raw body text (overrides structured template)
  --problem="..."     Problem/background description (## Problem section)
  --fix="..."         Proposed fix or approach (## Proposed Fix section)
  --depends=N,M       Comma-separated dependent issue numbers
  --criteria="a|b|c"  Pipe-separated acceptance criteria items
  --model=haiku|sonnet|opus  Recommended model for this issue
  --cost="~$2-4"      Estimated AI cost

Options (done):
  --pr=URL            PR URL to include in the completion comment

Options (close):
  --reason="..."      Closing comment
  --duplicate=N       Close as duplicate of issue N

Options (cleanup):
  --fix               Auto-remove stale claude-working labels

Issue Formatting Standard:
  Well-formatted issues should have:
    1. ## Problem / ## Summary section (or long freeform body)
    2. ## Acceptance Criteria section or - [ ] checkboxes
    3. Recommended model: **Haiku/Sonnet/Opus** in ## Recommended Model section,
       or [haiku/sonnet/opus] suffix in the issue title
  Check compliance with: crux issues lint [N]

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
  crux issues --scores               List with score breakdowns + formatting warnings
  crux issues next                   Show next issue to pick up
  crux issues lint                   Check all issues for formatting problems
  crux issues lint 239               Check single issue #239
  crux issues create "Add validation rule for X" --label=tooling \\
    --problem="X is not validated..." --model=haiku \\
    --criteria="Validation added|Tests pass|CI green" --cost="<$1"
  crux issues update-body 239 --problem="..." --model=sonnet --criteria="a|b"
  crux issues start 239              Announce start on issue #239
  crux issues done 239 --pr=https://github.com/.../pull/42
  crux issues cleanup                Check for stale labels and duplicates
  crux issues cleanup --fix          Auto-remove stale claude-working labels
  crux issues close 42 --duplicate=10
  crux issues close 42 --reason="Already done in PR #100"

Slash command:
  /next-issue    Claude Code command for the full "pick up next issue" workflow
`;
}

// ---------------------------------------------------------------------------
// Exported for testing
// ---------------------------------------------------------------------------

export { scoreIssue, isBlocked, findPotentialDuplicates, rankIssues, extractModel, checkIssueSections, buildIssueBody };
