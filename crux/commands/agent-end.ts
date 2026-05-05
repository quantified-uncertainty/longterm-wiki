/**
 * Agent End — Close out a session and reset the slot back to clean main.
 *
 * Bundles the mechanical plumbing previously orchestrated step-by-step
 * in `.claude/commands/agent-end.md` (QUA-1090).
 *
 * Usage:
 *   crux sys agent-end                            Close & reset (defaults)
 *   crux sys agent-end --pr=URL                   Pass PR URL to Linear `done`
 *   crux sys agent-end --dirty=force              Discard unexpected dirty state
 *   crux sys agent-end --dry-run                  Print actions only
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';
import { createLogger } from '../lib/output.ts';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { gitSafe } from '../lib/git.ts';
import { findSlotFromAncestors } from '../lib/session/session-context.ts';
import { resolveLinearId as resolveLinearIdFromSources } from '../lib/linear/parse-id.ts';
import * as agentChecklistCommands from './agent-checklist.ts';
import * as agentsCommands from './agents.ts';
import * as linearCommands from './linear.ts';
import * as prPatrolCommands from './pr-patrol.ts';

interface CommandOptions extends BaseOptions {
  pr?: string;
  dirty?: string; // 'fail' | 'force'
  dryRun?: boolean;
  ci?: boolean;
}

type DirtyMode = 'fail' | 'force';

// Files / directory prefixes that may legitimately be modified or untracked at
// session end — they are session-scoped scaffolding we are about to clean.
// Anything else dirty triggers the --dirty bail (unless --dirty=force).
//
// Trailing-slash entries are directory prefixes; the matcher checks
// `path.startsWith(prefix)` for those. Non-slash entries match exactly OR with
// `path === entry + '/' + ...`. See `isExpectedPath` below.
const EXPECTED_DIRTY_PATHS = [
  '.claude/wip-checklist.md',
  '.claude/wip-context.md',
  '.claude/review-done',
  '.claude/review-phases-done',
  '.claude/simplify-done',
  '.claude/agent-id',
  '.claude/last-heartbeat',
  '.claude/hooks/',
  '.claude/sessions/',
  '.agent-task',
];

function isExpectedPath(path: string): boolean {
  return EXPECTED_DIRTY_PATHS.some((p) => {
    if (p.endsWith('/')) return path.startsWith(p);
    return path === p || path.startsWith(p + '/');
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a non-git shell command. Returns null on failure. Uses execSync (with a
 * shell) intentionally for things like `lsof | tmux | pgrep` that aren't in
 * lib/git.ts. For git commands, prefer gitSafe (no shell, injection-safe).
 */
function shellSafe(cmd: string, timeoutMs = 30000): string | null {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: timeoutMs, cwd: PROJECT_ROOT }).trim();
  } catch {
    return null;
  }
}

/**
 * Like shellSafe but preserves leading whitespace. Used for `git status
 * --porcelain` whose column-0 space (" M file" = unstaged modify) is semantic.
 */
function shellRawSafe(cmd: string, timeoutMs = 30000): string | null {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: timeoutMs, cwd: PROJECT_ROOT });
  } catch {
    return null;
  }
}

/**
 * Read the Linear ID from the wip checklist (`> Linear: QUA-NNN`) first,
 * then fall back to parsing the current branch via the shared parse-id helper
 * (which enforces the team-key allowlist — see crux/lib/linear/parse-id.ts).
 *
 * Exported for tests; pass the branch in to avoid a redundant rev-parse.
 */
export function resolveLinearId(branch?: string | null): string | null {
  const sources: Array<string | null> = [];
  const checklistPath = join(PROJECT_ROOT, '.claude/wip-checklist.md');
  if (existsSync(checklistPath)) {
    const md = readFileSync(checklistPath, 'utf-8');
    const m = md.match(/^>\s*Linear:\s*([A-Z]+-\d+)/m);
    if (m) sources.push(m[0]);
  }
  // Caller passes branch when known to avoid a duplicate rev-parse.
  const branchValue = branch ?? readCurrentBranch();
  if (branchValue) sources.push(branchValue);
  return resolveLinearIdFromSources(sources);
}

/**
 * Current branch name, or null on failure. Wraps `gitSafe` so we don't need to
 * decide between throwing/non-throwing variants at every call site.
 */
function readCurrentBranch(): string | null {
  const r = gitSafe('rev-parse', '--abbrev-ref', 'HEAD');
  return r.ok ? r.output : null;
}

/**
 * Read DEV_PORT from .env. Returns null if missing or non-numeric.
 */
export function readDevPort(): number | null {
  const envPath = join(PROJECT_ROOT, '.env');
  if (!existsSync(envPath)) return null;
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^DEV_PORT=(\d+)\s*$/);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * Slot number for the current cwd, or null. Walks ancestors for `a<N>`
 * (canonical) and falls back to `.agent-slot` for legacy layouts. Returns the
 * value as a string for tmux/output use; callers needing a number should
 * import findSlotFromAncestors directly.
 */
export function readSlotNumber(): string | null {
  const n = findSlotFromAncestors(process.cwd());
  if (n !== null) return String(n);
  // Legacy fallback — pre-a<N> layouts and worktrees that override .agent-slot.
  const slotPath = join(PROJECT_ROOT, '.agent-slot');
  if (!existsSync(slotPath)) return null;
  const raw = readFileSync(slotPath, 'utf-8').trim();
  return /^\d+$/.test(raw) ? raw : null;
}

/**
 * Find PIDs listening on the given TCP port. Uses `lsof -sTCP:LISTEN` so we
 * never accidentally match outbound browser connections (per QUA memory:
 * `feedback_kill_port_safely.md`).
 */
export function findPortListeners(port: number): number[] {
  const out = shellSafe(`lsof -ti:${port} -sTCP:LISTEN`);
  if (!out) return [];
  return out
    .split('\n')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

interface DirtyStatus {
  unexpectedFiles: string[];
  unpushedCommits: number;
  expectedFiles: string[];
}

/**
 * Inspect the working tree for state /agent-end is not authorized to discard.
 * Expected scaffolding (wip checklist, hooks/, etc.) is filtered out — those
 * always get cleaned. Anything else is "unexpected" and triggers --dirty=fail.
 *
 * Unpushed commits are reported only on non-main branches (on main any unpushed
 * work is a separate issue the user owns; agent-end does not amend that).
 */
export function inspectDirtyState(branch?: string | null): DirtyStatus {
  // shellRawSafe (no trim): porcelain output uses two columns where column 0
  // can legitimately be a space (" M file" = unstaged modify). Trim would
  // corrupt the slice(3).
  const status = shellRawSafe('git status --porcelain') ?? '';
  const branchValue = branch ?? readCurrentBranch() ?? '(unknown)';

  const expectedFiles: string[] = [];
  const unexpectedFiles: string[] = [];

  for (const line of status.split('\n').filter(Boolean)) {
    // Format: "XY <path>" (X = staged, Y = unstaged; both single chars).
    // Renames have the form "R<flag> old -> new" — both old and new must be
    // checked, since a session might rename an expected scaffolding file.
    const slice = line.slice(3);
    const renameSplit = ' -> ';
    const paths = slice.includes(renameSplit) ? slice.split(renameSplit) : [slice];
    const isExpected = paths.every(isExpectedPath);
    if (isExpected) expectedFiles.push(line);
    else unexpectedFiles.push(line);
  }

  let unpushedCommits = 0;
  if (branchValue !== 'main' && branchValue !== '(unknown)') {
    // gitSafe handles the "no upstream configured" error cleanly without
    // shell stderr redirection (returns ok:false → unpushedCommits stays 0).
    const counted = gitSafe('rev-list', '--count', '@{u}..HEAD');
    if (counted.ok) unpushedCommits = Number(counted.output) || 0;
  }

  return { unexpectedFiles, unpushedCommits, expectedFiles };
}

export function parseDirtyMode(raw: unknown): DirtyMode {
  if (raw === 'force') return 'force';
  return 'fail';
}

// ---------------------------------------------------------------------------
// Action steps — each returns one structured line for the parent summary
// ---------------------------------------------------------------------------

interface StepResult {
  label: string;
  ok: boolean;
  detail: string;
}

interface Plan {
  linearId: string | null;
  prUrl: string | null;
  branch: string;
  slot: string | null;
  devPort: number | null;
}

function buildPlan(options: CommandOptions, branch: string): Plan {
  return {
    linearId: resolveLinearId(branch),
    prUrl: typeof options.pr === 'string' ? options.pr : null,
    branch,
    slot: readSlotNumber(),
    devPort: readDevPort(),
  };
}

/**
 * Look up a running pr-patrol daemon's PID, for dry-run reporting only.
 * `stepPatrolStop` calls into the daemon's own registry directly — we don't
 * pass the PID in.
 */
function patrolPid(): number | null {
  const out = shellSafe('pgrep -f "crux gh pr-patrol run"');
  if (!out) return null;
  const first = out.split('\n').find(Boolean);
  const n = first ? Number(first) : null;
  return Number.isInteger(n) && n! > 0 ? n : null;
}

/**
 * Execute a delegated command (Linear/agents/patrol/checklist) and shape the
 * result into a StepResult. Three orchestration steps share this exact shape;
 * inlining was 3x copy-paste.
 *
 * `onSuccess` interprets a 0-exit result. `onNonZero` (optional) interprets a
 * non-zero exit with the captured output — defaults to truncating the first
 * line to 200 chars. Caught exceptions always become `error: <msg>`.
 */
async function runDelegate(
  label: string,
  invoke: () => Promise<CommandResult>,
  onSuccess: (result: CommandResult) => string,
  onNonZero?: (result: CommandResult) => StepResult,
): Promise<StepResult> {
  try {
    const result = await invoke();
    if (result.exitCode === 0) {
      return { label, ok: true, detail: onSuccess(result) };
    }
    if (onNonZero) return onNonZero(result);
    const firstLine = result.output.trim().split('\n')[0]?.slice(0, 200) ?? 'unknown error';
    return { label, ok: false, detail: firstLine };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { label, ok: false, detail: `error: ${msg}` };
  }
}

async function stepCompleteChecklist(): Promise<StepResult> {
  // The checklist file may not exist (quick-fix sessions) — that's a no-op.
  const checklistPath = join(PROJECT_ROOT, '.claude/wip-checklist.md');
  if (!existsSync(checklistPath)) {
    return { label: 'Checklist', ok: true, detail: 'no checklist (skipped)' };
  }
  return runDelegate(
    'Checklist',
    () => agentChecklistCommands.commands.complete([], { ci: true }),
    () => 'all items complete',
    // Exit 1 = unchecked items remain. Surface the count, but agent-end still
    // proceeds — closing the slot regardless of checklist state is by design.
    (result) => {
      const unchecked = (result.output.match(/\[ \]/g) ?? []).length;
      return { label: 'Checklist', ok: false, detail: `${unchecked} item(s) unchecked` };
    },
  );
}

async function stepLeakCheck(): Promise<StepResult> {
  return runDelegate(
    'Linear leak-check',
    () => linearCommands.commands['leak-check']([], { ci: true }),
    // leakCheck is advisory: exit 0 even when leaks exist. Surface any
    // mentioned QUA-NNN refs in the detail line.
    (result) => {
      const leaks = (result.output.match(/QUA-\d+/g) ?? []).filter(
        (v, i, a) => a.indexOf(v) === i,
      );
      return leaks.length === 0 ? 'no extra refs' : `flagged: ${leaks.join(', ')}`;
    },
  );
}

async function stepLinearDone(plan: Plan): Promise<StepResult> {
  if (!plan.linearId) {
    return { label: 'Linear done', ok: true, detail: 'no Linear ID resolved (skipped)' };
  }
  const opts: CommandOptions = { ci: true };
  if (plan.prUrl) opts.pr = plan.prUrl;
  return runDelegate(
    'Linear done',
    () => linearCommands.commands.done([plan.linearId!], opts),
    () => {
      const target = plan.prUrl ? 'In Review' : 'Done';
      const suffix = plan.prUrl ? ` (PR ${plan.prUrl})` : '';
      return `${plan.linearId} → ${target}${suffix}`;
    },
  );
}

async function stepPatrolStop(): Promise<StepResult> {
  return runDelegate(
    'Patrol daemon',
    () => prPatrolCommands.commands.stop([], { ci: true }),
    (result) =>
      result.output.toLowerCase().includes('no patrol daemon')
        ? 'not running (skipped)'
        : 'stopped',
  );
}

function stepKillDevServer(plan: Plan): StepResult {
  if (!plan.devPort) {
    return { label: 'Dev server', ok: true, detail: 'no DEV_PORT in .env (skipped)' };
  }
  // Look up listeners at execute time (not at buildPlan), so dry-run can
  // print plan-time PIDs but the kill step always operates on fresh data.
  const pids = findPortListeners(plan.devPort);
  if (pids.length === 0) {
    return { label: 'Dev server', ok: true, detail: `port ${plan.devPort} has no listener` };
  }
  const failed: number[] = [];
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // ESRCH = already gone; treat as success
      if (!msg.includes('ESRCH')) failed.push(pid);
    }
  }
  if (failed.length === 0) {
    return {
      label: 'Dev server',
      ok: true,
      detail: `killed port ${plan.devPort} (PIDs: ${pids.join(', ')})`,
    };
  }
  return {
    label: 'Dev server',
    ok: false,
    detail: `failed to kill PIDs: ${failed.join(', ')}`,
  };
}

function stepCleanWipArtifacts(): StepResult {
  const removed: string[] = [];
  const targets = [
    '.claude/wip-checklist.md',
    '.claude/wip-context.md',
  ];
  for (const rel of targets) {
    const abs = join(PROJECT_ROOT, rel);
    if (existsSync(abs)) {
      try {
        unlinkSync(abs);
        removed.push(rel);
      } catch {
        // Non-fatal; the branch reset below also runs `git clean -fd`.
      }
    }
  }
  if (removed.length === 0) {
    return { label: 'WIP artifacts', ok: true, detail: 'none to remove' };
  }
  return { label: 'WIP artifacts', ok: true, detail: `removed ${removed.length}` };
}

// Gitignored review markers — agent-end always unlinks if present (no
// git-checkout needed since git doesn't track them).
const GITIGNORED_MARKERS = ['.claude/review-phases-done', '.claude/simplify-done'];

// Tracked paths that may be modified mid-session (review-done is committed
// when the marker file exists in git history; .claude/hooks/ is the live
// session-hook scaffolding) — restore to HEAD with git checkout.
const TRACKED_RESTORE_TARGETS = ['.claude/review-done', '.claude/hooks/'];

function stepCleanReviewArtifacts(): StepResult {
  let actions = 0;

  // Unlink gitignored markers
  for (const rel of GITIGNORED_MARKERS) {
    const abs = join(PROJECT_ROOT, rel);
    if (existsSync(abs)) {
      try {
        unlinkSync(abs);
        actions++;
      } catch {
        // Non-fatal — the branch reset below will catch any leftovers via
        // `git clean -fd`. We don't fail the step on a single unlink miss.
      }
    }
  }

  // Restore tracked review artifacts
  for (const rel of TRACKED_RESTORE_TARGETS) {
    if (gitSafe('checkout', '--', rel).ok) actions++;
  }

  return {
    label: 'Review artifacts',
    ok: true,
    detail: actions === 0 ? 'nothing to restore' : `${actions} target(s)`,
  };
}

async function stepCloseAgentSession(): Promise<StepResult> {
  return runDelegate(
    'Agent session',
    () => agentsCommands.commands.close([], { ci: true }),
    () => 'closed in DB',
  );
}

function stepBranchReset(plan: Plan): StepResult {
  const isMain = plan.branch === 'main';

  // Always run the discard pair — even on main this just reverts any session
  // hook tweaks.
  const discardOk = gitSafe('checkout', '--', '.').ok;
  const cleanOk = gitSafe(
    'clean', '-fd',
    '--exclude=.agent-slot', '--exclude=.envrc', '--exclude=.env',
  ).ok;

  if (isMain) {
    if (!discardOk || !cleanOk) {
      return { label: 'Branch reset', ok: false, detail: 'on main; discard/clean failed' };
    }
    return { label: 'Branch reset', ok: true, detail: 'already on main; cleaned' };
  }

  // Guard against pathological branch states. Shouldn't happen in a healthy
  // slot, but we'd rather no-op than `git branch -D "(unknown)"`.
  if (!plan.branch || plan.branch === '(unknown)') {
    return { label: 'Branch reset', ok: false, detail: `cannot reset: branch=${plan.branch}` };
  }

  // The PreToolUse hook for branch switching is bypassed here because we are
  // running outside the Bash tool (TS execSync is a child process, not a tool
  // call). No `AGENT_RESET=1` needed.
  if (!gitSafe('checkout', 'main').ok) {
    return { label: 'Branch reset', ok: false, detail: `failed to checkout main from ${plan.branch}` };
  }

  // Refresh origin so the divergence check below uses up-to-date refs.
  gitSafe('fetch', 'origin', 'main');

  // Detect local commits on main that origin/main doesn't have. If any exist,
  // bail rather than risk discarding them via `git reset --hard origin/main`.
  // Healthy slots never accumulate local commits on main, but if a prior
  // session committed accidentally we want a loud error, not silent loss.
  const localAheadResult = gitSafe('rev-list', '--count', 'origin/main..main');
  const localAhead = localAheadResult.ok ? Number(localAheadResult.output) || 0 : 0;
  if (localAhead > 0) {
    return {
      label: 'Branch reset',
      ok: false,
      detail: `${localAhead} local commit(s) on main not in origin/main — refusing to reset; investigate by hand`,
    };
  }

  // Local main is either even with or behind origin — safe to fast-forward.
  if (!gitSafe('pull', '--ff-only', 'origin', 'main').ok) {
    return { label: 'Branch reset', ok: false, detail: 'pull --ff-only failed (network?); main is unchanged' };
  }

  // Delete the spent feature branch (best-effort — may already be gone). `-D`
  // is force-delete; safe because the branch is presumed merged or abandoned
  // by the operator running /agent-end.
  gitSafe('branch', '-D', plan.branch);

  return { label: 'Branch reset', ok: true, detail: `switched main; deleted ${plan.branch}` };
}

function stepRenameTmux(plan: Plan): StepResult {
  if (!plan.slot) return { label: 'Tmux rename', ok: true, detail: 'no .agent-slot (skipped)' };
  if (!process.env.TMUX) return { label: 'Tmux rename', ok: true, detail: 'not in tmux (skipped)' };
  const target = `A${plan.slot}`;
  if (shellSafe(`tmux rename-window "${target}"`) === null) {
    return { label: 'Tmux rename', ok: false, detail: `failed to rename to ${target}` };
  }
  return { label: 'Tmux rename', ok: true, detail: `renamed to ${target}` };
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

function planLines(plan: Plan, dirtyMode: DirtyMode): string[] {
  const isMain = plan.branch === 'main';
  return [
    `branch:    ${plan.branch}${isMain ? ' (already main — no delete)' : ''}`,
    `slot:      ${plan.slot ?? '(none)'}`,
    `linear:    ${plan.linearId ?? '(none — skip linear done)'}`,
    `pr:        ${plan.prUrl ?? '(none — Linear → Done)'}`,
    `dev port:  ${plan.devPort ?? '(none)'}`,
    `dirty:     ${dirtyMode}`,
  ];
}

async function agentEndCommand(
  _args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const log = createLogger(Boolean(options.ci));
  const c = log.colors;
  const dirtyMode = parseDirtyMode(options.dirty);
  const isDryRun = Boolean(options.dryRun);

  // Bail on unresolvable git state BEFORE running any side effects. A detached
  // HEAD returns 'HEAD' from `git rev-parse --abbrev-ref HEAD` (not the
  // commit), and an unreadable repo returns null → '(unknown)'. Either case
  // means stepBranchReset can't safely reset, so the parallel block (Linear
  // close, agents close, file unlinks) must not run.
  const branch = readCurrentBranch() ?? '(unknown)';
  if (branch === '(unknown)' || branch === 'HEAD') {
    let earlyOut = '';
    earlyOut += `${c.red}✗${c.reset} Cannot run agent-end from a detached or unknown git HEAD (got: ${branch}).\n`;
    earlyOut += `  Resolve the git state manually (e.g. \`git checkout main\`), then re-run.\n`;
    return { output: earlyOut, exitCode: 2 };
  }
  const plan = buildPlan(options, branch);

  let output = '';
  output += `${c.bold}Agent End${c.reset} — ${plan.slot ? `slot ${plan.slot}` : 'no slot marker'}${isDryRun ? ` ${c.dim}(dry-run)${c.reset}` : ''}\n`;
  output += `${c.dim}${'─'.repeat(50)}${c.reset}\n`;

  // ── 1. Dirty-state gate ────────────────────────────────────────────────
  const dirty = inspectDirtyState(branch);
  const hasUnexpectedDirty = dirty.unexpectedFiles.length > 0 || dirty.unpushedCommits > 0;
  if (hasUnexpectedDirty && dirtyMode !== 'force') {
    output += `${c.red}✗${c.reset} Dirty state requires attention (--dirty=${dirtyMode}):\n`;
    if (dirty.unexpectedFiles.length > 0) {
      output += `  ${c.yellow}Unexpected uncommitted paths:${c.reset}\n`;
      for (const f of dirty.unexpectedFiles.slice(0, 20)) output += `    ${f}\n`;
      if (dirty.unexpectedFiles.length > 20) {
        output += `    ${c.dim}... +${dirty.unexpectedFiles.length - 20} more${c.reset}\n`;
      }
    }
    if (dirty.unpushedCommits > 0) {
      output += `  ${c.yellow}${dirty.unpushedCommits} unpushed commit(s) on ${plan.branch}${c.reset}\n`;
    }
    output += '\n';
    output += `${c.dim}Options:${c.reset}\n`;
    output += `  • Commit/push/discard the changes, then re-run.\n`;
    output += `  • Re-run with ${c.cyan}--dirty=force${c.reset} to discard everything.\n`;
    return { output, exitCode: 2 };
  }

  // ── 2. Plan summary ────────────────────────────────────────────────────
  for (const line of planLines(plan, dirtyMode)) {
    output += `${c.dim}${line}${c.reset}\n`;
  }
  output += '\n';

  // ── 3. Dry-run: print and exit ─────────────────────────────────────────
  if (isDryRun) {
    // patrolPid + dev-port listeners are looked up only for dry-run reporting.
    // The real steps re-resolve at execute time, so a stale snapshot is fine.
    const patrol = patrolPid();
    const devPids = plan.devPort ? findPortListeners(plan.devPort) : [];
    const isMain = plan.branch === 'main';

    output += `${c.bold}Would execute:${c.reset}\n`;
    output += `  • agent-checklist complete\n`;
    output += `  • linear leak-check\n`;
    if (plan.linearId) {
      const target = plan.prUrl ? 'In Review' : 'Done';
      output += `  • linear done ${plan.linearId} → ${target}${plan.prUrl ? ` (PR ${plan.prUrl})` : ''}\n`;
    } else {
      output += `  • linear done — skipped (no Linear ID)\n`;
    }
    output += `  • pr-patrol stop ${patrol ? `(PID ${patrol})` : '(not running)'}\n`;
    if (plan.devPort) {
      output += `  • kill dev server on port ${plan.devPort} ${devPids.length ? `(PIDs: ${devPids.join(', ')})` : '(no listener)'}\n`;
    } else {
      output += `  • dev server — no DEV_PORT in .env\n`;
    }
    output += `  • rm .claude/wip-checklist.md, .claude/wip-context.md\n`;
    output += `  • rm gitignored markers (review-phases-done, simplify-done) + git checkout -- .claude/review-done .claude/hooks/\n`;
    output += `  • agents close (DB session)\n`;
    if (isMain) {
      output += `  • git checkout -- . && git clean -fd (already on main)\n`;
    } else {
      output += `  • git checkout -- . && git clean -fd && git checkout main && git pull && git branch -D ${plan.branch}\n`;
    }
    if (plan.slot) {
      output += `  • tmux rename-window A${plan.slot}\n`;
    }
    output += `\n${c.dim}Re-run without --dry-run to execute.${c.reset}\n`;
    return { output, exitCode: 0 };
  }

  // ── 4. Independent steps run in parallel ───────────────────────────────
  // Linear and agents-close hit the wiki-server (200–800ms each); patrol,
  // dev-server, wip-cleanup, review-artifacts are local. Running them
  // concurrently saves 1–2s per session-end. Promise.all preserves input
  // order, so the printed summary still reads sequentially.
  const parallel = await Promise.all([
    stepCompleteChecklist(),
    stepLeakCheck(),
    stepLinearDone(plan),
    stepPatrolStop(),
    Promise.resolve(stepKillDevServer(plan)),
    Promise.resolve(stepCleanWipArtifacts()),
    Promise.resolve(stepCleanReviewArtifacts()),
    stepCloseAgentSession(),
  ]);

  // ── 5. Sequential steps that mutate branch / window state ──────────────
  // Branch-reset must run after the cleanups (the discard pair expects the
  // working tree to be in its post-cleanup state). Tmux-rename is last
  // because it changes the visible window title.
  const steps = [...parallel, stepBranchReset(plan), stepRenameTmux(plan)];

  for (const s of steps) {
    const icon = s.ok ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
    output += `${icon} ${s.label.padEnd(22)} ${c.dim}${s.detail}${c.reset}\n`;
  }
  output += '\n';

  const failed = steps.filter((s) => !s.ok).length;
  if (failed > 0) {
    output += `${c.yellow}⚠ ${failed} step(s) reported errors — review above.${c.reset}\n`;
  } else {
    output += `${c.green}Done.${c.reset} Run ${c.cyan}/clear${c.reset} then ${c.cyan}/rename${c.reset} to finish handoff.\n`;
  }

  return { output, exitCode: failed > 0 ? 1 : 0 };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const commands: Record<string, (args: string[], options: CommandOptions) => Promise<CommandResult>> = {
  default: agentEndCommand,
};

export function getHelp(): string {
  return `
Agent End — Close out a session and reset the slot back to clean main

Bundles the mechanical plumbing that /agent-end used to orchestrate step by
step (Linear close, dev-server kill, wip cleanup, branch reset, tmux rename).
Run this at session end when no PR is being shipped.

Usage:
  crux sys agent-end                    Close & reset (defaults)
  crux sys agent-end --pr=URL           Pass PR URL to Linear \`done\`
  crux sys agent-end --dirty=force      Discard unexpected dirty state
  crux sys agent-end --dry-run          Print actions, take none

Options:
  --pr=URL           PR URL to attach to the Linear done comment.
                     With a PR: Linear → In Review.
                     Without:   Linear → Done.
  --dirty=MODE       fail (default) | force.
                     fail:  bail (exit 2) on unexpected dirty paths or
                            unpushed commits, listing each so the operator
                            can commit/push/discard and re-run.
                     force: discard everything (matches the old skill's
                            behaviour). Use only when you know what's dirty.
  --dry-run          Print the actions that would be taken, exit 0.
  --ci               Plain (no-color) output.

What runs (in order):
  1. agent-checklist complete           Mark checklist done in DB (best-effort)
  2. linear leak-check                  Scan for stray QUA refs (advisory)
  3. linear done QUA-NNN [--pr=URL]     QUA ID auto-resolved from checklist or branch
  4. pr-patrol stop                     Halt patrol daemon if running
  5. kill dev server on $DEV_PORT       Uses lsof -sTCP:LISTEN (port-scoped)
  6. rm .claude/wip-{checklist,context}.md
  7. rm gitignored markers (review-phases-done, simplify-done) + git checkout -- .claude/review-done .claude/hooks/
  8. agents close                       Close active agent + session row in DB
  9. git checkout main; pull --ff-only; git branch -D <feature>
  10. tmux rename-window A<slot>

Exit codes:
  0  All steps passed (or dry-run).
  1  At least one step reported an error — review the output.
  2  Bail before running any step (dirty state with --dirty=fail).

Examples:
  crux sys agent-end --dry-run
  crux sys agent-end --pr=https://github.com/quantified-uncertainty/longterm-wiki/pull/4855
  crux sys agent-end --dirty=force
`;
}
