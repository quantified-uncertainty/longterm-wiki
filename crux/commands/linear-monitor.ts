/**
 * `crux linear monitor` — upsert / resolve a Linear ticket by exact title.
 *
 * Used by automated monitor pipelines (render-monitor, server-health) that
 * previously filed GitHub issues directly. Linear-first under QUA-970 so
 * tickets land with their correct project instead of as orphans via the
 * GitHub-mirror sync.
 *
 * Two operations, one command:
 *
 *   upsert   On failure: comment on the open ticket with this title if one
 *            exists; otherwise create a new ticket under --project.
 *   resolve  On recovery: comment + close every open ticket with this title.
 *
 * Title-match semantics:
 *   - Exact case-sensitive title match against Linear search results.
 *     Linear's free-text search is token-based, so we filter the response.
 *   - Title is the dedup key. Pick a stable title for your monitor and put
 *     varying detail (timestamp, status, run URL) in the body.
 *
 * No GitHub fallback. If Linear is unreachable, the workflow step fails and
 * the next scheduled run picks it up. The wellness check has GH fallback
 * because it runs every few minutes; render/server-health run weekly or
 * 6-hourly so a single missed alert is not a coverage gap.
 */

import { readFileSync } from 'fs';

import {
  searchIssues,
  commentOnIssue,
  createIssue,
  updateIssueState,
  type SearchedIssue,
} from '../lib/linear/issues.ts';
import { getProject } from '../lib/linear/projects.ts';
import { isOpenStateType } from '../lib/linear/workflow-states.ts';
import { createLogger } from '../lib/output.ts';
import type { CommandOptions, CommandResult } from '../lib/command-types.ts';

interface MonitorOptions extends CommandOptions {
  ci?: boolean;
  json?: boolean;
  title?: string;
  body?: string;
  bodyFile?: string;
  description?: string;
  comment?: string;
  project?: string;
  /**
   * Override the underlying Linear client functions (used by tests). Not a
   * CLI flag — only injected from `monitor()` callers in the test suite.
   */
  __deps?: MonitorDeps;
}

export interface MonitorDeps {
  search: typeof searchIssues;
  comment: typeof commentOnIssue;
  create: typeof createIssue;
  setState: typeof updateIssueState;
  getProject: typeof getProject;
}

const DEFAULT_DEPS: MonitorDeps = {
  search: searchIssues,
  comment: commentOnIssue,
  create: createIssue,
  setState: updateIssueState,
  getProject,
};

const HELP = `Usage: crux linear monitor <upsert|resolve> [options]

  upsert   --title=<exact-title> --project=<name>
           [--body=<text> | --body-file=<path>]
           Comment on an existing open ticket with this exact title, or
           create a new one in <project> if none exists. Body content is
           used as the create-time description AND the comment-on-existing
           message.

  resolve  --title=<exact-title> [--comment=<message>]
           Comment + close every open ticket with this exact title.
           No-op if none are open. The optional --comment is posted before
           the close.

The title is the dedup key — pick a stable string per monitor. Vary detail
(timestamps, status codes, run URLs) inside the body, not the title.
`;

function readBody(options: MonitorOptions): string | { error: string } {
  if (options.bodyFile) {
    try {
      return readFileSync(options.bodyFile, 'utf-8');
    } catch (err) {
      return { error: `Failed to read --body-file=${options.bodyFile}: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  if (options.body) {
    return options.body;
  }
  return { error: '--body or --body-file is required' };
}

/**
 * Normalize a title for matching purposes. Trim leading/trailing whitespace
 * and lowercase to make matches resilient to common manual edits — a human
 * renaming "Render quality regression detected" → " Render quality
 * regression detected " or "render quality regression detected" must not
 * fragment the dedup. Linear titles preserve display case, so this only
 * affects the match comparison, not what gets stored.
 */
function normalizeTitle(title: string): string {
  return title.trim().toLowerCase();
}

function pickOldestOpen(matches: SearchedIssue[]): SearchedIssue | null {
  // Mirrors the wellness convention: keep the oldest open ticket as the
  // canonical one so concurrent runs converge on the same dedup target.
  // Sort by identifier suffix (QUA-NNN where lower = older).
  const open = matches.filter((m) => isOpenStateType(m.state.type));
  if (open.length === 0) return null;
  open.sort((a, b) => {
    const an = Number(a.identifier.match(/^QUA-(\d+)$/)?.[1] ?? 0);
    const bn = Number(b.identifier.match(/^QUA-(\d+)$/)?.[1] ?? 0);
    return an - bn;
  });
  return open[0];
}

function preflightApiKey(): string | null {
  if (!process.env.LINEAR_API_KEY) {
    return 'LINEAR_API_KEY is not set in the environment. Set it before invoking `crux linear monitor`.';
  }
  return null;
}

async function upsertCommand(
  options: MonitorOptions,
): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;
  const deps = options.__deps ?? DEFAULT_DEPS;

  if (!options.title) {
    return { output: `${c.red}--title is required${c.reset}\n${HELP}`, exitCode: 1 };
  }
  if (!options.project) {
    return { output: `${c.red}--project is required${c.reset}\n${HELP}`, exitCode: 1 };
  }
  const body = readBody(options);
  if (typeof body !== 'string') {
    return { output: `${c.red}${body.error}${c.reset}\n${HELP}`, exitCode: 1 };
  }
  // Skip preflight when deps are injected (tests). The default deps go
  // through the real Linear client, which reads LINEAR_API_KEY at call time.
  if (!options.__deps) {
    const preflightError = preflightApiKey();
    if (preflightError) {
      return { output: `${c.red}${preflightError}${c.reset}\n`, exitCode: 1 };
    }
  }

  const title = options.title;
  const normTitle = normalizeTitle(title);

  // 1. Search Linear for existing tickets with this exact title (case-
  //    insensitive, trimmed). Linear's search is token-based, so the post-
  //    filter is required to avoid acting on near-matches.
  const candidates = (await deps.search(title, 20)).filter(
    (r) => normalizeTitle(r.title) === normTitle,
  );
  const existing = pickOldestOpen(candidates);

  if (existing) {
    // Comment on the existing open ticket. Failure here is an actual problem
    // (Linear is up, the ticket is open, but the comment refused) — surface
    // it with a non-zero exit so the workflow step fails loudly.
    await deps.comment(existing.identifier, body);
    if (options.json) {
      return {
        output: JSON.stringify({ action: 'commented', identifier: existing.identifier, url: existing.url }) + '\n',
        exitCode: 0,
      };
    }
    return {
      output: `${c.green}✓${c.reset} Commented on existing ${c.cyan}${existing.identifier}${c.reset}\n  ${existing.url}\n`,
      exitCode: 0,
    };
  }

  // 2. No open match — create a new ticket. Resolve the project first so
  // we fail loudly on a project rename instead of filing a projectless
  // orphan (the exact failure mode QUA-824 documented).
  const project = await deps.getProject(options.project);
  if (!project) {
    return {
      output: `${c.red}Project "${options.project}" not found in Linear.${c.reset}\n  Run ${c.cyan}crux linear project list${c.reset} to see available projects.\n`,
      exitCode: 1,
    };
  }
  if (project.state === 'completed' || project.state === 'canceled') {
    return {
      output: `${c.red}Project "${options.project}" is in state "${project.state}" — refusing to file into an archived/closed project. Pick a live project or unarchive.${c.reset}\n`,
      exitCode: 1,
    };
  }

  const created = await deps.create({
    title,
    description: body,
    projectId: project.id,
  });

  if (!created.identifier || !created.url) {
    // Defensive: Linear's issueCreate mutation can return success with a
    // malformed payload. Treat as an error so the workflow rerun retries.
    return {
      output: `${c.red}Linear createIssue returned a malformed response (missing identifier or url).${c.reset}\n`,
      exitCode: 1,
    };
  }

  if (options.json) {
    return {
      output: JSON.stringify({ action: 'created', identifier: created.identifier, url: created.url }) + '\n',
      exitCode: 0,
    };
  }
  return {
    output: `${c.green}✓${c.reset} Created ${c.cyan}${created.identifier}${c.reset} in project ${c.cyan}${options.project}${c.reset}\n  ${created.url}\n`,
    exitCode: 0,
  };
}

async function resolveCommand(
  options: MonitorOptions,
): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;
  const deps = options.__deps ?? DEFAULT_DEPS;

  if (!options.title) {
    return { output: `${c.red}--title is required${c.reset}\n${HELP}`, exitCode: 1 };
  }
  if (!options.__deps) {
    const preflightError = preflightApiKey();
    if (preflightError) {
      return { output: `${c.red}${preflightError}${c.reset}\n`, exitCode: 1 };
    }
  }

  const title = options.title;
  const normTitle = normalizeTitle(title);
  const candidates = (await deps.search(title, 20))
    .filter((r) => normalizeTitle(r.title) === normTitle && isOpenStateType(r.state.type));

  if (candidates.length === 0) {
    if (options.json) {
      return { output: JSON.stringify({ action: 'none', closed: [] }) + '\n', exitCode: 0 };
    }
    return { output: `No open tickets matching "${title}" — nothing to resolve.\n`, exitCode: 0 };
  }

  // Close in parallel; partial failures are reported but don't fail the whole
  // operation. The next run will catch any stragglers.
  const results = await Promise.allSettled(
    candidates.map(async (issue) => {
      if (options.comment) {
        await deps.comment(issue.identifier, options.comment);
      }
      await deps.setState(issue.identifier, 'Done');
      return issue.identifier;
    }),
  );
  const closed: string[] = [];
  const failed: Array<{ identifier: string; error: string }> = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      closed.push(r.value);
    } else {
      const error = r.reason instanceof Error ? r.reason.message : String(r.reason);
      failed.push({ identifier: candidates[i].identifier, error });
    }
  });

  if (options.json) {
    return {
      output: JSON.stringify({ action: 'resolved', closed, failed }) + '\n',
      exitCode: failed.length > 0 ? 1 : 0,
    };
  }

  let out = '';
  for (const id of closed) {
    out += `${c.green}✓${c.reset} Closed ${c.cyan}${id}${c.reset}\n`;
  }
  for (const f of failed) {
    out += `${c.red}✗${c.reset} ${f.identifier}: ${f.error}\n`;
  }
  return { output: out, exitCode: failed.length > 0 ? 1 : 0 };
}

/** `crux linear monitor` entry point. */
export async function monitor(
  args: string[],
  options: MonitorOptions,
): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const sub = args[0];

  if (!sub || sub === 'help' || sub === '--help') {
    return { output: HELP, exitCode: sub ? 0 : 1 };
  }

  if (sub === 'upsert' || sub === 'up') return upsertCommand(options);
  if (sub === 'resolve' || sub === 'down') return resolveCommand(options);

  return {
    output: `${log.colors.red}Unknown subcommand: ${sub}${log.colors.reset}\n${HELP}`,
    exitCode: 1,
  };
}
