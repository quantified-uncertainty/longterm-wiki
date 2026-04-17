/**
 * Dispatch pre-flight checks — QUA-437
 *
 * `crux sys dispatch` runs three structural checks before opening a slot,
 * so coordinators can't dispatch a duplicate claim under context pressure
 * (QUA-406 incident, where a coordinator dispatched slot a16 to fix
 * QUA-397 three hours after another session had already shipped a PR).
 *
 * Checks (all fail the dispatch unless `--force`):
 *
 *   1. Linear state — reuses `findActiveClaimsByOthers()` from
 *      `crux/lib/linear/dedup.ts`. Consults PG `agent_sessions` first,
 *      falls back to Linear start comments.
 *   2. Open PRs — reuses `findOpenPrsMentioningLinearId()`. Catches
 *      abandoned branches that PG / Linear have forgotten.
 *   3. Target slot — checks `lw/a<N>` exists, is on `main`, has a clean
 *      working tree, and has no un-pushed commits. A dirty / off-main
 *      slot would clobber in-progress work when the dispatched session
 *      creates its feature branch.
 *
 * Separated from the CLI handler so the logic is testable without
 * mocking argument parsing or tmux invocation.
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';

import {
  findActiveClaimsByOthers,
  findOpenPrsMentioningLinearId,
  type OpenPrMatch,
  type RecentStartClaim,
} from '../linear/dedup.ts';
import type { SessionContext } from '../session/session-context.ts';

export interface SlotStateCheck {
  /** Resolved absolute path to `lw/a<N>`. */
  slotDir: string;
  /** True when the slot directory exists on disk. */
  exists: boolean;
  /** `git branch --show-current` output (empty when detached / missing repo). */
  branch: string;
  /**
   * True when `git status --porcelain` is empty AND no un-pushed commits sit
   * on the current branch. A dispatch into a dirty slot risks clobbering
   * in-progress work when the new session runs `git checkout -b` or `main`
   * sync, so we treat both kinds of un-pushed state as the same class of
   * "not safe to reuse."
   */
  clean: boolean;
  /** Human-readable reason when `clean` is false or `branch !== 'main'`. */
  detail: string;
}

export interface PreflightResult {
  linearClaims: RecentStartClaim[];
  openPrs: OpenPrMatch[];
  slot: SlotStateCheck;
  /** True iff every check passed with no collisions. */
  ok: boolean;
  /** Short category tags, stable across CLI / JSON outputs. */
  blockers: Array<'linear-claim' | 'open-pr' | 'slot-missing' | 'slot-dirty' | 'slot-off-main'>;
}

export interface PreflightDeps {
  /** Override for tests — defaults to the real dedup helper. */
  findActiveClaimsByOthers?: typeof findActiveClaimsByOthers;
  /** Override for tests — defaults to the real GitHub-search helper. */
  findOpenPrsMentioningLinearId?: typeof findOpenPrsMentioningLinearId;
  /** Override for tests — defaults to `runSlotState`. */
  inspectSlot?: (slotDir: string) => SlotStateCheck;
}

/**
 * Inspect a slot directory with the same read-only git commands `./ws list`
 * uses. `-C <slotDir>` avoids `cd`-ing into the slot (slot-isolation rule):
 * we're reading state, not modifying anything. Short timeouts keep a hung
 * or NFS-stalled slot from wedging the dispatcher.
 */
export function runSlotState(slotDir: string): SlotStateCheck {
  if (!existsSync(slotDir)) {
    return { slotDir, exists: false, branch: '', clean: false, detail: 'slot directory does not exist' };
  }
  const branch = safeGit(slotDir, ['branch', '--show-current']);
  const porcelain = safeGit(slotDir, ['status', '--porcelain']);
  // `@{u}` resolves to the upstream branch — missing when the branch has no
  // upstream (the slot is on a local-only branch or a fresh checkout). We
  // treat "no upstream" as clean since the local-only branch case is already
  // flagged by the off-main check.
  const unpushed = safeGit(slotDir, ['log', '@{u}..HEAD', '--oneline']);
  const dirty = porcelain.length > 0;
  const hasUnpushed = unpushed.length > 0;
  const clean = !dirty && !hasUnpushed;

  let detail = '';
  if (!branch) detail = 'detached HEAD';
  else if (branch !== 'main') detail = `on branch '${branch}' (expected 'main')`;
  else if (dirty) {
    const firstLines = porcelain.split('\n').slice(0, 3).join('; ');
    detail = `uncommitted changes: ${firstLines}`;
  } else if (hasUnpushed) {
    const firstLines = unpushed.split('\n').slice(0, 3).join('; ');
    detail = `unpushed commits: ${firstLines}`;
  }

  return { slotDir, exists: true, branch, clean, detail };
}

function safeGit(cwd: string, args: string[]): string {
  try {
    return execSync(`git ${args.join(' ')}`, {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // Treat all git failures as "no output." The detail string elsewhere
    // already captures the likely cause (missing dir, detached HEAD, etc.).
    return '';
  }
}

/**
 * Run all three pre-flight checks in parallel where possible, collect
 * results, and compute a single `ok` flag + list of blocker tags.
 * Callers decide whether to refuse (default) or proceed past blockers
 * (via `--force`).
 */
export async function runPreflight(
  linearId: string,
  slotDir: string,
  ctx: SessionContext,
  deps: PreflightDeps = {},
): Promise<PreflightResult> {
  const claimsFn = deps.findActiveClaimsByOthers ?? findActiveClaimsByOthers;
  const prsFn = deps.findOpenPrsMentioningLinearId ?? findOpenPrsMentioningLinearId;
  const slotFn = deps.inspectSlot ?? runSlotState;

  const [linearClaims, openPrs, slot] = await Promise.all([
    claimsFn(linearId, ctx),
    prsFn(linearId),
    Promise.resolve(slotFn(slotDir)),
  ]);

  const blockers: PreflightResult['blockers'] = [];
  if (linearClaims.length > 0) blockers.push('linear-claim');
  if (openPrs.length > 0) blockers.push('open-pr');
  if (!slot.exists) blockers.push('slot-missing');
  else if (slot.branch !== 'main') blockers.push('slot-off-main');
  else if (!slot.clean) blockers.push('slot-dirty');

  return {
    linearClaims,
    openPrs,
    slot,
    ok: blockers.length === 0,
    blockers,
  };
}
