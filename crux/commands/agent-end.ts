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

function exec(cmd: string, timeoutMs = 30000): string {
  return execSync(cmd, { encoding: 'utf-8', timeout: timeoutMs, cwd: PROJECT_ROOT }).trim();
}

function execSafe(cmd: string, timeoutMs = 30000): string | null {
  try {
    return exec(cmd, timeoutMs);
  } catch {
    return null;
  }
}

/**
 * Like execSafe but preserves whitespace. Use for command output where leading
 * whitespace is semantic — notably `git status --porcelain` (a leading space in
 * column 0 means "no staged change", and `.trim()` would corrupt the layout).
 */
function execRawSafe(cmd: string, timeoutMs = 30000): string | null {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: timeoutMs, cwd: PROJECT_ROOT });
  } catch {
    return null;
  }
}

/**
 * Read the Linear ID from the wip checklist (`> Linear: QUA-NNN`) first,
 * then fall back to parsing the current branch (`claude/qua-NNN-...`).
 */
export function resolveLinearId(): string | null {
  const checklistPath = join(PROJECT_ROOT, '.claude/wip-checklist.md');
  if (existsSync(checklistPath)) {
    const md = readFileSync(checklistPath, 'utf-8');
    const m = md.match(/^>\s*Linear:\s*([A-Z]+-\d+)/m);
    if (m) return m[1];
  }
  const branch = execSafe('git rev-parse --abbrev-ref HEAD');
  if (branch) {
    const m = branch.match(/claude\/(qua-\d+)/i);
    if (m) return m[1].toUpperCase();
  }
  return null;
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
 * Read .agent-slot (e.g. "7" → 7). Returns null if missing or unparsable.
 */
export function readSlotNumber(): string | null {
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
  const out = execSafe(`lsof -ti:${port} -sTCP:LISTEN`);
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
export function inspectDirtyState(): DirtyStatus {
  // execRawSafe (no trim): porcelain output uses two columns where column 0
  // can legitimately be a space (" M file" = unstaged modify). Trim would
  // corrupt the slice(3).
  const status = execRawSafe('git status --porcelain') ?? '';
  const branch = execSafe('git rev-parse --abbrev-ref HEAD') ?? '(unknown)';

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
  if (branch !== 'main' && branch !== '(unknown)') {
    // 2>/dev/null swallows the "no upstream configured" error that fires for
    // branches that were never pushed (research/abandoned sessions).
    const counted = execSafe('git rev-list --count @{u}..HEAD 2>/dev/null');
    if (counted) unpushedCommits = Number(counted) || 0;
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
  devPids: number[];
  patrolPid: number | null;
  isMain: boolean;
}

function buildPlan(options: CommandOptions): Plan {
  const branch = execSafe('git rev-parse --abbrev-ref HEAD') ?? '(unknown)';
  const linearId = resolveLinearId();
  const slot = readSlotNumber();
  const devPort = readDevPort();
  const devPids = devPort ? findPortListeners(devPort) : [];
  const patrolPid = (() => {
    try {
      // Reuse pr-patrol's daemon registry — same source the `stop` command uses.
      // Falling back to null if anything throws.
      const out = execSafe('pgrep -f "crux gh pr-patrol run" 2>/dev/null') ?? '';
      const first = out.split('\n').find(Boolean);
      return first ? Number(first) : null;
    } catch {
      return null;
    }
  })();

  return {
    linearId,
    prUrl: typeof options.pr === 'string' ? options.pr : null,
    branch,
    slot,
    devPort,
    devPids,
    patrolPid,
    isMain: branch === 'main',
  };
}

async function stepCompleteChecklist(_opts: CommandOptions): Promise<StepResult> {
  // The checklist file may not exist (quick-fix sessions) — that's a no-op.
  const checklistPath = join(PROJECT_ROOT, '.claude/wip-checklist.md');
  if (!existsSync(checklistPath)) {
    return { label: 'Checklist', ok: true, detail: 'no checklist (skipped)' };
  }
  const result = await agentChecklistCommands.commands.complete([], { ci: true });
  // exitCode 0 = complete, 1 = unchecked items remain. Either way we proceed
  // (the checklist command surfaces the warning; agent-end is meant to close
  // the slot regardless of checklist state).
  if (result.exitCode === 0) {
    return { label: 'Checklist', ok: true, detail: 'all items complete' };
  }
  const unchecked = (result.output.match(/\[ \]/g) ?? []).length;
  return { label: 'Checklist', ok: false, detail: `${unchecked} item(s) unchecked` };
}

async function stepLeakCheck(_opts: CommandOptions): Promise<StepResult> {
  const result = await linearCommands.commands['leak-check']([], { ci: true });
  // leakCheck is advisory and returns exit 0 even when leaks exist — the
  // command's printed output names any leaked refs.
  const leaks = (result.output.match(/QUA-\d+/g) ?? []).filter((v, i, a) => a.indexOf(v) === i);
  if (leaks.length === 0) return { label: 'Linear leak-check', ok: true, detail: 'no extra refs' };
  return { label: 'Linear leak-check', ok: true, detail: `flagged: ${leaks.join(', ')}` };
}

async function stepLinearDone(plan: Plan): Promise<StepResult> {
  if (!plan.linearId) {
    return { label: 'Linear done', ok: true, detail: 'no Linear ID resolved (skipped)' };
  }
  const opts: CommandOptions = { ci: true };
  if (plan.prUrl) opts.pr = plan.prUrl;
  try {
    const result = await linearCommands.commands.done([plan.linearId], opts);
    if (result.exitCode === 0) {
      const target = plan.prUrl ? 'In Review' : 'Done';
      const suffix = plan.prUrl ? ` (PR ${plan.prUrl})` : '';
      return { label: 'Linear done', ok: true, detail: `${plan.linearId} → ${target}${suffix}` };
    }
    return { label: 'Linear done', ok: false, detail: result.output.trim().slice(0, 200) };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { label: 'Linear done', ok: false, detail: `error: ${msg}` };
  }
}

async function stepPatrolStop(_opts: CommandOptions): Promise<StepResult> {
  try {
    const result = await prPatrolCommands.commands.stop([], { ci: true });
    if (result.output.toLowerCase().includes('no patrol daemon')) {
      return { label: 'Patrol daemon', ok: true, detail: 'not running (skipped)' };
    }
    if (result.exitCode === 0) {
      return { label: 'Patrol daemon', ok: true, detail: 'stopped' };
    }
    return { label: 'Patrol daemon', ok: false, detail: result.output.trim().slice(0, 200) };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { label: 'Patrol daemon', ok: false, detail: `error: ${msg}` };
  }
}

function stepKillDevServer(plan: Plan): StepResult {
  if (!plan.devPort) {
    return { label: 'Dev server', ok: true, detail: 'no DEV_PORT in .env (skipped)' };
  }
  if (plan.devPids.length === 0) {
    return { label: 'Dev server', ok: true, detail: `port ${plan.devPort} has no listener` };
  }
  const failed: number[] = [];
  for (const pid of plan.devPids) {
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
      detail: `killed port ${plan.devPort} (PIDs: ${plan.devPids.join(', ')})`,
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
    if (execSafe(`git checkout -- "${rel}"`) !== null) actions++;
  }

  return {
    label: 'Review artifacts',
    ok: true,
    detail: actions === 0 ? 'nothing to restore' : `${actions} target(s)`,
  };
}

async function stepCloseAgentSession(_opts: CommandOptions): Promise<StepResult> {
  try {
    const result = await agentsCommands.commands.close([], { ci: true });
    if (result.exitCode === 0) {
      return { label: 'Agent session', ok: true, detail: 'closed in DB' };
    }
    return {
      label: 'Agent session',
      ok: false,
      detail: result.output.trim().split('\n')[0]?.slice(0, 200) ?? 'unknown error',
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { label: 'Agent session', ok: false, detail: `error: ${msg}` };
  }
}

function stepBranchReset(plan: Plan): StepResult {
  // Always run the discard pair — even on main this just reverts any session
  // hook tweaks.
  const discardOk = execSafe('git checkout -- .') !== null;
  const cleanOk =
    execSafe('git clean -fd --exclude=.agent-slot --exclude=.envrc --exclude=.env') !== null;

  if (plan.isMain) {
    if (!discardOk || !cleanOk) {
      return { label: 'Branch reset', ok: false, detail: 'on main; discard/clean failed' };
    }
    return { label: 'Branch reset', ok: true, detail: 'already on main; cleaned' };
  }

  // Guard against pathological branch states. These shouldn't happen in a
  // healthy slot, but we'd rather no-op than `git branch -D "(unknown)"`.
  if (!plan.branch || plan.branch === '(unknown)') {
    return { label: 'Branch reset', ok: false, detail: `cannot reset: branch=${plan.branch}` };
  }

  // The PreToolUse hook for branch switching is bypassed here because we are
  // running outside the Bash tool (TS execSync is a child process, not a tool
  // call). No `AGENT_RESET=1` needed.
  if (execSafe('git checkout main') === null) {
    return { label: 'Branch reset', ok: false, detail: `failed to checkout main from ${plan.branch}` };
  }

  // Refresh origin so the divergence check below uses up-to-date refs.
  execSafe('git fetch origin main', 30000);

  // Detect local commits on main that origin/main doesn't have. If any exist,
  // bail rather than risk discarding them via `git reset --hard origin/main`.
  // Healthy slots never accumulate local commits on main, but if a prior
  // session committed accidentally we want a loud error, not silent loss.
  const localAhead = Number(execSafe('git rev-list --count origin/main..main 2>/dev/null') ?? '0');
  if (localAhead > 0) {
    return {
      label: 'Branch reset',
      ok: false,
      detail: `${localAhead} local commit(s) on main not in origin/main — refusing to reset; investigate by hand`,
    };
  }

  // Local main is either even with or behind origin — safe to fast-forward.
  if (execSafe('git pull --ff-only origin main', 30000) === null) {
    return { label: 'Branch reset', ok: false, detail: 'pull --ff-only failed (network?); main is unchanged' };
  }

  // Delete the spent feature branch (best-effort — may already be gone). `-D`
  // is force-delete; safe because the branch is presumed merged or abandoned
  // by the operator running /agent-end.
  execSafe(`git branch -D "${plan.branch}"`);

  return { label: 'Branch reset', ok: true, detail: `switched main; deleted ${plan.branch}` };
}

function stepRenameTmux(plan: Plan): StepResult {
  if (!plan.slot) return { label: 'Tmux rename', ok: true, detail: 'no .agent-slot (skipped)' };
  if (!process.env.TMUX) return { label: 'Tmux rename', ok: true, detail: 'not in tmux (skipped)' };
  const target = `A${plan.slot}`;
  if (execSafe(`tmux rename-window "${target}"`) === null) {
    return { label: 'Tmux rename', ok: false, detail: `failed to rename to ${target}` };
  }
  return { label: 'Tmux rename', ok: true, detail: `renamed to ${target}` };
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

function planLines(plan: Plan, dirtyMode: DirtyMode): string[] {
  const out: string[] = [];
  out.push(`branch:    ${plan.branch}${plan.isMain ? ' (already main — no delete)' : ''}`);
  out.push(`slot:      ${plan.slot ?? '(none)'}`);
  out.push(`linear:    ${plan.linearId ?? '(none — skip linear done)'}`);
  out.push(`pr:        ${plan.prUrl ?? '(none — Linear → Done)'}`);
  out.push(`dev port:  ${plan.devPort ?? '(none)'}${plan.devPids.length ? ` PIDs ${plan.devPids.join(', ')}` : ''}`);
  out.push(`patrol:    ${plan.patrolPid ?? '(not running)'}`);
  out.push(`dirty:     ${dirtyMode}`);
  return out;
}

async function agentEndCommand(
  _args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const log = createLogger(Boolean(options.ci));
  const c = log.colors;
  const dirtyMode = parseDirtyMode(options.dirty);
  const isDryRun = Boolean(options.dryRun);

  const plan = buildPlan(options);

  let output = '';
  output += `${c.bold}Agent End${c.reset} — ${plan.slot ? `slot ${plan.slot}` : 'no slot marker'}${isDryRun ? ` ${c.dim}(dry-run)${c.reset}` : ''}\n`;
  output += `${c.dim}${'─'.repeat(50)}${c.reset}\n`;

  // ── 1. Dirty-state gate ────────────────────────────────────────────────
  const dirty = inspectDirtyState();
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
    output += `${c.bold}Would execute:${c.reset}\n`;
    output += `  • agent-checklist complete\n`;
    output += `  • linear leak-check\n`;
    if (plan.linearId) {
      const target = plan.prUrl ? 'In Review' : 'Done';
      output += `  • linear done ${plan.linearId} → ${target}${plan.prUrl ? ` (PR ${plan.prUrl})` : ''}\n`;
    } else {
      output += `  • linear done — skipped (no Linear ID)\n`;
    }
    output += `  • pr-patrol stop ${plan.patrolPid ? `(PID ${plan.patrolPid})` : '(not running)'}\n`;
    if (plan.devPort) {
      output += `  • kill dev server on port ${plan.devPort} ${plan.devPids.length ? `(PIDs: ${plan.devPids.join(', ')})` : '(no listener)'}\n`;
    } else {
      output += `  • dev server — no DEV_PORT in .env\n`;
    }
    output += `  • rm .claude/wip-checklist.md, .claude/wip-context.md\n`;
    output += `  • rm gitignored markers (review-phases-done, simplify-done) + git checkout -- .claude/review-done .claude/hooks/\n`;
    output += `  • agents close (DB session)\n`;
    if (plan.isMain) {
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

  // ── 4. Execute steps in order ──────────────────────────────────────────
  const steps: StepResult[] = [];

  steps.push(await stepCompleteChecklist(options));
  steps.push(await stepLeakCheck(options));
  steps.push(await stepLinearDone(plan));
  steps.push(await stepPatrolStop(options));
  steps.push(stepKillDevServer(plan));
  steps.push(stepCleanWipArtifacts());
  steps.push(stepCleanReviewArtifacts());
  steps.push(await stepCloseAgentSession(options));
  steps.push(stepBranchReset(plan));
  steps.push(stepRenameTmux(plan));

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
