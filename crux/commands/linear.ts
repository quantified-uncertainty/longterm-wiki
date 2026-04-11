/**
 * Linear Command Handlers
 *
 * Track Claude Code work on Linear issues: list, search, comment,
 * signal start/done. Mirrors `crux gh issues` for Linear.
 *
 * Usage:
 *   crux linear view <QUA-NNN>          Show full issue + comments
 *   crux linear search <query>          Search QUA team issues
 *   crux linear comment <QUA-NNN> <msg> Post a comment
 *   crux linear start <QUA-NNN>         Move to In Progress + start comment
 *   crux linear done <QUA-NNN> --pr=URL Move to In Review + done comment
 *   crux linear states-list                    Print current QUA team workflow states
 *   crux linear parse <string>                 Extract a Linear ID from a string (debug)
 */

import { readFileSync } from 'fs';
import { createLogger } from '../lib/output.ts';
import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';
import {
  commentOnIssue,
  getComments,
  getIssue,
  listReadyIssues,
  rankReadyIssues,
  searchIssues,
  updateIssueState,
} from '../lib/linear/issues.ts';
import { fetchRemoteWorkflowStates } from '../lib/linear/workflow-states.ts';
import { parseLinearId } from '../lib/linear/parse-id.ts';
import { currentBranch } from '../lib/session/session-checklist.ts';

interface CommandOptions extends BaseOptions {
  ci?: boolean;
  json?: boolean;
  pr?: string;
  limit?: string;
  bodyFile?: string;
}

function readBodyFlag(path: string | undefined): string | null {
  if (!path) return null;
  try {
    return readFileSync(path, 'utf-8');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Error reading file ${path}: ${msg}`);
  }
}

function priorityLabel(priority: number): string {
  return ['none', 'urgent', 'high', 'medium', 'low'][priority] ?? `P${priority}`;
}

async function view(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  const id = parseLinearId(args[0]);
  if (!id) {
    return {
      output: `${c.red}Usage: crux linear view <QUA-NNN>${c.reset}\n`,
      exitCode: 1,
    };
  }

  const issue = await getIssue(id);
  if (!issue) {
    return { output: `${c.red}Issue ${id} not found${c.reset}\n`, exitCode: 1 };
  }

  const comments = await getComments(id, 10);

  if (options.json) {
    return {
      output: JSON.stringify({ issue, comments }, null, 2) + '\n',
      exitCode: 0,
    };
  }

  let out = '';
  out += `${c.bold}${issue.identifier}${c.reset} ${c.cyan}${issue.title}${c.reset}\n`;
  out += `  ${c.dim}state:${c.reset} ${issue.state.name}  ${c.dim}priority:${c.reset} ${priorityLabel(issue.priority)}\n`;
  if (issue.parent) {
    out += `  ${c.dim}parent:${c.reset} ${issue.parent.identifier} — ${issue.parent.title}\n`;
  }
  if (issue.project) {
    out += `  ${c.dim}project:${c.reset} ${issue.project.name}\n`;
  }
  out += `  ${c.dim}url:${c.reset} ${issue.url}\n`;
  if (issue.description) {
    out += `\n${issue.description.slice(0, 1000)}${issue.description.length > 1000 ? '\n…(truncated)' : ''}\n`;
  }
  if (comments.length > 0) {
    out += `\n${c.bold}Comments (${comments.length}):${c.reset}\n`;
    for (const cm of comments) {
      const who = cm.user?.name ?? 'unknown';
      const when = cm.createdAt.slice(0, 10);
      out += `  ${c.dim}[${when}]${c.reset} ${c.yellow}${who}${c.reset}: ${cm.body.slice(0, 200).replace(/\n/g, ' ')}\n`;
    }
  }
  return { output: out, exitCode: 0 };
}

async function search(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  const query = args.filter((a) => !a.startsWith('--')).join(' ').trim();
  if (!query) {
    return {
      output: `${c.red}Usage: crux linear search <query>${c.reset}\n`,
      exitCode: 1,
    };
  }

  const limit = options.limit ? parseInt(options.limit, 10) : 20;
  const results = await searchIssues(query, limit);

  if (options.json) {
    return { output: JSON.stringify(results, null, 2) + '\n', exitCode: 0 };
  }

  if (results.length === 0) {
    return { output: `${c.dim}No matches for "${query}"${c.reset}\n`, exitCode: 0 };
  }

  let out = `${c.bold}${results.length} match(es) for "${query}":${c.reset}\n`;
  for (const r of results) {
    out += `  ${c.cyan}${r.identifier}${c.reset} [${r.state.name}] ${priorityLabel(r.priority)} — ${r.title}\n`;
  }
  return { output: out, exitCode: 0 };
}

async function comment(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  const id = parseLinearId(args[0]);
  if (!id) {
    return {
      output: `${c.red}Usage: crux linear comment <QUA-NNN> <message>${c.reset}\n`,
      exitCode: 1,
    };
  }

  const bodyFromFile = readBodyFlag(options.bodyFile);
  const body = bodyFromFile ?? args.slice(1).filter((a) => !a.startsWith('--')).join(' ').trim();
  if (!body) {
    return {
      output: `${c.red}Comment body is empty. Pass inline or use --body-file=<path>${c.reset}\n`,
      exitCode: 1,
    };
  }

  await commentOnIssue(id, body);
  return {
    output: `${c.green}✓${c.reset} Comment posted on ${c.cyan}${id}${c.reset}\n`,
    exitCode: 0,
  };
}

async function start(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  const id = parseLinearId(args[0]);
  if (!id) {
    return {
      output: `${c.red}Usage: crux linear start <QUA-NNN>${c.reset}\n`,
      exitCode: 1,
    };
  }

  const issue = await getIssue(id);
  if (!issue) {
    return { output: `${c.red}Issue ${id} not found${c.reset}\n`, exitCode: 1 };
  }

  const branch = currentBranch();
  await updateIssueState(id, 'In Progress');
  await commentOnIssue(
    id,
    `🤖 Claude Code starting work on this issue.\n\n**Branch:** \`${branch}\`\n\nWill post an update when a PR is ready for review.`,
  );

  let out = '';
  out += `${c.green}✓${c.reset} ${c.cyan}${id}${c.reset} → In Progress\n`;
  out += `  Branch: ${c.cyan}${branch}${c.reset}\n`;
  out += `  ${issue.url}\n`;
  return { output: out, exitCode: 0 };
}

async function done(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  const id = parseLinearId(args[0]);
  if (!id) {
    return {
      output: `${c.red}Usage: crux linear done <QUA-NNN> [--pr=URL]${c.reset}\n`,
      exitCode: 1,
    };
  }

  const issue = await getIssue(id);
  if (!issue) {
    return { output: `${c.red}Issue ${id} not found${c.reset}\n`, exitCode: 1 };
  }

  // If there's a PR, move to In Review and let the merge move it to Done later.
  // Without a PR, go straight to Done (coordinator sessions, docs-only, etc.).
  const targetState = options.pr ? 'In Review' : 'Done';
  await updateIssueState(id, targetState);

  const prLine = options.pr ? `\n**PR:** ${options.pr}` : '';
  await commentOnIssue(
    id,
    `🤖 Claude Code finished work on this issue.${prLine}`,
  );

  let out = '';
  out += `${c.green}✓${c.reset} ${c.cyan}${id}${c.reset} → ${targetState}\n`;
  if (options.pr) out += `  PR: ${options.pr}\n`;
  return { output: out, exitCode: 0 };
}

async function statesList(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  const states = await fetchRemoteWorkflowStates();
  states.sort((a, b) => a.position - b.position);

  if (options.json) {
    return { output: JSON.stringify(states, null, 2) + '\n', exitCode: 0 };
  }

  let out = `${c.bold}QUA team workflow states:${c.reset}\n`;
  for (const s of states) {
    out += `  ${c.cyan}${s.name.padEnd(14)}${c.reset} ${c.dim}(${s.type})${c.reset} ${s.id}\n`;
  }
  return { output: out, exitCode: 0 };
}

async function parse(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;
  const input = args.filter((a) => !a.startsWith('--')).join(' ');
  const id = parseLinearId(input);
  if (!id) {
    return { output: `${c.dim}No Linear ID found in: ${input}${c.reset}\n`, exitCode: 1 };
  }
  return { output: `${id}\n`, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Next / List — agent dispatch helpers
// ---------------------------------------------------------------------------

async function list(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  const limit = options.limit ? parseInt(options.limit, 10) : 50;
  const issues = await listReadyIssues(limit);
  const ranked = rankReadyIssues(issues);

  if (options.json) {
    return { output: JSON.stringify(ranked, null, 2) + '\n', exitCode: 0 };
  }

  if (ranked.length === 0) {
    return { output: `${c.dim}No ready issues found (Todo/Backlog) in QUA team.${c.reset}\n`, exitCode: 0 };
  }

  let out = `${c.bold}${ranked.length} ready issue(s) in QUA team:${c.reset}\n\n`;
  for (const r of ranked) {
    const pri = priorityLabel(r.priority);
    const blocked = r.blocked ? ` ${c.red}[blocked]${c.reset}` : '';
    const assignee = r.assignee ? ` ${c.dim}(${r.assignee.name})${c.reset}` : '';
    const state = r.state.name;
    const labels = r.labels.nodes.map((l) => l.name).join(', ');
    out += `  ${c.cyan}${r.identifier}${c.reset} [${state}] ${pri} (score: ${r.score})${blocked}${assignee}\n`;
    out += `    ${r.title}\n`;
    if (labels) out += `    ${c.dim}labels: ${labels}${c.reset}\n`;
    out += '\n';
  }
  return { output: out, exitCode: 0 };
}

async function next(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  const issues = await listReadyIssues(50);
  const ranked = rankReadyIssues(issues);
  const available = ranked.filter((i) => !i.blocked);

  if (options.json) {
    return { output: JSON.stringify(available[0] ?? null, null, 2) + '\n', exitCode: 0 };
  }

  if (available.length === 0) {
    const blockedCount = ranked.filter((i) => i.blocked).length;
    let out = `${c.yellow}No available issues.${c.reset}\n`;
    if (ranked.length > 0) {
      out += `  ${c.dim}${ranked.length} ready issue(s) found, but ${blockedCount} blocked.${c.reset}\n`;
    } else {
      out += `  ${c.dim}No issues in Todo/Backlog states.${c.reset}\n`;
    }
    return { output: out, exitCode: 1 };
  }

  const top = available[0];
  const pri = priorityLabel(top.priority);
  const labels = top.labels.nodes.map((l) => l.name).join(', ');

  let out = '';
  out += `${c.bold}Next issue:${c.reset}\n\n`;
  out += `  ${c.bold}${c.cyan}${top.identifier}${c.reset} ${top.title}\n`;
  out += `  ${c.dim}state:${c.reset} ${top.state.name}  ${c.dim}priority:${c.reset} ${pri}  ${c.dim}score:${c.reset} ${top.score}\n`;
  out += `  ${c.dim}url:${c.reset} ${top.url}\n`;
  if (labels) out += `  ${c.dim}labels:${c.reset} ${labels}\n`;
  if (top.parent) out += `  ${c.dim}parent:${c.reset} ${top.parent.identifier} — ${top.parent.title}\n`;
  if (top.project) out += `  ${c.dim}project:${c.reset} ${top.project.name}\n`;
  if (top.assignee) out += `  ${c.dim}assignee:${c.reset} ${top.assignee.name}\n`;

  if (top.description) {
    const desc = top.description.slice(0, 600);
    out += `\n${desc}${top.description.length > 600 ? '\n…(truncated)' : ''}\n`;
  }

  // Show the rest of the queue
  const rest = available.slice(1, 4);
  if (rest.length > 0) {
    out += `\n${c.dim}Next in queue:${c.reset}\n`;
    for (const r of rest) {
      out += `  ${c.cyan}${r.identifier}${c.reset} ${priorityLabel(r.priority)} — ${r.title}\n`;
    }
  }

  const blocked = ranked.filter((i) => i.blocked);
  if (blocked.length > 0) {
    out += `\n${c.dim}${blocked.length} blocked issue(s) skipped.${c.reset}\n`;
  }

  out += `\n${c.bold}To start:${c.reset} pnpm crux linear start ${top.identifier}\n`;

  return { output: out, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Command registry
// ---------------------------------------------------------------------------

export const commands = {
  default: view,
  view,
  search,
  comment,
  start,
  done,
  next,
  list,
  'states-list': statesList,
  parse,
};

export function getHelp(): string {
  return `
Linear Domain — Track Claude Code work on Linear issues

Commands:
  next                          Pick the highest-priority ready issue (Todo/Backlog)
  list                          List all ready issues ranked by priority
  view <QUA-NNN>                Show full issue + recent comments (default)
  search <query>                Search QUA team issues
  comment <QUA-NNN> <message>   Post a comment on an issue
  start <QUA-NNN>               Move issue to In Progress + post start comment
  done <QUA-NNN> [--pr=URL]     Move to In Review (with PR) or Done, post comment
  states-list                   Show current QUA team workflow state IDs
  parse <string>                Extract a Linear ID from a string (debug helper)

Options (comment):
  --body-file=<path>  Comment body from file (safe for multiline / escaped content)

Options (done):
  --pr=URL            PR URL to include in the completion comment; moves to In Review

Global options:
  --json              Machine-readable output where supported
  --limit=N           Max results for search/list (default: 20/50)

Environment:
  LINEAR_API_KEY      Required. Stored in .env.base at the workspace root.

Examples:
  crux linear next                                           # Pick top issue
  crux linear list                                           # See all ready issues
  crux linear view QUA-184
  crux linear search "agent checklist"
  crux linear start QUA-184
  crux linear done QUA-184 --pr=https://github.com/.../pull/42
  crux linear comment QUA-184 "Landed in commit abc123"
  crux linear comment QUA-184 --body-file=/tmp/note.md
  crux linear states-list
`;
}
