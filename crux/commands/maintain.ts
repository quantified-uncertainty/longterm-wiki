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
import { githubApi, REPO } from '../lib/github.ts';
import { type CommandResult, parseIntOpt } from '../lib/cli.ts';

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

interface GitHubIssue {
  number: number;
  title: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  body: string;
}

interface CruftItem {
  type: 'todo' | 'large-file' | 'commented-code';
  path: string;
  line?: number;
  detail: string;
}

type TriageCategory = 'potentially-resolved' | 'stale' | 'actionable' | 'keep';

interface CommandOptions {
  ci?: boolean;
  json?: boolean;
  since?: string;
  limit?: string;
  [key: string]: unknown;
}

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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LAST_RUN_FILE = join(PROJECT_ROOT, '.claude/maintain-last-run.txt');
const SESSIONS_DIR = join(PROJECT_ROOT, '.claude/sessions');
const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  // Validate it's an actual date (regex alone allows 2026-99-99)
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
// Session log parser
//
// Note: The canonical parser is in apps/web/scripts/lib/session-log-parser.mjs.
// This version extracts additional fields (issues, learnings) needed for
// maintenance analysis. Keep section terminators aligned with the canonical
// parser (includes \n--- as a terminator).
// ---------------------------------------------------------------------------

/** Terminator pattern shared with canonical parser — matches \n\n, \n**, or \n--- */
const SECTION_END = /(?:\n\n|\n\*\*|\n---)/;

function parseSessionLog(content: string): SessionLogEntry | null {
  const headerMatch = content.match(/^## (\d{4}-\d{2}-\d{2}) \| ([^\|]+?) \| (.+)/m);
  if (!headerMatch) return null;

  const [, date, branch, title] = headerMatch;

  // Extract "What was done" — aligned with canonical parser terminators
  const whatMatch = content.match(new RegExp(`\\*\\*What was done:\\*\\*\\s*(.+?)${SECTION_END.source}`, 's'));
  const whatWasDone = whatMatch ? whatMatch[1].trim() : '';

  // Extract "Pages" — aligned with canonical parser terminators
  const pagesMatch = content.match(new RegExp(`\\*\\*Pages:\\*\\*\\s*(.+?)${SECTION_END.source}`, 's'));
  const pages = pagesMatch
    ? pagesMatch[1].split(',').map(p => p.trim()).filter(p => /^[a-z0-9][a-z0-9-]*$/.test(p))
    : [];

  // Extract "Issues encountered"
  const issuesMatch = content.match(/\*\*Issues encountered:\*\*\s*([\s\S]+?)(?:\n\*\*|\n##|\n---|$)/);
  const issuesRaw = issuesMatch ? issuesMatch[1].trim() : '';
  const issues = (!issuesRaw || issuesRaw === 'None' || issuesRaw === '- None')
    ? []
    : issuesRaw.split('\n').map(l => l.replace(/^-\s*/, '').trim()).filter(Boolean);

  // Extract "Learnings/notes"
  const learningsMatch = content.match(/\*\*Learnings\/notes:\*\*\s*([\s\S]+?)(?:\n##|\n---|$)/);
  const learningsRaw = learningsMatch ? learningsMatch[1].trim() : '';
  const learnings = (!learningsRaw || learningsRaw === 'None' || learningsRaw === '- None')
    ? []
    : learningsRaw.split('\n').map(l => l.replace(/^-\s*/, '').trim()).filter(Boolean);

  return { date, branch: branch.trim(), title: title.trim(), whatWasDone, pages, issues, learnings };
}

function loadSessionLogsSince(since: string): SessionLogEntry[] {
  if (!existsSync(SESSIONS_DIR)) return [];

  const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.md')).sort();
  const entries: SessionLogEntry[] = [];

  for (const file of files) {
    const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!dateMatch || dateMatch[1] < since) continue;

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
    if (i.pull_request) continue; // Skip PRs
    openIssues.push({
      number: i.number,
      title: i.title,
      labels: (i.labels || []).map(l => l.name),
      createdAt: i.created_at.slice(0, 10),
      updatedAt: i.updated_at.slice(0, 10),
      body: (i.body || '').slice(0, 500),
    });
  }

  // Fetch recent merged PRs to cross-reference
  const prsData = await githubApi<GitHubPullResponse[]>(
    `/repos/${REPO}/pulls?state=closed&sort=updated&direction=desc&per_page=100`
  );

  // Build set of issue numbers explicitly closed by merged PRs via "closes/fixes/resolves #N"
  const mergedPrs = (Array.isArray(prsData) ? prsData : []).filter(p => p.merged_at);
  const explicitlyClosedByPr = new Map<number, string>(); // issueNum → PR title
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

  for (const issue of openIssues) {
    const daysInactive = daysSince(issue.updatedAt);

    // High-confidence signal: merged PR body explicitly closes this issue number
    const closingPr = explicitlyClosedByPr.get(issue.number);

    if (closingPr) {
      categories['potentially-resolved'].push({
        ...issue,
        reason: `Explicitly closed by merged ${closingPr}`,
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

  const categoryMeta: Record<TriageCategory, { label: string; color: string; desc: string }> = {
    'potentially-resolved': {
      label: 'Potentially Resolved',
      color: c.green,
      desc: 'A merged PR explicitly closes this issue. Safe to close — verify and confirm.',
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
 * Detect codebase cruft: stale TODOs, large files, commented-out code.
 */
async function detectCruft(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;
  const limit = parseIntOpt(options.limit, 30);

  let output = '';
  output += `${c.bold}${c.blue}Codebase Cruft Detection${c.reset}\n\n`;

  const items: CruftItem[] = [];
  const execOpts = { encoding: 'utf-8' as const, cwd: PROJECT_ROOT, timeout: 15_000, maxBuffer: 5 * 1024 * 1024 };

  // 1. Find TODO/FIXME/HACK/XXX comments (excluding test files and this file)
  try {
    const todoOutput = execSync(
      `grep -rn 'TODO\\|FIXME\\|HACK\\|XXX' crux/ apps/web/src/ --include='*.ts' --include='*.tsx' --include='*.mjs' 2>/dev/null || true`,
      execOpts
    );
    for (const line of todoOutput.split('\n').filter(Boolean)) {
      const match = line.match(/^([^:]+):(\d+):(.+)$/);
      if (match) {
        // Skip test files and this file's own grep patterns
        if (match[1].includes('.test.') || match[1].includes('maintain.ts')) continue;
        // Skip lines that are defining TODO detection patterns (rules, validators)
        if (match[3].includes('pattern:') || match[3].includes('Pattern') || match[3].includes("'TODO")) continue;
        items.push({
          type: 'todo',
          path: match[1],
          line: parseInt(match[2], 10),
          detail: match[3].trim(),
        });
      }
    }
  } catch { /* grep may return non-zero if no matches */ }

  // 2. Find large files (>400 lines)
  try {
    const wcOutput = execSync(
      `find crux/ apps/web/src/ \\( -name '*.ts' -o -name '*.tsx' -o -name '*.mjs' \\) ! -name '*.test.*' ! -name '*.d.ts' | xargs wc -l 2>/dev/null | sort -rn | head -30`,
      execOpts
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

  // 3. Find commented-out code blocks (3+ consecutive comment lines with code syntax)
  try {
    const commentOutput = execSync(
      `grep -rn '^\\s*//.*[;{}()\\[\\]]' crux/ apps/web/src/ --include='*.ts' --include='*.tsx' 2>/dev/null | head -100 || true`,
      execOpts
    );
    const byFile: Record<string, number[]> = {};
    for (const line of commentOutput.split('\n').filter(Boolean)) {
      const match = line.match(/^([^:]+):(\d+):/);
      if (match) {
        if (match[1].includes('.test.')) continue;
        const file = match[1];
        const lineNum = parseInt(match[2], 10);
        if (!byFile[file]) byFile[file] = [];
        byFile[file].push(lineNum);
      }
    }
    for (const [file, lines] of Object.entries(byFile)) {
      lines.sort((a, b) => a - b);
      let runStart = lines[0];
      let runLen = 1;
      for (let i = 1; i < lines.length; i++) {
        if (lines[i] === lines[i - 1] + 1) {
          runLen++;
        } else {
          if (runLen >= 3) {
            items.push({ type: 'commented-code', path: file, line: runStart, detail: `${runLen} consecutive commented-out code lines` });
          }
          runStart = lines[i];
          runLen = 1;
        }
      }
      if (runLen >= 3) {
        items.push({ type: 'commented-code', path: file, line: runStart, detail: `${runLen} consecutive commented-out code lines` });
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
    output += `${c.dim}Run \`crux maintain\` to perform the first sweep.${c.reset}\n`;
  }

  // Count session logs since last run
  const since = lastRun || '2000-01-01';
  const sessions = loadSessionLogsSince(since);
  output += `Session logs since last run: ${sessions.length}\n`;

  const sessionsWithIssues = sessions.filter(s => s.issues.length > 0);
  if (sessionsWithIssues.length > 0) {
    output += `${c.yellow}Sessions with issues: ${sessionsWithIssues.length}${c.reset}\n`;
  }

  output += '\n';
  output += `${c.bold}Recommended cadences:${c.reset}\n`;
  output += `  ${c.dim}Daily:   crux maintain review-prs   (review new PRs + session logs)${c.reset}\n`;
  output += `  ${c.dim}Weekly:  crux maintain               (full sweep + issue triage)${c.reset}\n`;
  output += `  ${c.dim}Monthly: crux maintain detect-cruft  (deep cruft analysis + cleanup)${c.reset}\n`;

  return { output, exitCode: 0 };
}

/**
 * Run all maintenance signals and produce a combined report.
 */
async function report(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  // For JSON mode, collect structured data from all sub-reports
  if (options.json || options.ci) {
    const prResult = await reviewPrs(args, { ...options, json: true });
    const issueResult = await triageIssues(args, { ...options, json: true });
    const cruftResult = await detectCruft(args, { ...options, json: true });

    // Guard against sub-commands failing with non-JSON error output
    if (prResult.exitCode !== 0 || issueResult.exitCode !== 0 || cruftResult.exitCode !== 0) {
      const errors = [
        prResult.exitCode !== 0 && `PR review: ${prResult.output.slice(0, 200)}`,
        issueResult.exitCode !== 0 && `Issue triage: ${issueResult.output.slice(0, 200)}`,
        cruftResult.exitCode !== 0 && `Cruft detection: ${cruftResult.output.slice(0, 200)}`,
      ].filter(Boolean);
      return { output: `One or more sub-reports failed:\n${errors.join('\n')}`, exitCode: 1 };
    }

    const combined = {
      timestamp: new Date().toISOString(),
      prReview: JSON.parse(prResult.output),
      issueTriage: JSON.parse(issueResult.output),
      cruftDetection: JSON.parse(cruftResult.output),
    };

    writeFileSync(LAST_RUN_FILE, new Date().toISOString().slice(0, 10) + '\n');
    return { output: JSON.stringify(combined, null, 2), exitCode: 0 };
  }

  let output = '';
  output += `${c.bold}${c.blue}${'═'.repeat(60)}${c.reset}\n`;
  output += `${c.bold}${c.blue}  Maintenance Sweep Report${c.reset}\n`;
  output += `${c.bold}${c.blue}${'═'.repeat(60)}${c.reset}\n\n`;

  // Run all three sub-reports
  const prResult = await reviewPrs(args, options);
  const issueResult = await triageIssues(args, options);
  const cruftResult = await detectCruft(args, options);

  output += prResult.output;
  output += `${c.dim}${'─'.repeat(60)}${c.reset}\n\n`;
  output += issueResult.output;
  output += `${c.dim}${'─'.repeat(60)}${c.reset}\n\n`;
  output += cruftResult.output;

  // Priority summary
  output += `${c.bold}${c.blue}${'═'.repeat(60)}${c.reset}\n`;
  output += `${c.bold}Suggested Action Plan:${c.reset}\n\n`;
  output += `  ${c.red}P0${c.reset} — Fix broken things (CI failures, blocking validation errors)\n`;
  output += `  ${c.yellow}P1${c.reset} — Close resolved issues (verify + close issues fixed by recent PRs)\n`;
  output += `  ${c.cyan}P2${c.reset} — Propagate learnings (add recurring issues to common-issues.md/rules)\n`;
  output += `  P3 — Work actionable issues (fix small issues; file new issues for larger tasks)\n`;
  output += `  ${c.dim}P4 — Cruft cleanup (dead code, stale TODOs, file splitting)${c.reset}\n`;
  output += `  ${c.dim}P5 — Page content updates (delegate to \`crux updates run\`)${c.reset}\n`;
  output += '\n';

  // Update last-run timestamp
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(LAST_RUN_FILE, today + '\n');
  output += `${c.dim}Updated last-run timestamp: ${today}${c.reset}\n`;

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
  status          Show last maintenance run info and recommended cadences
  mark-run        Update the last-run timestamp without running a report

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
  P5 — Page content updates (via crux updates)

Recommended cadences:
  Daily   — review-prs (review new session logs, catch recurring issues)
  Weekly  — full report (triage issues, propagate learnings)
  Monthly — detect-cruft + cleanup (deep analysis, file splitting, dead code)

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
