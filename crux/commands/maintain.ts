/**
 * Maintain Command Handlers
 *
 * Periodic maintenance: review merged PRs, triage issues, detect cruft.
 * Produces structured reports that the /maintain Claude command acts on.
 *
 * Usage:
 *   crux sys maintain                    Run full report (all signals)
 *   crux sys maintain review-prs         Review PRs + session logs since last run
 *   crux sys maintain triage-issues      Triage open GitHub issues
 *   crux sys maintain detect-cruft       Find dead code, TODOs, large files
 *   crux sys maintain status             Show last maintenance run info
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../lib/output.ts';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { githubApi, REPO } from '../lib/github.ts';
import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';
import { parseIntOpt } from '../lib/cli.ts';

import type {
  MergedPR,
  GitHubIssue,
  CruftItem,
  TriageCategory,
  LinearTriageCategory,
  FixChainPR,
} from '../lib/maintain/types.ts';
import { loadSessionLogsSince } from '../lib/maintain/session-logs.ts';
import { findTodoComments, findLargeFiles, findCommentedCode } from '../lib/maintain/cruft-detection.ts';
import { collectHealthMetrics } from '../lib/maintain/health-metrics.ts';

// ---------------------------------------------------------------------------
// GitHub API response interfaces (type-safe parsing)
// ---------------------------------------------------------------------------

interface GitHubPullResponse {
  number: number;
  title: string;
  body: string | null;
  merged_at: string | null;
  head: { ref: string };
  user: { login: string } | null;
}

interface GitHubIssueResponse {
  number: number;
  title: string;
  labels: Array<{ name: string }>;
  created_at: string;
  updated_at: string;
  body: string | null;
  pull_request?: unknown;
}

interface CommandOptions extends BaseOptions {
  ci?: boolean;
  json?: boolean;
  since?: string;
  limit?: string;
}

// ---------------------------------------------------------------------------
// Constants & Helpers
// ---------------------------------------------------------------------------

const LAST_RUN_FILE = join(PROJECT_ROOT, '.claude/maintain-last-run.txt');
const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

function getLastRunDate(): string {
  if (existsSync(LAST_RUN_FILE)) {
    return readFileSync(LAST_RUN_FILE, 'utf-8').trim();
  }
  // Default: 7 days ago
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString().slice(0, 10);
}

function parseSinceOption(options: CommandOptions): string {
  const since = (options.since as string) || getLastRunDate();
  if (!DATE_FORMAT.test(since)) {
    throw new Error(`Invalid --since date format: "${since}". Expected YYYY-MM-DD.`);
  }
  if (isNaN(new Date(since).getTime())) {
    throw new Error(`Invalid date: "${since}". The format is correct but the date doesn't exist.`);
  }
  return since;
}

function daysSince(dateStr: string): number {
  const now = new Date();
  const then = new Date(dateStr);
  return Math.floor((now.getTime() - then.getTime()) / (1000 * 60 * 60 * 24));
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Review merged PRs and their session logs since last maintenance run.
 */
async function reviewPrs(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;
  const since = parseSinceOption(options);

  let output = '';
  output += `${c.bold}${c.blue}PR & Session Log Review${c.reset}\n`;
  output += `${c.dim}Since: ${since}${c.reset}\n\n`;

  // Fetch merged PRs
  const prsData = await githubApi<GitHubPullResponse[]>(
    `/repos/${REPO}/pulls?state=closed&sort=updated&direction=desc&per_page=100`
  );

  if (!Array.isArray(prsData)) {
    return { output: `${c.red}GitHub API returned unexpected response (not an array). Check GITHUB_TOKEN.${c.reset}\n`, exitCode: 1 };
  }

  const mergedPrs: MergedPR[] = [];
  for (const p of prsData) {
    if (p.merged_at && p.merged_at.slice(0, 10) >= since) {
      mergedPrs.push({
        number: p.number,
        title: p.title,
        mergedAt: p.merged_at.slice(0, 10),
        branch: p.head.ref,
        author: p.user?.login || '?',
      });
    }
  }

  output += `${c.bold}Merged PRs: ${mergedPrs.length}${c.reset}\n`;
  for (const pr of mergedPrs) {
    output += `  #${pr.number}: ${pr.title} (${pr.mergedAt}) [${pr.branch}]\n`;
  }
  output += '\n';

  // Load session logs for the same period
  const sessions = await loadSessionLogsSince(since);
  output += `${c.bold}Session Logs: ${sessions.length}${c.reset}\n\n`;

  // Cross-reference: find sessions with issues
  const allIssues: Array<{ session: string; issue: string }> = [];
  const allLearnings: Array<{ session: string; learning: string }> = [];
  const pageEdits: Record<string, string[]> = {};

  for (const s of sessions) {
    for (const issue of s.issues) {
      allIssues.push({ session: `${s.date} ${s.title}`, issue });
    }
    for (const learning of s.learnings) {
      allLearnings.push({ session: `${s.date} ${s.title}`, learning });
    }
    for (const page of s.pages) {
      if (!pageEdits[page]) pageEdits[page] = [];
      pageEdits[page].push(`${s.date} ${s.title}`);
    }
  }

  // Report issues
  if (allIssues.length > 0) {
    output += `${c.bold}${c.yellow}Issues Encountered (${allIssues.length}):${c.reset}\n`;
    for (const { session, issue } of allIssues) {
      output += `  ${c.yellow}!${c.reset} ${issue}\n`;
      output += `    ${c.dim}from: ${session}${c.reset}\n`;
    }
    output += '\n';

    // Find recurring issues
    const issueCounts: Record<string, number> = {};
    for (const { issue } of allIssues) {
      const key = issue.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      issueCounts[key] = (issueCounts[key] || 0) + 1;
    }
    const recurring = Object.entries(issueCounts).filter(([, count]) => count >= 2);
    if (recurring.length > 0) {
      output += `${c.bold}${c.red}Recurring Issues (${recurring.length}):${c.reset}\n`;
      for (const [issue, count] of recurring) {
        output += `  ${c.red}!!${c.reset} [${count}x] ${issue}\n`;
      }
      output += '\n';
    }
  } else {
    output += `${c.green}No issues reported in session logs.${c.reset}\n\n`;
  }

  // Report learnings
  if (allLearnings.length > 0) {
    output += `${c.bold}Learnings/Notes (${allLearnings.length}):${c.reset}\n`;
    for (const { session, learning } of allLearnings) {
      output += `  ${c.cyan}*${c.reset} ${learning}\n`;
      output += `    ${c.dim}from: ${session}${c.reset}\n`;
    }
    output += '\n';
  }

  // Pages edited by multiple sessions
  const multiEditPages = Object.entries(pageEdits).filter(([, s]) => s.length >= 2);
  if (multiEditPages.length > 0) {
    output += `${c.bold}${c.yellow}Pages Edited by Multiple Sessions:${c.reset}\n`;
    for (const [page, pageSessions] of multiEditPages) {
      output += `  ${page}: ${pageSessions.length} sessions\n`;
      for (const s of pageSessions) {
        output += `    ${c.dim}- ${s}${c.reset}\n`;
      }
    }
    output += '\n';
  }

  if (options.json || options.ci) {
    return {
      output: JSON.stringify({
        mergedPrs,
        sessions,
        allIssues,
        allLearnings,
        multiEditPages: Object.fromEntries(multiEditPages),
      }, null, 2),
      exitCode: 0,
    };
  }

  return { output, exitCode: 0 };
}

/**
 * Triage open GitHub issues — check for staleness, resolved status, actionability.
 */
async function triageIssues(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  let output = '';
  output += `${c.bold}${c.blue}GitHub Issue Triage${c.reset}\n\n`;

  // Fetch open issues
  const issuesData = await githubApi<GitHubIssueResponse[]>(
    `/repos/${REPO}/issues?state=open&per_page=100&sort=updated&direction=desc`
  );

  if (!Array.isArray(issuesData)) {
    return { output: `${c.red}GitHub API returned unexpected response. Check GITHUB_TOKEN.${c.reset}\n`, exitCode: 1 };
  }

  const openIssues: GitHubIssue[] = [];
  for (const i of issuesData) {
    if (i.pull_request) continue;
    openIssues.push({
      number: i.number,
      title: i.title,
      labels: (i.labels || []).map(l => l.name),
      createdAt: i.created_at.slice(0, 10),
      updatedAt: i.updated_at.slice(0, 10),
      body: (i.body || '').slice(0, 500),
    });
  }

  // Fetch recently-closed issues
  const closedIssuesData = await githubApi<(GitHubIssueResponse & { closed_at: string | null })[]>(
    `/repos/${REPO}/issues?state=closed&sort=updated&direction=desc&per_page=50`
  );
  const recentlyClosedIssues: Array<GitHubIssue & { closedAt: string }> = [];
  if (!Array.isArray(closedIssuesData)) {
    output += `${c.yellow}Warning: Could not fetch recently-closed issues. Triage may be incomplete.${c.reset}\n\n`;
  } else {
    const since = parseSinceOption(options);
    for (const i of closedIssuesData) {
      if (i.pull_request) continue;
      const closedAt = i.closed_at?.slice(0, 10);
      if (!closedAt || closedAt < since) continue;
      recentlyClosedIssues.push({
        number: i.number,
        title: i.title,
        labels: (i.labels || []).map(l => l.name),
        createdAt: i.created_at.slice(0, 10),
        updatedAt: i.updated_at.slice(0, 10),
        body: (i.body || '').slice(0, 500),
        closedAt,
      });
    }
  }

  // Fetch recent merged PRs to cross-reference
  const prsData = await githubApi<GitHubPullResponse[]>(
    `/repos/${REPO}/pulls?state=closed&sort=updated&direction=desc&per_page=100`
  );

  // Build set of issue numbers explicitly closed by merged PRs
  const mergedPrs = (Array.isArray(prsData) ? prsData : []).filter(p => p.merged_at);
  const explicitlyClosedByPr = new Map<number, string>();
  const closesPattern = /(?:closes|fixes|resolves)\s+#(\d+)/gi;
  for (const pr of mergedPrs) {
    const body = pr.body || '';
    for (const match of body.matchAll(closesPattern)) {
      const issueNum = parseInt(match[1], 10);
      if (!explicitlyClosedByPr.has(issueNum)) {
        explicitlyClosedByPr.set(issueNum, `PR #${pr.number}: ${pr.title}`);
      }
    }
  }

  // Categorize issues
  const categories: Record<TriageCategory, Array<GitHubIssue & { reason: string }>> = {
    'potentially-resolved': [],
    'stale': [],
    'actionable': [],
    'keep': [],
  };

  for (const issue of recentlyClosedIssues) {
    const closingPr = explicitlyClosedByPr.get(issue.number);
    categories['potentially-resolved'].push({
      ...issue,
      reason: closingPr
        ? `Closed on ${issue.closedAt} by merged ${closingPr}`
        : `Closed on ${issue.closedAt} (verify resolution)`,
    });
  }

  for (const issue of openIssues) {
    const daysInactive = daysSince(issue.updatedAt);
    const closingPr = explicitlyClosedByPr.get(issue.number);

    if (closingPr) {
      categories['potentially-resolved'].push({
        ...issue,
        reason: `Still open but referenced by merged ${closingPr}`,
      });
    } else if (daysInactive > 30) {
      categories['stale'].push({
        ...issue,
        reason: `No activity for ${daysInactive} days`,
      });
    } else if (issue.labels.includes('enhancement') && daysInactive < 14) {
      categories['actionable'].push({
        ...issue,
        reason: 'Recent enhancement request',
      });
    } else {
      categories['keep'].push({
        ...issue,
        reason: 'No action needed right now',
      });
    }
  }

  // Output report
  output += `${c.bold}Open Issues: ${openIssues.length}${c.reset}`;
  if (recentlyClosedIssues.length > 0) {
    output += ` ${c.dim}(+ ${recentlyClosedIssues.length} recently closed)${c.reset}`;
  }
  output += '\n\n';

  const categoryMeta: Record<TriageCategory, { label: string; color: string; desc: string }> = {
    'potentially-resolved': {
      label: 'Recently Resolved / Referenced',
      color: c.green,
      desc: 'Recently closed issues or open issues referenced by merged PRs. Listed for awareness / check.',
    },
    'stale': {
      label: 'Stale',
      color: c.yellow,
      desc: 'No activity for 30+ days. Consider closing with a comment or updating.',
    },
    'actionable': {
      label: 'Actionable Now',
      color: c.cyan,
      desc: 'Could be fixed in this maintenance session.',
    },
    'keep': {
      label: 'Keep Open',
      color: '',
      desc: 'Still valid, not actionable right now.',
    },
  };

  for (const [cat, items] of Object.entries(categories) as Array<[TriageCategory, Array<GitHubIssue & { reason: string }>]>) {
    if (items.length === 0) continue;
    const meta = categoryMeta[cat];
    output += `${c.bold}${meta.color}${meta.label} (${items.length}):${c.reset}\n`;
    output += `${c.dim}${meta.desc}${c.reset}\n`;
    for (const issue of items) {
      output += `  ${meta.color}#${issue.number}${c.reset}: ${issue.title}\n`;
      output += `    ${c.dim}${issue.reason}${c.reset}\n`;
    }
    output += '\n';
  }

  if (options.json || options.ci) {
    return { output: JSON.stringify(categories, null, 2), exitCode: 0 };
  }

  return { output, exitCode: 0 };
}

/**
 * Triage Linear issues — detect stale In Progress, stuck In Review, and
 * surface the ready-for-dispatch queue. Mirrors triageIssues() for GitHub.
 */
async function triageLinear(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  let output = '';
  output += `${c.bold}${c.blue}Linear Queue Triage${c.reset}\n\n`;

  // Check if LINEAR_API_KEY is available
  if (!process.env.LINEAR_API_KEY) {
    output += `${c.yellow}LINEAR_API_KEY not set — skipping Linear triage.${c.reset}\n`;
    output += `${c.dim}Set it in .env.base and sync to slot .env to enable.${c.reset}\n`;
    return { output, exitCode: 0 };
  }

  let listIssuesByStateType: typeof import('../lib/linear/issues.ts').listIssuesByStateType;
  try {
    const linearMod = await import('../lib/linear/issues.ts');
    listIssuesByStateType = linearMod.listIssuesByStateType;
  } catch (e) {
    output += `${c.red}Failed to load Linear library: ${e instanceof Error ? e.message : String(e)}${c.reset}\n`;
    return { output, exitCode: 0 };
  }

  // Fetch active issues (In Progress + In Review) and backlog (Backlog + Todo)
  const [activeIssues, backlogIssues] = await Promise.all([
    listIssuesByStateType(['started']),       // In Progress + In Review
    listIssuesByStateType(['backlog', 'unstarted']), // Backlog + Todo
  ]);

  const STALE_DAYS = 3;
  const STUCK_REVIEW_DAYS = 5;
  const priorityLabels: Record<number, string> = {
    0: 'none', 1: 'urgent', 2: 'high', 3: 'medium', 4: 'low',
  };

  const categories: Record<LinearTriageCategory, Array<{
    identifier: string;
    title: string;
    priority: string;
    state: string;
    daysInactive: number;
    reason: string;
    parent?: string;
  }>> = {
    'stale-in-progress': [],
    'stuck-in-review': [],
    'ready-dispatch': [],
    'active': [],
  };

  // Categorize active issues
  for (const issue of activeIssues) {
    const daysInactive = daysSince(issue.updatedAt);
    const pLabel = priorityLabels[issue.priority] ?? `p${issue.priority}`;
    const parent = issue.parent ? `${issue.parent.identifier}` : undefined;
    const entry = {
      identifier: issue.identifier,
      title: issue.title,
      priority: pLabel,
      state: issue.state.name,
      daysInactive,
      reason: '',
      parent,
    };

    if (issue.state.name === 'In Review' && daysInactive > STUCK_REVIEW_DAYS) {
      entry.reason = `In Review for ${daysInactive} days — may need merge or follow-up`;
      categories['stuck-in-review'].push(entry);
    } else if (issue.state.name === 'In Progress' && daysInactive > STALE_DAYS) {
      entry.reason = `In Progress for ${daysInactive} days with no updates`;
      categories['stale-in-progress'].push(entry);
    } else {
      entry.reason = `Active (updated ${daysInactive}d ago)`;
      categories['active'].push(entry);
    }
  }

  // Surface ready-for-dispatch (P1/P2 in Backlog/Todo)
  for (const issue of backlogIssues) {
    if (issue.priority <= 2 && issue.priority > 0) { // urgent or high
      const pLabel = priorityLabels[issue.priority] ?? `p${issue.priority}`;
      const parent = issue.parent ? `${issue.parent.identifier}` : undefined;
      categories['ready-dispatch'].push({
        identifier: issue.identifier,
        title: issue.title,
        priority: pLabel,
        state: issue.state.name,
        daysInactive: daysSince(issue.updatedAt),
        reason: `${pLabel} priority, ready to pick up`,
        parent,
      });
    }
  }

  // Sort each category: stale ones by days descending, dispatch by priority then age
  categories['stale-in-progress'].sort((a, b) => b.daysInactive - a.daysInactive);
  categories['stuck-in-review'].sort((a, b) => b.daysInactive - a.daysInactive);
  categories['ready-dispatch'].sort((a, b) => {
    // Lower priority number = more urgent
    const pa = Object.entries(priorityLabels).find(([, v]) => v === a.priority)?.[0] ?? '4';
    const pb = Object.entries(priorityLabels).find(([, v]) => v === b.priority)?.[0] ?? '4';
    return Number(pa) - Number(pb) || b.daysInactive - a.daysInactive;
  });

  const totalActive = activeIssues.length;
  const totalBacklog = backlogIssues.length;
  output += `${c.bold}Active issues: ${totalActive}${c.reset} (In Progress + In Review)`;
  output += `  ${c.dim}Backlog: ${totalBacklog}${c.reset}\n\n`;

  const categoryMeta: Record<LinearTriageCategory, { label: string; color: string; desc: string }> = {
    'stale-in-progress': {
      label: 'Stale In Progress',
      color: c.red,
      desc: `In Progress for >${STALE_DAYS} days with no updates. Move to Todo or update with progress.`,
    },
    'stuck-in-review': {
      label: 'Stuck In Review',
      color: c.yellow,
      desc: `In Review for >${STUCK_REVIEW_DAYS} days. Check if PR was merged — may need to move to Done.`,
    },
    'ready-dispatch': {
      label: 'Ready for Dispatch (P1/P2)',
      color: c.cyan,
      desc: 'High-priority items in Backlog/Todo ready for an agent to pick up.',
    },
    'active': {
      label: 'Active (healthy)',
      color: c.green,
      desc: 'Currently being worked on with recent activity.',
    },
  };

  for (const [cat, items] of Object.entries(categories) as Array<[LinearTriageCategory, typeof categories[LinearTriageCategory]]>) {
    if (items.length === 0) continue;
    const meta = categoryMeta[cat];
    output += `${c.bold}${meta.color}${meta.label} (${items.length}):${c.reset}\n`;
    output += `${c.dim}${meta.desc}${c.reset}\n`;
    for (const item of items) {
      const parentTag = item.parent ? ` ${c.dim}[${item.parent}]${c.reset}` : '';
      output += `  ${meta.color}${item.identifier}${c.reset} [${item.state}] ${item.priority} — ${item.title}${parentTag}\n`;
      output += `    ${c.dim}${item.reason}${c.reset}\n`;
    }
    output += '\n';
  }

  if (options.json || options.ci) {
    return { output: JSON.stringify(categories, null, 2), exitCode: 0 };
  }

  return { output, exitCode: 0 };
}

/**
 * Detect codebase cruft: stale TODOs, large files, commented-out code.
 */
async function detectCruft(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;
  const limit = parseIntOpt(options.limit, 30);

  let output = '';
  output += `${c.bold}${c.blue}Codebase Cruft Detection${c.reset}\n\n`;

  // Use extracted cruft detection modules
  const items: CruftItem[] = [
    ...findTodoComments(),
    ...findLargeFiles(),
    ...findCommentedCode(),
  ];

  // Report
  const byType: Record<string, CruftItem[]> = {};
  for (const item of items) {
    if (!byType[item.type]) byType[item.type] = [];
    byType[item.type].push(item);
  }

  const typeLabels: Record<string, { label: string; color: string }> = {
    'todo': { label: 'TODO/FIXME/HACK Comments', color: c.yellow },
    'large-file': { label: 'Large Files (>400 lines)', color: c.cyan },
    'commented-code': { label: 'Commented-Out Code', color: c.dim },
  };

  output += `${c.bold}Total cruft items: ${items.length}${c.reset}\n\n`;

  for (const [type, typeItems] of Object.entries(byType)) {
    const meta = typeLabels[type] || { label: type, color: '' };
    const shown = typeItems.slice(0, limit);
    output += `${c.bold}${meta.color}${meta.label} (${typeItems.length}):${c.reset}\n`;
    for (const item of shown) {
      const loc = item.line ? `:${item.line}` : '';
      output += `  ${item.path}${loc}\n`;
      output += `    ${c.dim}${item.detail}${c.reset}\n`;
    }
    if (typeItems.length > limit) {
      output += `  ${c.dim}... and ${typeItems.length - limit} more${c.reset}\n`;
    }
    output += '\n';
  }

  if (options.json || options.ci) {
    return { output: JSON.stringify({ items, byType: Object.fromEntries(
      Object.entries(byType).map(([k, v]) => [k, v.length])
    ) }, null, 2), exitCode: 0 };
  }

  return { output, exitCode: 0 };
}

/**
 * Show maintenance status: last run date, summary of what was found.
 */
async function status(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  const lastRun = existsSync(LAST_RUN_FILE) ? readFileSync(LAST_RUN_FILE, 'utf-8').trim() : null;

  let output = '';
  output += `${c.bold}${c.blue}Maintenance Status${c.reset}\n\n`;

  if (lastRun) {
    const daysAgo = daysSince(lastRun);
    const urgency = daysAgo > 7 ? c.red : daysAgo > 3 ? c.yellow : c.green;
    output += `Last maintenance run: ${urgency}${lastRun} (${daysAgo} days ago)${c.reset}\n`;
  } else {
    output += `${c.yellow}No maintenance runs recorded yet.${c.reset}\n`;
    output += `${c.dim}Run \`crux sys maintain\` to perform the first sweep.${c.reset}\n`;
  }

  const since = lastRun || '2000-01-01';
  const sessions = await loadSessionLogsSince(since);
  output += `Session logs since last run: ${sessions.length}\n`;

  const sessionsWithIssues = sessions.filter(s => s.issues.length > 0);
  if (sessionsWithIssues.length > 0) {
    output += `${c.yellow}Sessions with issues: ${sessionsWithIssues.length}${c.reset}\n`;
  }

  output += '\n';
  output += `${c.bold}Recommended cadences:${c.reset}\n`;
  output += `  ${c.dim}Daily:   crux sys maintain review-prs   (review new PRs + session logs)${c.reset}\n`;
  output += `  ${c.dim}Weekly:  crux sys maintain               (full sweep + issue triage)${c.reset}\n`;
  output += `  ${c.dim}Monthly: crux sys maintain detect-cruft  (deep cruft analysis + cleanup)${c.reset}\n`;

  return { output, exitCode: 0 };
}

/**
 * Run all maintenance signals and produce a combined report.
 */
async function report(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  if (options.json || options.ci) {
    const prResult = await reviewPrs(args, { ...options, json: true });
    const issueResult = await triageIssues(args, { ...options, json: true });
    const linearResult = await triageLinear(args, { ...options, json: true });
    const cruftResult = await detectCruft(args, { ...options, json: true });

    if (prResult.exitCode !== 0 || issueResult.exitCode !== 0 || cruftResult.exitCode !== 0) {
      const errors = [
        prResult.exitCode !== 0 && `PR review: ${prResult.output.slice(0, 200)}`,
        issueResult.exitCode !== 0 && `Issue triage: ${issueResult.output.slice(0, 200)}`,
        cruftResult.exitCode !== 0 && `Cruft detection: ${cruftResult.output.slice(0, 200)}`,
      ].filter(Boolean);
      return { output: `One or more sub-reports failed:\n${errors.join('\n')}`, exitCode: 1 };
    }

    const combined: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      prReview: JSON.parse(prResult.output),
      issueTriage: JSON.parse(issueResult.output),
      cruftDetection: JSON.parse(cruftResult.output),
    };
    try { combined.linearTriage = JSON.parse(linearResult.output); } catch { /* non-JSON = skipped */ }

    writeFileSync(LAST_RUN_FILE, new Date().toISOString().slice(0, 10) + '\n');
    return { output: JSON.stringify(combined, null, 2), exitCode: 0 };
  }

  let output = '';
  output += `${c.bold}${c.blue}${'═'.repeat(60)}${c.reset}\n`;
  output += `${c.bold}${c.blue}  Maintenance Sweep Report${c.reset}\n`;
  output += `${c.bold}${c.blue}${'═'.repeat(60)}${c.reset}\n\n`;

  const prResult = await reviewPrs(args, options);
  const issueResult = await triageIssues(args, options);
  const linearResult = await triageLinear(args, options);
  const cruftResult = await detectCruft(args, options);

  output += prResult.output;
  output += `${c.dim}${'─'.repeat(60)}${c.reset}\n\n`;
  output += issueResult.output;
  output += `${c.dim}${'─'.repeat(60)}${c.reset}\n\n`;
  output += linearResult.output;
  output += `${c.dim}${'─'.repeat(60)}${c.reset}\n\n`;
  output += cruftResult.output;

  // Audits section
  try {
    const { commands: auditsCmds } = await import('./audits.ts');
    const auditsResult = await auditsCmds.report(args, options);
    if (auditsResult.exitCode === 0 && auditsResult.output.trim()) {
      output += `${c.dim}${'─'.repeat(60)}${c.reset}\n\n`;
      output += auditsResult.output;
      output += '\n';
    }
  } catch {
    // Audits module not available — skip silently
  }

  // Priority summary
  output += `${c.bold}${c.blue}${'═'.repeat(60)}${c.reset}\n`;
  output += `${c.bold}Suggested Action Plan:${c.reset}\n\n`;
  output += `  ${c.red}P0${c.reset} — Fix broken things (CI failures, blocking validation errors)\n`;
  output += `  ${c.yellow}P1${c.reset} — Close resolved issues (verify + close issues fixed by recent PRs)\n`;
  output += `  ${c.cyan}P2${c.reset} — Propagate learnings (add recurring issues to common-issues.md/rules)\n`;
  output += `  P3 — Work actionable issues (fix small issues; file new issues for larger tasks)\n`;
  output += `  ${c.dim}P4 — Cruft cleanup (dead code, stale TODOs, file splitting)${c.reset}\n`;
  output += `  ${c.dim}P5 — Page content updates (delegate to \`crux w updates run\`)${c.reset}\n`;
  output += '\n';

  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(LAST_RUN_FILE, today + '\n');
  output += `${c.dim}Updated last-run timestamp: ${today}${c.reset}\n`;

  return { output, exitCode: 0 };
}

/**
 * Mark the last maintenance run timestamp.
 */
async function markRun(_args: string[], _options: CommandOptions): Promise<CommandResult> {
  const date = new Date().toISOString().slice(0, 10);
  writeFileSync(LAST_RUN_FILE, date + '\n');
  return { output: `Maintenance last-run set to ${date}`, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Fix Chains — detect feature PRs followed by fix PRs touching the same files
// ---------------------------------------------------------------------------

async function fixChains(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;
  const since = parseSinceOption(options);
  const isJson = options.json || options.ci;

  let output = '';
  output += `${c.bold}${c.blue}Fix Chain Detection${c.reset}\n`;
  output += `${c.dim}Since: ${since}${c.reset}\n\n`;

  const prsData = await githubApi<GitHubPullResponse[]>(
    `/repos/${REPO}/pulls?state=closed&sort=updated&direction=desc&per_page=100`
  );

  if (!Array.isArray(prsData)) {
    return { output: `${c.red}GitHub API returned unexpected response. Check GITHUB_TOKEN.${c.reset}\n`, exitCode: 1 };
  }

  const mergedPrs: FixChainPR[] = [];
  for (const p of prsData) {
    if (!p.merged_at || p.merged_at.slice(0, 10) < since) continue;

    const type = /^fix[:(]/i.test(p.title) ? 'fix' as const
      : /^feat[:(]/i.test(p.title) ? 'feat' as const
      : 'other' as const;

    let files: string[] = [];
    try {
      const filesData = await githubApi<Array<{ filename: string }>>(
        `/repos/${REPO}/pulls/${p.number}/files?per_page=100`
      );
      if (Array.isArray(filesData)) {
        files = filesData.map(f => f.filename);
      }
    } catch {
      // Non-fatal
    }

    mergedPrs.push({
      number: p.number,
      title: p.title,
      mergedAt: p.merged_at,
      files,
      type,
    });
  }

  mergedPrs.sort((a, b) => a.mergedAt.localeCompare(b.mergedAt));

  const TWO_DAYS_MS = 48 * 60 * 60 * 1000;

  interface Chain {
    source: FixChainPR;
    fixes: Array<FixChainPR & { overlap: string[] }>;
  }

  const chains: Chain[] = [];
  const featPrs = mergedPrs.filter(p => p.type === 'feat');
  const fixPrs = mergedPrs.filter(p => p.type === 'fix');

  for (const feat of featPrs) {
    const featTime = new Date(feat.mergedAt).getTime();
    const fixes: Chain['fixes'] = [];

    for (const fix of fixPrs) {
      const fixTime = new Date(fix.mergedAt).getTime();
      if (fixTime <= featTime || fixTime - featTime > TWO_DAYS_MS) continue;

      const overlap = fix.files.filter(f => feat.files.includes(f));
      if (overlap.length > 0) {
        fixes.push({ ...fix, overlap });
      }
    }

    if (fixes.length > 0) {
      chains.push({ source: feat, fixes });
    }
  }

  const totalFixes = chains.reduce((sum, ch) => sum + ch.fixes.length, 0);

  if (isJson) {
    return {
      output: JSON.stringify({
        since,
        totalPrs: mergedPrs.length,
        featPrs: featPrs.length,
        fixPrs: fixPrs.length,
        chains: chains.map(ch => ({
          source: { number: ch.source.number, title: ch.source.title },
          fixes: ch.fixes.map(f => ({ number: f.number, title: f.title, overlap: f.overlap })),
        })),
        chainCount: chains.length,
        totalFixFollowups: totalFixes,
        chainRate: mergedPrs.length > 0
          ? Math.round((chains.length / mergedPrs.length) * 100) / 100
          : 0,
      }, null, 2),
      exitCode: 0,
    };
  }

  output += `${c.bold}PRs analyzed:${c.reset} ${mergedPrs.length} (${featPrs.length} feat, ${fixPrs.length} fix)\n\n`;

  if (chains.length === 0) {
    output += `${c.green}No fix chains detected.${c.reset}\n`;
  } else {
    output += `${c.yellow}${c.bold}Fix chains found: ${chains.length}${c.reset} ${c.dim}(${totalFixes} follow-up fix PRs)${c.reset}\n\n`;

    for (const chain of chains) {
      output += `  ${c.cyan}#${chain.source.number}${c.reset} ${chain.source.title}\n`;
      for (const fix of chain.fixes) {
        output += `    ${c.yellow}→${c.reset} #${fix.number} ${fix.title}\n`;
        output += `      ${c.dim}overlapping: ${fix.overlap.slice(0, 3).join(', ')}${fix.overlap.length > 3 ? ` +${fix.overlap.length - 3} more` : ''}${c.reset}\n`;
      }
      output += '\n';
    }

    const rate = mergedPrs.length > 0
      ? Math.round((chains.length / mergedPrs.length) * 100)
      : 0;
    output += `${c.bold}Chain rate:${c.reset} ${rate}% of PRs are part of a fix chain\n`;
  }

  return { output, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Health Snapshot — quantified metrics for trend tracking
// ---------------------------------------------------------------------------

async function healthSnapshot(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;
  const isJson = options.json || options.ci;

  const metrics = collectHealthMetrics();

  if (isJson) {
    return { output: JSON.stringify(metrics, null, 2), exitCode: 0 };
  }

  let output = '';
  output += `${c.bold}${c.blue}Code Health Snapshot${c.reset}  ${c.dim}${metrics.date}${c.reset}\n\n`;

  const rated = (val: number, green: number, yellow: number, invert = false): string => {
    const isGreen = invert ? val <= green : val >= green;
    const isYellow = invert ? val <= yellow : val >= yellow;
    if (isGreen) return `${c.green}${val}${c.reset}`;
    if (isYellow) return `${c.yellow}${val}${c.reset}`;
    return `${c.red}${val}${c.reset}`;
  };

  output += `  TODOs:             ${rated(metrics.todoCount, 20, 50, true)}\n`;
  output += `  FIXME/HACK/XXX:    ${rated(metrics.fixmeCount, 5, 15, true)}\n`;
  output += `  \`any\` types:       ${rated(metrics.anyTypeCount, 20, 50, true)}\n`;
  output += `  Files >500 lines:  ${rated(metrics.largeFileCount, 5, 10, true)}\n`;
  output += `  Test files:        ${metrics.testFileCount}\n`;
  output += `  Source files:      ${metrics.sourceFileCount}\n`;
  output += `  Test:source ratio: ${rated(metrics.testToSourceRatio, 0.15, 0.08)}\n`;
  output += `  Skipped tests:     ${rated(metrics.skippedTests, 3, 8, true)}\n`;
  output += '\n';
  output += `  ${c.bold}Recent commits (last 60):${c.reset}\n`;
  output += `    Total:    ${metrics.recentCommits.total}\n`;
  output += `    Fixes:    ${metrics.recentCommits.fixes}\n`;
  output += `    Features: ${metrics.recentCommits.features}\n`;
  output += `    Fix ratio: ${rated(metrics.recentCommits.fixRatio, 0.3, 0.5, true)} ${c.dim}(lower is better)${c.reset}\n`;

  if (metrics.largeFiles.length > 0) {
    output += `\n  ${c.bold}Largest files:${c.reset}\n`;
    for (const f of metrics.largeFiles.slice(0, 10)) {
      output += `    ${c.yellow}${f.lines}${c.reset} ${c.dim}${f.path}${c.reset}\n`;
    }
  }

  output += `\n${c.dim}Run with --json to get machine-readable output for trend tracking.${c.reset}\n`;

  return { output, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Command registry
// ---------------------------------------------------------------------------

export const commands = {
  default: report,
  report,
  'review-prs': reviewPrs,
  'triage-issues': triageIssues,
  'triage-linear': triageLinear,
  'detect-cruft': detectCruft,
  'fix-chains': fixChains,
  'health-snapshot': healthSnapshot,
  status,
  'mark-run': markRun,
};

export function getHelp(): string {
  return `
Maintain Domain - Periodic maintenance and housekeeping

Gathers signals from PRs, session logs, GitHub issues, and codebase
analysis. Produces prioritized reports and helps with cleanup.

Commands:
  report           Run full maintenance report (default)
  review-prs       Review merged PRs and session logs since last run
  triage-issues    Triage open GitHub issues for staleness/resolution
  triage-linear    Triage Linear queue (stale In Progress, stuck In Review, dispatch queue)
  detect-cruft     Find dead code, TODOs, large files, commented-out code
  fix-chains       Detect feature PRs followed by fix PRs (quality signal)
  health-snapshot  Quantified code health metrics (TODOs, any types, fix ratio, etc.)
  status           Show last maintenance run info and recommended cadences
  mark-run         Update the last-run timestamp without running a report

Options:
  --since=DATE    Override the start date (YYYY-MM-DD; default: last run or 7d ago)
  --limit=N       Max items per category in cruft report (default: 30)
  --json          Output as JSON
  --ci            JSON output for CI pipelines

Priority order for maintenance work:
  P0 — Broken things (CI failures, blocking errors)
  P1 — Close resolved issues (quick wins)
  P2 — Propagate learnings (common-issues.md, rules)
  P3 — Work actionable issues / file new issues for larger tasks
  P4 — Cruft cleanup (dead code, TODOs)
  P5 — Page content updates (via crux w updates)

Recommended cadences:
  Daily   — review-prs (review new session logs, catch recurring issues)
  Weekly  — full report (triage issues, propagate learnings)
  Monthly — detect-cruft + cleanup (deep analysis, file splitting, dead code)

Examples:
  crux sys maintain                          Full maintenance report
  crux sys maintain status                   Show when maintenance last ran
  crux sys maintain review-prs               Just review PRs + session logs
  crux sys maintain triage-issues            Just triage GitHub issues
  crux sys maintain triage-linear            Just triage Linear queue
  crux sys maintain detect-cruft             Just find codebase cruft
  crux sys maintain fix-chains               Detect fix chains (feature → fix → fix)
  crux sys maintain fix-chains --json        JSON output for trend tracking
  crux sys maintain health-snapshot          Code health metrics snapshot
  crux sys maintain health-snapshot --json   JSON output for trend tracking
  crux sys maintain review-prs --since=2026-02-10  Override start date
  crux sys maintain --json                   Full report as JSON

Slash command:
  /maintain   Claude Code command for interactive maintenance sessions
              (uses this data + AI judgment for prioritization and execution)
`;
}
