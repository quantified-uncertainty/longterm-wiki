/**
 * Maintain Command Handlers
 *
 * Periodic maintenance: review merged PRs, triage issues, detect cruft.
 * Produces structured reports that the /maintain Claude command acts on.
 *
 * Usage:
 *   crux maintain                    Run full report (all signals)
 *   crux maintain review-prs         Review PRs + session logs since last run
 *   crux maintain triage-issues      Triage open GitHub issues
 *   crux maintain detect-cruft       Find dead code, TODOs, large files
 *   crux maintain status             Show last maintenance run info
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { createLogger } from '../lib/output.ts';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import type { CommandResult } from '../lib/cli.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MergedPR {
  number: number;
  title: string;
  mergedAt: string;
  branch: string;
  author: string;
}

interface SessionLogEntry {
  date: string;
  branch: string;
  title: string;
  whatWasDone: string;
  pages: string[];
  issues: string[];
  learnings: string[];
}

interface OpenIssue {
  number: number;
  title: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  body: string;
}

interface CruftItem {
  type: 'orphan-file' | 'todo' | 'large-file' | 'commented-code';
  path: string;
  line?: number;
  detail: string;
}

interface CommandOptions {
  ci?: boolean;
  json?: boolean;
  since?: string;
  limit?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LAST_RUN_FILE = join(PROJECT_ROOT, '.claude/maintain-last-run.txt');
const SESSIONS_DIR = join(PROJECT_ROOT, '.claude/sessions');
const REPO = 'quantified-uncertainty/longterm-wiki';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getGitHubToken(): string {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN not set. Required for GitHub API calls.');
  }
  return token;
}

function githubApi(endpoint: string, method = 'GET', body?: object): unknown {
  const token = getGitHubToken();
  const url = `https://api.github.com${endpoint}`;
  const args = [
    '-s', '-X', method,
    '-H', `Authorization: token ${token}`,
    '-H', 'Accept: application/vnd.github+json',
  ];
  if (body) {
    args.push('-d', JSON.stringify(body));
  }
  args.push(url);

  const result = execSync(`curl ${args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}`, {
    encoding: 'utf-8',
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(result);
}

function getLastRunDate(): string {
  if (existsSync(LAST_RUN_FILE)) {
    return readFileSync(LAST_RUN_FILE, 'utf-8').trim();
  }
  // Default: 7 days ago
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString().slice(0, 10);
}

function daysBetween(dateStr: string): number {
  const now = new Date();
  const then = new Date(dateStr);
  return Math.floor((now.getTime() - then.getTime()) / (1000 * 60 * 60 * 24));
}

// ---------------------------------------------------------------------------
// Session log parser (lightweight, for maintenance use)
// ---------------------------------------------------------------------------

function parseSessionLog(content: string): SessionLogEntry | null {
  const headerMatch = content.match(/^## (\d{4}-\d{2}-\d{2}) \| ([^\|]+?) \| (.+)/m);
  if (!headerMatch) return null;

  const [, date, branch, title] = headerMatch;

  // Extract "What was done"
  const whatMatch = content.match(/\*\*What was done:\*\*\s*(.+?)(?:\n\n|\n\*\*)/s);
  const whatWasDone = whatMatch ? whatMatch[1].trim() : '';

  // Extract "Pages"
  const pagesMatch = content.match(/\*\*Pages:\*\*\s*(.+?)(?:\n\n|\n\*\*)/s);
  const pages = pagesMatch
    ? pagesMatch[1].split(',').map(p => p.trim()).filter(p => /^[a-z0-9][a-z0-9-]*$/.test(p))
    : [];

  // Extract "Issues encountered"
  const issuesMatch = content.match(/\*\*Issues encountered:\*\*\s*([\s\S]+?)(?:\n\*\*|\n##|$)/);
  const issuesRaw = issuesMatch ? issuesMatch[1].trim() : '';
  const issues = issuesRaw === 'None' || issuesRaw === '- None'
    ? []
    : issuesRaw.split('\n').map(l => l.replace(/^-\s*/, '').trim()).filter(Boolean);

  // Extract "Learnings/notes"
  const learningsMatch = content.match(/\*\*Learnings\/notes:\*\*\s*([\s\S]+?)(?:\n##|$)/);
  const learningsRaw = learningsMatch ? learningsMatch[1].trim() : '';
  const learnings = learningsRaw === 'None' || learningsRaw === '- None'
    ? []
    : learningsRaw.split('\n').map(l => l.replace(/^-\s*/, '').trim()).filter(Boolean);

  return { date, branch: branch.trim(), title: title.trim(), whatWasDone, pages, issues, learnings };
}

function loadSessionLogsSince(since: string): SessionLogEntry[] {
  if (!existsSync(SESSIONS_DIR)) return [];

  const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.md')).sort();
  const entries: SessionLogEntry[] = [];

  for (const file of files) {
    // Extract date from filename (YYYY-MM-DD_suffix.md)
    const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!dateMatch) continue;
    if (dateMatch[1] < since) continue;

    const content = readFileSync(join(SESSIONS_DIR, file), 'utf-8');
    const entry = parseSessionLog(content);
    if (entry) entries.push(entry);
  }

  return entries;
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
  const since = options.since || getLastRunDate();

  let output = '';
  output += `${c.bold}${c.blue}PR & Session Log Review${c.reset}\n`;
  output += `${c.dim}Since: ${since}${c.reset}\n\n`;

  // Fetch merged PRs
  const prsData = githubApi(
    `/repos/${REPO}/pulls?state=closed&sort=updated&direction=desc&per_page=50`
  ) as Array<Record<string, unknown>>;

  const mergedPrs: MergedPR[] = [];
  for (const p of prsData) {
    const mergedAt = p.merged_at as string | null;
    if (mergedAt && mergedAt.slice(0, 10) >= since) {
      mergedPrs.push({
        number: p.number as number,
        title: p.title as string,
        mergedAt: mergedAt.slice(0, 10),
        branch: (p.head as Record<string, unknown>).ref as string,
        author: ((p.user as Record<string, unknown>)?.login as string) || '?',
      });
    }
  }

  output += `${c.bold}Merged PRs: ${mergedPrs.length}${c.reset}\n`;
  for (const pr of mergedPrs) {
    output += `  #${pr.number}: ${pr.title} (${pr.mergedAt}) [${pr.branch}]\n`;
  }
  output += '\n';

  // Load session logs for the same period
  const sessions = loadSessionLogsSince(since);
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

    // Find recurring issues (same text appearing in 2+ sessions)
    const issueCounts: Record<string, number> = {};
    for (const { issue } of allIssues) {
      // Normalize for comparison
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
  const multiEditPages = Object.entries(pageEdits).filter(([, sessions]) => sessions.length >= 2);
  if (multiEditPages.length > 0) {
    output += `${c.bold}${c.yellow}Pages Edited by Multiple Sessions:${c.reset}\n`;
    for (const [page, sessions] of multiEditPages) {
      output += `  ${page}: ${sessions.length} sessions\n`;
      for (const s of sessions) {
        output += `    ${c.dim}- ${s}${c.reset}\n`;
      }
    }
    output += '\n';
  }

  if (options.json || options.ci) {
    return {
      output: JSON.stringify({ mergedPrs, sessions, allIssues, allLearnings, multiEditPages }, null, 2),
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
  const since = options.since || getLastRunDate();

  let output = '';
  output += `${c.bold}${c.blue}GitHub Issue Triage${c.reset}\n\n`;

  // Fetch open issues
  const issuesData = githubApi(
    `/repos/${REPO}/issues?state=open&per_page=100&sort=updated&direction=desc`
  ) as Array<Record<string, unknown>>;

  const openIssues: OpenIssue[] = [];
  for (const i of issuesData) {
    if ('pull_request' in i) continue; // Skip PRs
    openIssues.push({
      number: i.number as number,
      title: i.title as string,
      labels: ((i.labels as Array<Record<string, string>>) || []).map(l => l.name),
      createdAt: (i.created_at as string).slice(0, 10),
      updatedAt: (i.updated_at as string).slice(0, 10),
      body: ((i.body as string) || '').slice(0, 500),
    });
  }

  // Fetch recent merged PRs to cross-reference
  const prsData = githubApi(
    `/repos/${REPO}/pulls?state=closed&sort=updated&direction=desc&per_page=50`
  ) as Array<Record<string, unknown>>;

  const recentPrTitles: string[] = [];
  for (const p of prsData) {
    if (p.merged_at) {
      recentPrTitles.push((p.title as string).toLowerCase());
    }
  }

  // Load session logs to check for issue references
  const sessions = loadSessionLogsSince(since);
  const sessionText = sessions.map(s =>
    `${s.whatWasDone} ${s.issues.join(' ')} ${s.learnings.join(' ')}`
  ).join(' ').toLowerCase();

  // Categorize issues
  const categories: Record<string, Array<OpenIssue & { reason: string }>> = {
    'potentially-resolved': [],
    'stale': [],
    'actionable': [],
    'keep': [],
  };

  for (const issue of openIssues) {
    const daysInactive = daysBetween(issue.updatedAt);
    const titleLower = issue.title.toLowerCase();
    const issueNum = `#${issue.number}`;

    // Check if a recent PR title references this issue
    const referencedInPr = recentPrTitles.some(t =>
      t.includes(issueNum) || t.includes(titleLower.slice(0, 30))
    );
    // Check if session logs mention this issue
    const referencedInSession = sessionText.includes(issueNum) ||
      sessionText.includes(titleLower.slice(0, 30));

    if (referencedInPr || referencedInSession) {
      categories['potentially-resolved'].push({
        ...issue,
        reason: referencedInPr ? 'Referenced in a recent PR' : 'Referenced in a session log',
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
  output += `${c.bold}Open Issues: ${openIssues.length}${c.reset}\n\n`;

  if (categories['potentially-resolved'].length > 0) {
    output += `${c.bold}${c.green}Potentially Resolved (${categories['potentially-resolved'].length}):${c.reset}\n`;
    output += `${c.dim}These issues may have been addressed by recent PRs. Verify and close.${c.reset}\n`;
    for (const issue of categories['potentially-resolved']) {
      output += `  ${c.green}#${issue.number}${c.reset}: ${issue.title}\n`;
      output += `    ${c.dim}${issue.reason}${c.reset}\n`;
    }
    output += '\n';
  }

  if (categories['stale'].length > 0) {
    output += `${c.bold}${c.yellow}Stale (${categories['stale'].length}):${c.reset}\n`;
    output += `${c.dim}No activity for 30+ days. Consider closing or updating.${c.reset}\n`;
    for (const issue of categories['stale']) {
      output += `  ${c.yellow}#${issue.number}${c.reset}: ${issue.title} (${issue.reason})\n`;
    }
    output += '\n';
  }

  if (categories['actionable'].length > 0) {
    output += `${c.bold}${c.cyan}Actionable (${categories['actionable'].length}):${c.reset}\n`;
    for (const issue of categories['actionable']) {
      output += `  ${c.cyan}#${issue.number}${c.reset}: ${issue.title}\n`;
    }
    output += '\n';
  }

  if (categories['keep'].length > 0) {
    output += `${c.bold}Keep (${categories['keep'].length}):${c.reset}\n`;
    for (const issue of categories['keep']) {
      output += `  #${issue.number}: ${issue.title}\n`;
    }
    output += '\n';
  }

  if (options.json || options.ci) {
    return { output: JSON.stringify(categories, null, 2), exitCode: 0 };
  }

  return { output, exitCode: 0 };
}

/**
 * Detect codebase cruft: dead code, stale TODOs, large files.
 */
async function detectCruft(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;
  const limit = parseInt(options.limit || '30', 10);

  let output = '';
  output += `${c.bold}${c.blue}Codebase Cruft Detection${c.reset}\n\n`;

  const items: CruftItem[] = [];

  // 1. Find TODO/FIXME/HACK/XXX comments
  try {
    const todoOutput = execSync(
      `grep -rn 'TODO\\|FIXME\\|HACK\\|XXX' crux/ app/src/ --include='*.ts' --include='*.tsx' --include='*.mjs' 2>/dev/null || true`,
      { encoding: 'utf-8', cwd: PROJECT_ROOT, timeout: 15_000, maxBuffer: 5 * 1024 * 1024 }
    );
    for (const line of todoOutput.split('\n').filter(Boolean)) {
      const match = line.match(/^([^:]+):(\d+):(.+)$/);
      if (match) {
        items.push({
          type: 'todo',
          path: match[1],
          line: parseInt(match[2], 10),
          detail: match[3].trim(),
        });
      }
    }
  } catch { /* grep may fail if no matches */ }

  // 2. Find large files (>400 lines)
  try {
    const wcOutput = execSync(
      `find crux/ app/src/ -name '*.ts' -o -name '*.tsx' -o -name '*.mjs' | xargs wc -l 2>/dev/null | sort -rn | head -30`,
      { encoding: 'utf-8', cwd: PROJECT_ROOT, timeout: 15_000, maxBuffer: 5 * 1024 * 1024 }
    );
    for (const line of wcOutput.split('\n').filter(Boolean)) {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (match && match[2] !== 'total') {
        const lineCount = parseInt(match[1], 10);
        if (lineCount > 400) {
          items.push({
            type: 'large-file',
            path: match[2],
            detail: `${lineCount} lines`,
          });
        }
      }
    }
  } catch { /* may fail */ }

  // 3. Find commented-out code blocks (3+ consecutive comment lines)
  try {
    const commentOutput = execSync(
      `grep -rn '^\s*//.*[;{}()\[\]]' crux/ app/src/ --include='*.ts' --include='*.tsx' 2>/dev/null | head -50 || true`,
      { encoding: 'utf-8', cwd: PROJECT_ROOT, timeout: 15_000, maxBuffer: 5 * 1024 * 1024 }
    );
    // Group consecutive lines by file
    const byFile: Record<string, number[]> = {};
    for (const line of commentOutput.split('\n').filter(Boolean)) {
      const match = line.match(/^([^:]+):(\d+):/);
      if (match) {
        const file = match[1];
        const lineNum = parseInt(match[2], 10);
        if (!byFile[file]) byFile[file] = [];
        byFile[file].push(lineNum);
      }
    }
    // Find runs of 3+ consecutive commented lines
    for (const [file, lines] of Object.entries(byFile)) {
      lines.sort((a, b) => a - b);
      let runStart = lines[0];
      let runLen = 1;
      for (let i = 1; i < lines.length; i++) {
        if (lines[i] === lines[i - 1] + 1) {
          runLen++;
        } else {
          if (runLen >= 3) {
            items.push({
              type: 'commented-code',
              path: file,
              line: runStart,
              detail: `${runLen} consecutive commented-out code lines`,
            });
          }
          runStart = lines[i];
          runLen = 1;
        }
      }
      if (runLen >= 3) {
        items.push({
          type: 'commented-code',
          path: file,
          line: runStart,
          detail: `${runLen} consecutive commented-out code lines`,
        });
      }
    }
  } catch { /* may fail */ }

  // Report
  const byType: Record<string, CruftItem[]> = {};
  for (const item of items) {
    if (!byType[item.type]) byType[item.type] = [];
    byType[item.type].push(item);
  }

  const typeLabels: Record<string, { label: string; color: string }> = {
    'todo': { label: 'TODO/FIXME/HACK Comments', color: c.yellow },
    'large-file': { label: 'Large Files (>400 lines)', color: c.cyan },
    'orphan-file': { label: 'Orphan Files (not imported)', color: c.red },
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
    const daysAgo = daysBetween(lastRun);
    const urgency = daysAgo > 7 ? c.red : daysAgo > 3 ? c.yellow : c.green;
    output += `Last maintenance run: ${urgency}${lastRun} (${daysAgo} days ago)${c.reset}\n`;
  } else {
    output += `${c.yellow}No maintenance runs recorded yet.${c.reset}\n`;
    output += `${c.dim}Run \`crux maintain\` to perform the first sweep.${c.reset}\n`;
  }

  // Count session logs since last run
  const since = lastRun || '2000-01-01';
  const sessions = loadSessionLogsSince(since);
  output += `Session logs since last run: ${sessions.length}\n`;

  // Count issues with encountered problems
  const sessionsWithIssues = sessions.filter(s => s.issues.length > 0);
  if (sessionsWithIssues.length > 0) {
    output += `${c.yellow}Sessions with issues: ${sessionsWithIssues.length}${c.reset}\n`;
  }

  output += '\n';
  output += `${c.dim}Run \`crux maintain\` for a full report, or individual subcommands:${c.reset}\n`;
  output += `${c.dim}  crux maintain review-prs       Review merged PRs + session logs${c.reset}\n`;
  output += `${c.dim}  crux maintain triage-issues     Triage open GitHub issues${c.reset}\n`;
  output += `${c.dim}  crux maintain detect-cruft      Find dead code, TODOs, large files${c.reset}\n`;

  return { output, exitCode: 0 };
}

/**
 * Run all maintenance signals and produce a combined report.
 */
async function report(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  let output = '';
  output += `${c.bold}${c.blue}${'═'.repeat(60)}${c.reset}\n`;
  output += `${c.bold}${c.blue}  Maintenance Sweep Report${c.reset}\n`;
  output += `${c.bold}${c.blue}${'═'.repeat(60)}${c.reset}\n\n`;

  // Run all three sub-reports
  const prResult = await reviewPrs(args, { ...options, json: false });
  const issueResult = await triageIssues(args, { ...options, json: false });
  const cruftResult = await detectCruft(args, { ...options, json: false });

  output += prResult.output;
  output += `${c.dim}${'─'.repeat(60)}${c.reset}\n\n`;
  output += issueResult.output;
  output += `${c.dim}${'─'.repeat(60)}${c.reset}\n\n`;
  output += cruftResult.output;

  // Priority summary
  output += `${c.bold}${c.blue}${'═'.repeat(60)}${c.reset}\n`;
  output += `${c.bold}Suggested Priority Order:${c.reset}\n\n`;
  output += `  ${c.red}P0${c.reset} — Fix broken things (CI failures, blocking errors)\n`;
  output += `  ${c.yellow}P1${c.reset} — Close resolved issues (quick wins)\n`;
  output += `  ${c.cyan}P2${c.reset} — Propagate learnings to common-issues.md / rules\n`;
  output += `  P3 — Fix actionable GitHub issues\n`;
  output += `  ${c.dim}P4 — Cruft cleanup (dead code, TODOs)${c.reset}\n`;
  output += `  ${c.dim}P5 — Page content updates (delegate to crux updates)${c.reset}\n`;
  output += '\n';

  // Update last-run timestamp
  writeFileSync(LAST_RUN_FILE, new Date().toISOString().slice(0, 10) + '\n');
  output += `${c.dim}Updated last-run timestamp: ${new Date().toISOString().slice(0, 10)}${c.reset}\n`;

  return { output, exitCode: 0 };
}

/**
 * Mark the last maintenance run timestamp (useful for manual resets).
 */
async function markRun(_args: string[], _options: CommandOptions): Promise<CommandResult> {
  const date = new Date().toISOString().slice(0, 10);
  writeFileSync(LAST_RUN_FILE, date + '\n');
  return { output: `Maintenance last-run set to ${date}`, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Command registry
// ---------------------------------------------------------------------------

export const commands = {
  default: report,
  report,
  'review-prs': reviewPrs,
  'triage-issues': triageIssues,
  'detect-cruft': detectCruft,
  status,
  'mark-run': markRun,
};

export function getHelp(): string {
  return `
Maintain Domain - Periodic maintenance and housekeeping

Gathers signals from PRs, session logs, GitHub issues, and codebase
analysis. Produces prioritized reports and helps with cleanup.

Commands:
  report          Run full maintenance report (default)
  review-prs      Review merged PRs and session logs since last run
  triage-issues   Triage open GitHub issues for staleness/resolution
  detect-cruft    Find dead code, TODOs, large files, commented-out code
  status          Show last maintenance run info
  mark-run        Update the last-run timestamp without running a report

Options:
  --since=DATE    Override the start date (default: last run or 7 days ago)
  --limit=N       Max items per category in cruft report (default: 30)
  --json          Output as JSON
  --ci            JSON output for CI pipelines

Priority order for maintenance work:
  P0 — Broken things (CI failures, blocking errors)
  P1 — Close resolved issues (quick wins)
  P2 — Propagate learnings (common-issues.md, rules)
  P3 — Actionable GitHub issues
  P4 — Cruft cleanup (dead code, TODOs)
  P5 — Page content updates (via crux updates)

Examples:
  crux maintain                          Full maintenance report
  crux maintain status                   Show when maintenance last ran
  crux maintain review-prs               Just review PRs + session logs
  crux maintain triage-issues            Just triage GitHub issues
  crux maintain detect-cruft             Just find codebase cruft
  crux maintain review-prs --since=2026-02-10  Override start date
  crux maintain --json                   Full report as JSON

Slash command:
  /maintain   Claude Code command for interactive maintenance sessions
              (uses this data + AI judgment for prioritization and execution)
`;
}
