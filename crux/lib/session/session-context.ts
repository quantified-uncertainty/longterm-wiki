/**
 * Session context — slot, branch, host, and agent ID for the current session.
 *
 * Used by `crux linear start` and `crux gh issues start` to build a rich
 * start-comment body so audits can tell real in-progress sessions apart from
 * orphan "init'd on main but never branched" claims.
 *
 * All fields except `branch` are best-effort and may be null if the
 * surrounding environment (tmux, E925 registration, directory layout) isn't
 * what we expect. The helper never throws on missing sources.
 *
 * See QUA-336 for the incident that motivated this.
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { hostname } from 'os';
import { basename, join } from 'path';

export interface SessionContext {
  slot: number | null;
  branch: string;
  host: string | null;
  agentId: number | null;
}

export interface SessionContextDeps {
  cwd?: string;
  agentIdPath?: string;
  slotFilePath?: string;
  gitBranch?: () => string;
  hostnameFn?: () => string;
  fileExists?: (p: string) => boolean;
  readFile?: (p: string) => string;
}

function readIntFile(
  path: string,
  fileExists: (p: string) => boolean,
  readFile: (p: string) => string,
): number | null {
  try {
    if (!fileExists(path)) return null;
    const raw = readFile(path).trim();
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function getSessionContext(deps: SessionContextDeps = {}): SessionContext {
  const cwd = deps.cwd ?? process.cwd();
  const fileExists = deps.fileExists ?? existsSync;
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, 'utf-8'));

  const gitBranch =
    deps.gitBranch ??
    (() => {
      try {
        return execSync('git branch --show-current', { encoding: 'utf-8' }).trim();
      } catch {
        return 'unknown-branch';
      }
    });

  const hostnameFn =
    deps.hostnameFn ??
    (() => {
      try {
        return hostname();
      } catch {
        return '';
      }
    });

  let branch: string;
  try {
    branch = gitBranch() || 'unknown-branch';
  } catch {
    branch = 'unknown-branch';
  }

  // Slot resolution: directory basename is canonical (self-healing, set by
  // workspace layout). `.agent-slot` is a fallback for legacy layouts.
  let slot: number | null = null;
  const dirName = basename(cwd);
  const dirMatch = dirName.match(/^a(\d+)$/);
  if (dirMatch) {
    slot = Number.parseInt(dirMatch[1], 10);
  } else {
    const slotFilePath = deps.slotFilePath ?? join(cwd, '.agent-slot');
    slot = readIntFile(slotFilePath, fileExists, readFile);
  }

  // Agent ID from E925 registration — written by .claude/hooks/session-start.sh
  // after a successful POST /api/active-agents. Missing in sessions where the
  // wiki-server was unreachable at start time, which is normal for slot agents.
  const agentIdPath = deps.agentIdPath ?? join(cwd, '.claude/agent-id');
  const agentId = readIntFile(agentIdPath, fileExists, readFile);

  const host = hostnameFn().trim() || null;

  return { slot, branch, host, agentId };
}

export interface BuildStartCommentOptions {
  trailing?: string;
}

/**
 * Build the markdown body for a Linear or GitHub "starting work" comment.
 *
 * Includes slot + branch + host + agent-id when available, and flags
 * `main` / `master` branches with a visible warning so audits can distinguish
 * orphan claims from real sessions.
 */
export function buildStartCommentBody(
  ctx: SessionContext,
  opts: BuildStartCommentOptions = {},
): string {
  const lines: string[] = [
    '🤖 Claude Code starting work on this issue.',
    '',
  ];

  if (ctx.slot !== null) {
    lines.push(`**Slot:** a${ctx.slot}`);
  }

  const branchDisplay = ctx.branch || 'unknown-branch';
  const isMainish = branchDisplay === 'main' || branchDisplay === 'master';
  if (isMainish) {
    lines.push(
      `**Branch:** \`${branchDisplay}\` ⚠ (init'd before feature branch was created — expect a follow-up comment when the branch appears)`,
    );
  } else {
    lines.push(`**Branch:** \`${branchDisplay}\``);
  }

  if (ctx.host) {
    lines.push(`**Host:** ${ctx.host}`);
  }

  if (ctx.agentId !== null) {
    lines.push(`**Active agent ID:** #${ctx.agentId} (E925 dashboard)`);
  }

  lines.push('');
  lines.push(opts.trailing ?? 'Will post an update when a PR is ready for review.');

  return lines.join('\n');
}
