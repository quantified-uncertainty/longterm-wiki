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
import { basename, dirname, join } from 'path';

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

/**
 * Strict non-negative integer parse: requires the entire trimmed string to be
 * digits. Rejects `"1234garbage"`, `"-5"`, `""`, and non-finite numbers. Used
 * for reading `.agent-slot` and `.claude/agent-id` where a typo or stray byte
 * shouldn't silently become a valid number.
 */
function parseStrictNonNegativeInt(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(n) ? n : null;
}

function readIntFile(
  path: string,
  fileExists: (p: string) => boolean,
  readFile: (p: string) => string,
): number | null {
  try {
    if (!fileExists(path)) return null;
    return parseStrictNonNegativeInt(readFile(path));
  } catch {
    return null;
  }
}

/**
 * Walk up from `cwd` looking for a directory named `a<N>` (the agent-slot
 * root). Returns the slot number when found. Agents sometimes run crux from
 * subdirectories of their slot (apps/web, crux, etc.) — without this walk,
 * the slot field would silently go missing from start comments.
 */
export function findSlotFromAncestors(cwd: string): number | null {
  let current = cwd;
  for (let i = 0; i < 10; i++) {
    const match = basename(current).match(/^a(\d+)$/);
    if (match) {
      const n = Number.parseInt(match[1], 10);
      if (Number.isSafeInteger(n)) return n;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/**
 * Escape a value for safe inclusion inside a markdown backtick code span.
 * A branch name containing a backtick would break out of the span and turn
 * the rest of the comment into rendered markdown. Control characters
 * (newlines especially) would split the code span across lines. Branches
 * with such characters are rare but valid under git's ref rules, so strip
 * rather than reject. Caps length to guard against pathological input.
 */
export function sanitizeForCodeSpan(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/`/g, "'").replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200);
}

/**
 * Escape a value for safe inclusion as inline markdown text. Strips the
 * few characters that could introduce formatting or links when the value
 * comes from an untrusted-enough source (git, os.hostname), plus control
 * characters and enforces a length cap.
 */
function sanitizeForInlineText(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[`*_\[\]<>]/g, '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200);
}

export function getSessionContext(deps: SessionContextDeps = {}): SessionContext {
  const cwd = deps.cwd ?? process.cwd();
  const fileExists = deps.fileExists ?? existsSync;
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, 'utf-8'));

  const gitBranch =
    deps.gitBranch ??
    (() => execSync('git branch --show-current', { encoding: 'utf-8' }).trim());

  const hostnameFn = deps.hostnameFn ?? hostname;

  let branch: string;
  try {
    branch = gitBranch().trim() || 'unknown-branch';
  } catch {
    branch = 'unknown-branch';
  }

  // Slot resolution: walk ancestors for `a<N>` first (canonical). Fall back
  // to `.agent-slot` for legacy layouts that don't use the a<N> convention.
  let slot = findSlotFromAncestors(cwd);
  if (slot === null) {
    const slotFilePath = deps.slotFilePath ?? join(cwd, '.agent-slot');
    slot = readIntFile(slotFilePath, fileExists, readFile);
  }

  // Agent ID from E925 registration — written by .claude/hooks/session-start.sh
  // after a successful POST /api/active-agents. Missing in sessions where the
  // wiki-server was unreachable at start time, which is normal for slot agents.
  const agentIdPath = deps.agentIdPath ?? join(cwd, '.claude/agent-id');
  const agentId = readIntFile(agentIdPath, fileExists, readFile);

  let host: string | null;
  try {
    const raw = hostnameFn().trim();
    host = raw || null;
  } catch {
    host = null;
  }

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
 *
 * Branch and host are sanitized to prevent markdown injection from unusual
 * git ref names or hostname characters.
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

  const branchRaw = ctx.branch || 'unknown-branch';
  const branchSafe = sanitizeForCodeSpan(branchRaw);
  const isMainish = branchRaw === 'main' || branchRaw === 'master';
  if (isMainish) {
    lines.push(
      `**Branch:** \`${branchSafe}\` ⚠ (init'd before feature branch was created — expect a follow-up comment when the branch appears)`,
    );
  } else {
    lines.push(`**Branch:** \`${branchSafe}\``);
  }

  if (ctx.host) {
    lines.push(`**Host:** ${sanitizeForInlineText(ctx.host)}`);
  }

  if (ctx.agentId !== null) {
    lines.push(`**Active agent ID:** #${ctx.agentId} (E925 dashboard)`);
  }

  lines.push('');
  lines.push(opts.trailing ?? 'Will post an update when a PR is ready for review.');

  return lines.join('\n');
}
