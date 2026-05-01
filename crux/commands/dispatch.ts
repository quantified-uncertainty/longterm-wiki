/**
 * `crux sys dispatch` — QUA-437
 *
 * Structural wrapper around `./ws open <N> --claude` that enforces the
 * dispatch pre-flight checks (`docs/agent-rules/dispatched-agent-review.md`
 * § "Dispatcher pre-flight") before opening a slot. Designed to make
 * the checks unskippable under context pressure — the coordinator
 * cannot hand-roll their way around a wrapper that exits non-zero on
 * collision.
 *
 * Motivating incident: QUA-406 — a coordinator session filed QUA-397,
 * then dispatched slot a16 to fix it three hours later without noticing
 * slot a9 had already shipped a PR. Two shipping PRs, ~$100 of
 * duplicated work. The root cause wasn't tooling (the signals existed)
 * — it was that the coordinator had all the information and didn't
 * use it under load. A CLI wrapper that refuses on collision closes
 * that behavioral gap.
 *
 * Usage:
 *   crux sys dispatch --linear=QUA-NNN --slot=N [--brief=<path>] [--force --reason="..."] [--dry-run]
 *
 * Exit codes:
 *   0  dispatched (or dry-run succeeded)
 *   1  argument / environment error
 *   2  pre-flight collision (matches `crux linear start` exit code)
 */

import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';
import { createLogger, type Logger } from '../lib/output.ts';
import { parseLinearId } from '../lib/linear/parse-id.ts';
import { getIssue, commentOnIssue } from '../lib/linear/issues.ts';
import { getSessionContext } from '../lib/session/session-context.ts';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { runPreflight, type PreflightResult } from '../lib/dispatch/preflight.ts';
import { appendDispatchLog } from '../lib/dispatch/audit-log.ts';

interface CommandOptions extends BaseOptions {
  linear?: string;
  slot?: string;
  brief?: string;
  force?: boolean;
  reason?: string;
  dryRun?: boolean;
  json?: boolean;
  ci?: boolean;
}

export interface DispatchDeps {
  /** Override for tests — defaults to the real Linear issue helper. */
  getIssue?: typeof getIssue;
  /** Override for tests — defaults to the real comment helper. No-op swallowed on failure. */
  commentOnIssue?: typeof commentOnIssue;
  /** Override for tests — defaults to `getSessionContext()`. */
  getSessionContext?: typeof getSessionContext;
  /** Override for tests — defaults to `runPreflight`. */
  runPreflight?: typeof runPreflight;
  /** Override for tests — defaults to `appendDispatchLog`. */
  appendDispatchLog?: typeof appendDispatchLog;
  /** Override for tests — defaults to shelling out to `./ws open <N> --claude`. */
  openSlot?: (slot: number, lwDir: string) => { ok: boolean; error?: string };
  /** Override for tests — defaults to `process.cwd()` / path joins from PROJECT_ROOT. */
  resolveLwDir?: () => string;
}

/**
 * Resolve the `lw/` workspace root by walking up from PROJECT_ROOT.
 * Matches the heuristic in `agent-workspace.ts::getLwDir` — if PROJECT_ROOT
 * looks like an agent slot (`a<N>`) or `main` under a `lw/` directory,
 * return the parent; otherwise assume lw/ is a sibling.
 */
export function resolveLwDir(): string {
  const parent = dirname(PROJECT_ROOT);
  const dirName = PROJECT_ROOT.split('/').pop() ?? '';
  if (/^(a\d+|main|coord)$/.test(dirName) && parent.endsWith('/lw')) return parent;
  return join(parent, 'lw');
}

/**
 * Open the target slot with `./ws open <N> --claude`. Uses the `./ws`
 * script rather than invoking `pnpm crux agent-workspace open` directly
 * because `./ws` knows the absolute lw/ directory layout and tmux hook
 * overlay logic. Requires `$TMUX` to be set (same precondition the
 * underlying `open` handler already enforces).
 */
function openSlotViaWs(slot: number, lwDir: string): { ok: boolean; error?: string } {
  const wsScript = join(lwDir, 'ws');
  if (!existsSync(wsScript)) {
    return { ok: false, error: `Workspace script not found at ${wsScript}` };
  }
  const res = spawnSync(wsScript, ['open', String(slot), '--claude'], {
    cwd: lwDir,
    stdio: 'inherit',
    encoding: 'utf-8',
  });
  if (res.status === 0) return { ok: true };
  return { ok: false, error: `./ws open ${slot} --claude exited with status ${res.status ?? 'unknown'}` };
}

export const FORCE_COMMENT_PREAMBLE = '⚠ Claim forced via `crux sys dispatch --force`';

export function buildForceClaimComment(params: {
  dispatcherSlot: number | null;
  dispatcherBranch: string;
  targetSlot: number;
  reason: string;
}): string {
  const dispatcherTag = params.dispatcherSlot !== null
    ? `slot a${params.dispatcherSlot}`
    : `branch \`${params.dispatcherBranch}\``;
  return [
    `${FORCE_COMMENT_PREAMBLE} from ${dispatcherTag}.`,
    `Dispatching to slot a${params.targetSlot}.`,
    '',
    `**Reason:** ${params.reason}`,
    '',
    'The dispatched session will run `agent-checklist init --force` and should reconcile ' +
      'with any prior claimant (close the competing PR, coordinate the handoff, or ' +
      'document the abandonment in this ticket).',
  ].join('\n');
}

export function buildDispatchBriefCopy(params: {
  linearId: string;
  targetSlot: number;
  dispatcherBranch: string;
  briefBody: string;
}): string {
  return [
    `<!-- Dispatched via \`crux sys dispatch\` on ${new Date().toISOString()}`,
    `     Linear:   ${params.linearId}`,
    `     Slot:     a${params.targetSlot}`,
    `     Dispatcher branch: ${params.dispatcherBranch}`,
    '-->',
    '',
    params.briefBody.trimEnd(),
    '',
  ].join('\n');
}

/**
 * Stage the dispatch brief inside the target slot so the opened Claude
 * session can `cat .claude/dispatch-brief.md` on its first turn.
 *
 * Returns the absolute path on success, null if no `--brief` was passed,
 * or an error string if the brief file is missing / unreadable.
 */
function stageBrief(
  briefPath: string | undefined,
  linearId: string,
  targetSlot: number,
  targetSlotDir: string,
  dispatcherBranch: string,
): { path: string } | { error: string } | null {
  if (!briefPath) return null;
  let briefBody: string;
  try {
    briefBody = readFileSync(briefPath, 'utf-8');
  } catch (e) {
    return { error: `Could not read brief at ${briefPath}: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!briefBody.trim()) {
    return { error: `Brief file ${briefPath} is empty` };
  }

  const dest = join(targetSlotDir, '.claude', 'dispatch-brief.md');
  try {
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(
      dest,
      buildDispatchBriefCopy({ linearId, targetSlot, dispatcherBranch, briefBody }),
    );
    return { path: dest };
  } catch (e) {
    return { error: `Could not write staged brief to ${dest}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function parseSlotNumber(raw: string | undefined): number | { error: string } {
  if (!raw) return { error: '--slot=<N> is required' };
  if (!/^\d+$/.test(raw)) return { error: `--slot must be a positive integer (got: ${raw})` };
  const n = Number.parseInt(raw, 10);
  if (n < 1) return { error: '--slot must be >= 1' };
  return n;
}

function formatPreflightBlockers(pf: PreflightResult, c: Logger['colors']): string {
  let out = '';
  if (pf.linearClaims.length > 0) {
    const label = pf.linearClaims.length === 1 ? 'Active Linear claim' : `${pf.linearClaims.length} active Linear claims`;
    out += `  ${c.bold}${label}${c.reset} (from a different slot, <24h):\n`;
    for (const claim of pf.linearClaims) {
      const firstLine = claim.body.split('\n').find((l) => l.trim().length > 0) ?? '';
      const tag =
        `slot=${claim.slot ?? '?'} ` +
        `branch=${claim.branch ?? '?'} ` +
        `at=${claim.createdAt}`;
      out += `    ${c.dim}${tag}${c.reset}\n`;
      out += `    ${firstLine.slice(0, 120)}\n`;
    }
    out += '\n';
  }
  if (pf.openPrs.length > 0) {
    const label = pf.openPrs.length === 1 ? 'Open PR' : `${pf.openPrs.length} open PRs`;
    out += `  ${c.bold}${label}${c.reset} referencing this ticket:\n`;
    for (const pr of pf.openPrs) {
      out += `    ${c.cyan}#${pr.number}${c.reset} ${pr.title}\n`;
      out += `    ${c.dim}${pr.url}${c.reset}\n`;
    }
    out += '\n';
  }
  if (!pf.slot.exists) {
    out += `  ${c.bold}Target slot${c.reset}: directory does not exist (${pf.slot.slotDir})\n\n`;
  } else if (pf.slot.branch !== 'main' || !pf.slot.clean) {
    out += `  ${c.bold}Target slot${c.reset}: ${pf.slot.detail || 'not in a reusable state'}\n`;
    out += `    ${c.dim}${pf.slot.slotDir}${c.reset}\n\n`;
  }
  return out;
}

async function dispatchDefault(
  args: string[],
  options: CommandOptions,
  deps: DispatchDeps = {},
): Promise<CommandResult> {
  const log = createLogger(options.ci);
  const c = log.colors;

  // ── 1. Parse + validate arguments ──────────────────────────────────────
  const linearRaw = typeof options.linear === 'string' ? options.linear : args[0];
  const linearId = parseLinearId(linearRaw);
  if (!linearId) {
    return {
      output:
        `${c.red}Usage: crux sys dispatch --linear=QUA-NNN --slot=N ` +
        `[--brief=<path>] [--force --reason="..."] [--dry-run]${c.reset}\n`,
      exitCode: 1,
    };
  }

  const slotResult = parseSlotNumber(options.slot);
  if (typeof slotResult !== 'number') {
    return { output: `${c.red}Error: ${slotResult.error}${c.reset}\n`, exitCode: 1 };
  }
  const targetSlot = slotResult;

  if (options.force && !options.reason) {
    return {
      output:
        `${c.red}Error: --force requires --reason="<why>".${c.reset}\n` +
        `  Forced claims leave an audit trail in the Linear ticket; without a reason the ` +
        `claim looks arbitrary to reviewers reading the ticket later.\n`,
      exitCode: 1,
    };
  }

  // ── 2. Resolve workspace + target slot paths ───────────────────────────
  const lwDir = (deps.resolveLwDir ?? resolveLwDir)();
  const targetSlotDir = join(lwDir, `a${targetSlot}`);

  // ── 3. Fetch issue (confirms it exists + gives us the URL for output) ──
  const issueFn = deps.getIssue ?? getIssue;
  const issue = await issueFn(linearId).catch(() => null);
  if (!issue) {
    return {
      output: `${c.red}Linear issue ${linearId} not found (or Linear API unreachable)${c.reset}\n`,
      exitCode: 1,
    };
  }

  // ── 4. Run pre-flight checks (three signals in parallel) ───────────────
  const ctx = (deps.getSessionContext ?? getSessionContext)();
  const runPf = deps.runPreflight ?? runPreflight;
  const preflight = await runPf(linearId, targetSlotDir, ctx);

  const logEntryBase = {
    linearId,
    slot: targetSlot,
    force: !!options.force,
    forceReason: options.reason ?? null,
    dispatcherSlot: ctx.slot,
    dispatcherBranch: ctx.branch,
    pid: process.pid,
    blockers: [...preflight.blockers].sort(),
    briefPath: options.brief ?? null,
  };
  const auditLog = deps.appendDispatchLog ?? appendDispatchLog;

  // ── 5. On collision without --force: refuse with exit code 2 ───────────
  if (!preflight.ok && !options.force) {
    auditLog({ ...logEntryBase, outcome: 'refused' });
    let out = `${c.red}✗ Pre-flight blocked dispatch of ${linearId} to slot a${targetSlot}.${c.reset}\n\n`;
    out += formatPreflightBlockers(preflight, c);
    out += `  ${c.yellow}Investigate before dispatching.${c.reset} Either continue the in-flight session, ` +
      `comment on the open PR instead of opening a new one, or — if you're certain the prior claim is ` +
      `abandoned — re-run with:\n`;
    out += `    ${c.bold}crux sys dispatch --linear=${linearId} --slot=${targetSlot} --force --reason="<why>"${c.reset}\n\n`;
    out += `  Issue: ${issue.url}\n`;
    return { output: out, exitCode: 2 };
  }

  // ── 6. Stage the dispatch brief (if provided) ──────────────────────────
  const brief = stageBrief(
    options.brief,
    linearId,
    targetSlot,
    targetSlotDir,
    ctx.branch,
  );
  if (brief && 'error' in brief) {
    return { output: `${c.red}Error: ${brief.error}${c.reset}\n`, exitCode: 1 };
  }
  const briefStagedPath = brief && 'path' in brief ? brief.path : null;

  // ── 7. On --force: post a reconciliation comment to Linear ─────────────
  // Best-effort: if the comment fails, we still dispatch — the audit log
  // captures the force event either way. Failing to post a comment should
  // not block an emergency dispatch.
  if (options.force && !options.dryRun) {
    const commentFn = deps.commentOnIssue ?? commentOnIssue;
    const body = buildForceClaimComment({
      dispatcherSlot: ctx.slot,
      dispatcherBranch: ctx.branch,
      targetSlot,
      reason: options.reason ?? '(no reason given)',
    });
    try {
      await commentFn(linearId, body);
    } catch {
      // Swallow; we'll note it in the CLI output below.
    }
  }

  // ── 8. Dry-run short-circuit ───────────────────────────────────────────
  if (options.dryRun) {
    auditLog({ ...logEntryBase, outcome: 'dry-run' });
    let out = '';
    out += `${c.green}✓${c.reset} Pre-flight ${preflight.ok ? 'passed' : c.yellow + 'would be forced' + c.reset}`;
    out += ` for ${c.cyan}${linearId}${c.reset} → slot a${targetSlot}\n`;
    out += `  ${c.dim}(dry-run — did not open ./ws)${c.reset}\n`;
    if (briefStagedPath) out += `  Brief staged: ${c.cyan}${briefStagedPath}${c.reset}\n`;
    out += `  Issue: ${issue.url}\n`;
    return { output: out, exitCode: 0 };
  }

  // ── 9. Open the slot ───────────────────────────────────────────────────
  if (!process.env.TMUX) {
    return {
      output:
        `${c.red}Error: not inside a tmux session — cannot invoke ./ws open.${c.reset}\n` +
        `  Start a tmux session first, or use --dry-run to validate pre-flight without opening a slot.\n`,
      exitCode: 1,
    };
  }
  const opener = deps.openSlot ?? openSlotViaWs;
  const openResult = opener(targetSlot, lwDir);
  if (!openResult.ok) {
    auditLog({ ...logEntryBase, outcome: 'refused', blockers: [...logEntryBase.blockers, 'open-failed'].sort() });
    return {
      output: `${c.red}Error opening slot a${targetSlot}: ${openResult.error ?? 'unknown'}${c.reset}\n`,
      exitCode: 1,
    };
  }

  auditLog({ ...logEntryBase, outcome: options.force ? 'forced' : 'dispatched' });

  // ── 10. Success output ─────────────────────────────────────────────────
  let out = '';
  out += `${c.green}✓${c.reset} Dispatched ${c.cyan}${linearId}${c.reset} → slot a${targetSlot}\n`;
  if (options.force) {
    out += `  ${c.yellow}⚠ Forced past pre-flight${c.reset} — reason: ${options.reason}\n`;
    out += `  ${c.dim}Reconciliation comment posted on ${linearId}${c.reset}\n`;
  }
  if (briefStagedPath) {
    out += `  Brief:   ${c.cyan}${briefStagedPath}${c.reset}\n`;
    out += `  ${c.dim}In the new session: cat .claude/dispatch-brief.md${c.reset}\n`;
  }
  out += `  Issue:   ${issue.url}\n`;
  out += `  Audit:   ${c.dim}~/.cache/crux-dispatch/log.jsonl${c.reset}\n`;
  return { output: out, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { dispatchDefault };

export const commands: Record<string, (args: string[], options: CommandOptions) => Promise<CommandResult>> = {
  default: (args, options) => dispatchDefault(args, options),
};

export function getHelp(): string {
  return `
# Dispatch — Open an agent slot after the three dispatch pre-flight checks (QUA-437)

Usage:
  crux sys dispatch --linear=QUA-NNN --slot=N [options]

Arguments:
  --linear=QUA-NNN    Required. The Linear issue the dispatched session should work on.
  --slot=N            Required. Target agent slot (lw/a<N>). Must exist, be on main, and clean.

Pre-flight checks (all block the dispatch unless --force):
  1. Linear state     — no active claim from a different session in the last 24h
                        (consults PG agent_sessions first, then Linear start comments).
  2. Open PRs         — no open PR in the wiki repo mentions this Linear ID.
  3. Target slot      — lw/a<N> exists, git branch is 'main', working tree clean,
                        no un-pushed commits.

Options:
  --brief=<path>      Copy a dispatch brief into lw/a<N>/.claude/dispatch-brief.md so the
                      new Claude session can 'cat' it on its first turn.
  --force             Override pre-flight blockers. Requires --reason.
  --reason="<why>"    Required when --force is set. Posted as a Linear comment AND written
                      to the audit log. Forced claims stay visible in the ticket timeline.
  --dry-run           Run pre-flight + report, but do not open the slot. Useful in tests
                      and for coordinators who want to verify cleanliness before committing.
  --json              Emit machine-readable output (not yet implemented for this command).
  --ci                Disable colors / interactive formatting.

Exit codes:
  0    Dispatched (or dry-run succeeded).
  1    Argument / environment error (bad flags, no tmux, Linear unreachable).
  2    Pre-flight collision — another session already claims this ticket. Rerun with
       --force --reason=... if the prior claim is genuinely abandoned.

Examples:
  crux sys dispatch --linear=QUA-440 --slot=7
  crux sys dispatch --linear=QUA-440 --slot=7 --brief=../dispatch/qua-440.md
  crux sys dispatch --linear=QUA-397 --slot=7 --force --reason="slot a9 abandoned, PR #4296 closed"
  crux sys dispatch --linear=QUA-440 --slot=7 --dry-run

See docs/agent-rules/dispatched-agent-review.md § "Dispatcher pre-flight" for the full rule
this wrapper enforces, and QUA-406 / QUA-437 for the incident history that motivated it.
`;
}
