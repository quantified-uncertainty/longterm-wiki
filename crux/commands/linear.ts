/**
 * Linear Command Handlers — Primary Issue Tracker
 *
 * Linear is the primary issue tracker for longterm-wiki. All new issues
 * should be created here, not in GitHub Issues.
 *
 * Usage:
 *   crux linear view <QUA-NNN>          Show full issue + comments
 *   crux linear search <query>          Search QUA team issues
 *   crux linear create <title>          Create a new issue
 *   crux linear comment <QUA-NNN> <msg> Post a comment
 *   crux linear start <QUA-NNN>         Move to In Progress + start comment
 *   crux linear done <QUA-NNN> --pr=URL Move to In Review + done comment
 *   crux linear states-list             Print current QUA team workflow states
 *   crux linear parse <string>          Extract a Linear ID from a string (debug)
 */

import { createLogger } from '../lib/output.ts';
import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';
import {
  commentOnIssue,
  createIssue,
  getComments,
  getIssue,
  searchIssues,
  updateIssueState,
} from '../lib/linear/issues.ts';
import {
  auditInProgress,
  extractFixesIds,
  type AuditBucket,
  type AuditEntry,
} from '../lib/linear/audit.ts';
import { githubApi } from '../lib/github.ts';
import { fetchRemoteWorkflowStates } from '../lib/linear/workflow-states.ts';
import { findAllLinearIds, parseLinearId } from '../lib/linear/parse-id.ts';
import { currentBranch } from '../lib/session/session-checklist.ts';
import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';

interface CommandOptions extends BaseOptions {
  ci?: boolean;
  json?: boolean;
  pr?: string;
  limit?: string;
  bodyFile?: string;
  description?: string;
  descriptionFile?: string;
  priority?: string;
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

async function create(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  const title = args.filter((a) => !a.startsWith('--')).join(' ').trim();
  if (!title) {
    return {
      output: `${c.red}Usage: crux linear create "Issue title" [--description="..."] [--description-file=<path>] [--priority=1-4]${c.reset}\n`,
      exitCode: 1,
    };
  }

  // Resolve description from flag or file
  const descFromFile = readBodyFlag(options.descriptionFile);
  const description = descFromFile ?? options.description ?? '';

  // Parse priority (Linear: 1=urgent, 2=high, 3=medium, 4=low)
  let priority: number | undefined;
  if (options.priority) {
    priority = parseInt(options.priority, 10);
    if (Number.isNaN(priority) || priority < 1 || priority > 4) {
      return {
        output: `${c.red}Invalid priority "${options.priority}" — must be 1 (urgent), 2 (high), 3 (medium), or 4 (low)${c.reset}\n`,
        exitCode: 1,
      };
    }
  }

  const result = await createIssue({ title, description, priority });

  if (options.json) {
    return { output: JSON.stringify(result, null, 2) + '\n', exitCode: 0 };
  }

  let out = '';
  out += `${c.green}✓${c.reset} Created ${c.cyan}${result.identifier}${c.reset} — ${title}\n`;
  out += `  ${result.url}\n`;
  return { output: out, exitCode: 0 };
}

async function audit(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  const bucketFilter = args.find((a) => a.startsWith('--bucket='))?.split('=')[1];
  const fix = args.includes('--fix');

  const entries = await auditInProgress();

  if (options.json) {
    const filtered = bucketFilter ? entries.filter((e) => e.bucket === bucketFilter) : entries;
    return { output: JSON.stringify(filtered, null, 2) + '\n', exitCode: 0 };
  }

  if (entries.length === 0) {
    return {
      output: `${c.green}✓${c.reset} No issues currently In Progress.\n`,
      exitCode: 0,
    };
  }

  const bucketMeta: Record<AuditBucket, { label: string; color: string; action: string }> = {
    active: {
      label: 'ACTIVE',
      color: c.green,
      action: 'Has open PR — no action needed.',
    },
    shipped: {
      label: 'SHIPPED (state-update missed)',
      color: c.yellow,
      action: 'PR merged. Move to Done: crux linear done QUA-NNN --pr=URL',
    },
    'parent-epic': {
      label: 'PARENT EPIC (sub-issues resolved)',
      color: c.cyan,
      action: 'All sub-issues resolved. Close: crux linear done QUA-NNN',
    },
    orphan: {
      label: `ORPHAN (>${7}d no PR)`,
      color: c.red,
      action: 'No PR, no activity. Move to Backlog or reassess scope.',
    },
    stuck: {
      label: 'STUCK (recent but no PR)',
      color: c.dim,
      action: 'Check if active — may need to move back to Backlog.',
    },
  };

  const groups: Record<AuditBucket, AuditEntry[]> = {
    active: [],
    shipped: [],
    'parent-epic': [],
    orphan: [],
    stuck: [],
  };
  for (const e of entries) {
    if (bucketFilter && e.bucket !== bucketFilter) continue;
    groups[e.bucket].push(e);
  }

  let out = '';
  out += `${c.bold}Linear In-Progress audit (${entries.length} issues)${c.reset}\n\n`;

  const order: AuditBucket[] = ['shipped', 'parent-epic', 'orphan', 'stuck', 'active'];
  for (const bucket of order) {
    const items = groups[bucket];
    if (items.length === 0) continue;
    const meta = bucketMeta[bucket];
    out += `${meta.color}${c.bold}${meta.label} (${items.length})${c.reset}\n`;
    out += `${c.dim}${meta.action}${c.reset}\n`;
    for (const e of items) {
      out += `  ${meta.color}${e.issue.identifier}${c.reset} — ${e.issue.title}\n`;
      out += `    ${c.dim}${e.reason}${c.reset}\n`;
    }
    out += '\n';
  }

  const actionable = groups.shipped.length + groups['parent-epic'].length + groups.orphan.length;
  if (actionable > 0) {
    out += `${c.bold}${actionable} issue(s) need action.${c.reset} Use ${c.cyan}--bucket=shipped${c.reset}/etc. to filter, ${c.cyan}--fix${c.reset} to auto-close SHIPPED + PARENT EPIC, or ${c.cyan}--json${c.reset} for scripting.\n`;
  } else {
    out += `${c.green}✓${c.reset} All In Progress issues look healthy.\n`;
  }

  if (fix) {
    const toFix = [...groups.shipped, ...groups['parent-epic']];
    if (toFix.length === 0) {
      out += `\n${c.dim}Nothing to fix.${c.reset}\n`;
    } else {
      out += `\n${c.bold}Applying fixes (${toFix.length})...${c.reset}\n`;
      for (const e of toFix) {
        try {
          await updateIssueState(e.issue.identifier, 'Done');
          const prRef = e.mergedPRs[0]
            ? `\n\n**PR:** ${e.mergedPRs[0].url}`
            : e.bucket === 'parent-epic'
              ? '\n\nAll sub-issues resolved.'
              : '';
          await commentOnIssue(
            e.issue.identifier,
            `🤖 Auto-closed by \`crux linear audit --fix\`: ${e.reason}.${prRef}`,
          );
          out += `  ${c.green}✓${c.reset} ${e.issue.identifier} → Done\n`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          out += `  ${c.red}✗${c.reset} ${e.issue.identifier} — ${msg}\n`;
        }
      }
    }
  }

  return { output: out, exitCode: 0 };
}

/**
 * Watchdog: given a merged PR, ensure its linked Linear issues are actually Done.
 *
 * This catches cases where Linear's GitHub integration silently drops a webhook
 * or the PR body's Fixes line didn't match Linear's parser. Safe to run
 * repeatedly — it's a no-op if the issues are already Done.
 */
async function verifyPr(args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  const prArg = args.find((a) => !a.startsWith('--'));
  if (!prArg) {
    return {
      output: `${c.red}Usage: crux linear verify-pr <PR_NUMBER>${c.reset}\n`,
      exitCode: 1,
    };
  }
  const prNum = parseInt(prArg.replace(/^#/, ''), 10);
  if (Number.isNaN(prNum)) {
    return {
      output: `${c.red}Invalid PR number: ${prArg}${c.reset}\n`,
      exitCode: 1,
    };
  }

  interface GhPullResponse {
    number: number;
    title: string;
    body: string | null;
    state: string;
    merged: boolean;
    merged_at: string | null;
    html_url: string;
  }
  const pr = await githubApi<GhPullResponse>(`/repos/quantified-uncertainty/longterm-wiki/pulls/${prNum}`);

  if (!pr.merged) {
    return {
      output: `${c.dim}PR #${prNum} not merged — nothing to verify.${c.reset}\n`,
      exitCode: 0,
    };
  }

  const ids = extractFixesIds(pr.body ?? '');
  if (ids.length === 0) {
    return {
      output: `${c.yellow}PR #${prNum} (merged) has no Fixes QUA-NNN refs — cannot verify.${c.reset}\n`,
      exitCode: 0,
    };
  }

  let out = `${c.bold}Verifying PR #${prNum} → ${ids.length} Linear issue(s)${c.reset}\n`;
  let corrected = 0;

  for (const id of ids) {
    const issue = await getIssue(id);
    if (!issue) {
      out += `  ${c.yellow}?${c.reset} ${id} — not found\n`;
      continue;
    }
    if (issue.state.name === 'Done' || issue.state.name === 'Canceled') {
      out += `  ${c.green}✓${c.reset} ${id} — already ${issue.state.name}\n`;
      continue;
    }
    try {
      await updateIssueState(id, 'Done');
      await commentOnIssue(
        id,
        `🤖 State reconciled by watchdog: PR ${pr.html_url} merged but issue was still "${issue.state.name}".`,
      );
      out += `  ${c.yellow}→${c.reset} ${id} — ${issue.state.name} → Done (corrected)\n`;
      corrected += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      out += `  ${c.red}✗${c.reset} ${id} — ${msg}\n`;
    }
  }

  if (corrected > 0) {
    out += `\n${c.yellow}${corrected} issue(s) corrected.${c.reset} Linear's integration likely missed the webhook — PR body or branch name may need clearer refs.\n`;
  } else {
    out += `\n${c.green}✓${c.reset} All linked issues already in terminal state.\n`;
  }

  return { output: out, exitCode: 0 };
}

/**
 * Session leak-check: scan the current branch/session for QUA-NNN references
 * beyond the primary issue, and warn about any that are still In Progress
 * without a closing PR. Run at /agent-end to catch "touched 3 issues, only
 * closed 1" patterns.
 */
async function leakCheck(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  const sources: string[] = [];

  const branch = currentBranch();
  if (branch) sources.push(branch);

  for (const path of ['.claude/wip-checklist.md', '.claude/wip-context.md']) {
    if (existsSync(path)) {
      try {
        sources.push(readFileSync(path, 'utf-8'));
      } catch {
        // best-effort
      }
    }
  }

  try {
    const mergeBase = execSync('git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    if (mergeBase) {
      const commits = execSync(`git log ${mergeBase}..HEAD --format=%B`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      sources.push(commits);
    }
  } catch {
    // detached, no main, etc. — skip
  }

  const allIds = new Set<string>();
  for (const src of sources) {
    for (const id of findAllLinearIds(src)) allIds.add(id);
  }

  // The primary issue is the one the session is tracking (from branch or checklist).
  const primary = parseLinearId(branch ?? '') ?? null;

  const secondary = [...allIds].filter((id) => id !== primary).sort();

  if (secondary.length === 0) {
    return {
      output: options.json
        ? JSON.stringify({ primary, secondary: [], warnings: [] }, null, 2) + '\n'
        : `${c.green}✓${c.reset} No secondary Linear refs found.${primary ? ` (primary: ${primary})` : ''}\n`,
      exitCode: 0,
    };
  }

  // For each secondary, check Linear state.
  const warnings: Array<{
    id: string;
    state: string;
    message: string;
  }> = [];

  for (const id of secondary) {
    const issue = await getIssue(id);
    if (!issue) continue;
    const state = issue.state.name;
    if (state === 'In Progress') {
      warnings.push({
        id,
        state,
        message: `referenced in this session but still In Progress — did work leak across issues?`,
      });
    } else if (state === 'In Review') {
      warnings.push({
        id,
        state,
        message: `In Review — confirm its PR is actually open and linked`,
      });
    }
  }

  if (options.json) {
    return {
      output: JSON.stringify({ primary, secondary, warnings }, null, 2) + '\n',
      exitCode: 0,
    };
  }

  let out = '';
  if (primary) out += `${c.dim}Primary session issue: ${primary}${c.reset}\n`;
  out += `${c.bold}Secondary Linear refs found (${secondary.length}):${c.reset} ${secondary.join(', ')}\n`;

  if (warnings.length === 0) {
    out += `${c.green}✓${c.reset} All secondary refs are in terminal state or pre-start.\n`;
  } else {
    out += `\n${c.yellow}${c.bold}${warnings.length} potential leak(s):${c.reset}\n`;
    for (const w of warnings) {
      out += `  ${c.yellow}⚠${c.reset} ${w.id} [${w.state}] — ${w.message}\n`;
    }
    out += `\n${c.dim}If these issues should be closed, run: crux linear done <QUA-NNN>${c.reset}\n`;
    out += `${c.dim}If they should be moved back to Backlog, do so in Linear.${c.reset}\n`;
  }

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
  create,
  start,
  done,
  audit,
  'verify-pr': verifyPr,
  'leak-check': leakCheck,
  'states-list': statesList,
  parse,
};

export function getHelp(): string {
  return `
Linear Domain — Primary issue tracker for longterm-wiki

Commands:
  view <QUA-NNN>                Show full issue + recent comments (default)
  search <query>                Search QUA team issues
  create <title>                Create a new issue in the QUA team
  comment <QUA-NNN> <message>   Post a comment on an issue
  start <QUA-NNN>               Move issue to In Progress + post start comment
  done <QUA-NNN> [--pr=URL]     Move to In Review (with PR) or Done, post comment
  audit                         Classify In Progress issues by PR health (shipped/orphan/epic/active)
  verify-pr <PR>                Watchdog: ensure merged PR's Fixes QUA-NNN issues are actually Done
  leak-check                    Scan current session for QUA refs beyond the primary; warn about leaks
  states-list                   Show current QUA team workflow state IDs
  parse <string>                Extract a Linear ID from a string (debug helper)

Options (create):
  --description=<text>       Issue description (inline)
  --description-file=<path>  Issue description from file (safe for multiline)
  --priority=N               Priority: 1=urgent, 2=high, 3=medium, 4=low (default: none)

Options (comment):
  --body-file=<path>  Comment body from file (safe for multiline / escaped content)

Options (done):
  --pr=URL            PR URL to include in the completion comment; moves to In Review

Options (audit):
  --bucket=<name>     Filter to one bucket: shipped, parent-epic, orphan, stuck, active
  --fix               Auto-close SHIPPED and PARENT-EPIC issues (move to Done with comment)
  --json              Machine-readable output

Global options:
  --json              Machine-readable output where supported
  --limit=N           Max results for search (default: 20)

Environment:
  LINEAR_API_KEY      Required. Stored in .env.base at the workspace root.

Examples:
  crux linear create "Broken login page" --description="The login form crashes on submit"
  crux linear create "Add retry logic" --description-file=/tmp/desc.md --priority=3
  crux linear view QUA-184
  crux linear search "agent checklist"
  crux linear start QUA-184
  crux linear done QUA-184 --pr=https://github.com/.../pull/42
  crux linear comment QUA-184 "Landed in commit abc123"
  crux linear comment QUA-184 --body-file=/tmp/note.md
  crux linear states-list
`;
}
