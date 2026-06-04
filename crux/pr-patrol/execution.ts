/**
 * PR Patrol — Claude spawning, PR fixing, main branch fixing, claim management
 *
 * Main branch CI checking uses crux/lib/pr-analysis/ci-status.ts (pure API call).
 * This module wraps it with daemon concerns (cooldown, abandoned tracking, logging).
 *
 * Automated rebase uses crux/lib/pr-analysis/rebase.ts for stale or conflicting
 * PRs before falling back to Claude when the rebase can't auto-resolve.
 */

import { spawn } from 'child_process';
import { githubApi } from '../lib/github.ts';
import { git, createWorktree, removeWorktree } from '../lib/git.ts';
import { checkMainBranch as libCheckMainBranch, findRecentMerges as libFindRecentMerges } from '../lib/pr-analysis/index.ts';
import { ANY_WORKING_LABELS } from '../lib/labels.ts';
import type { RecentMerge } from '../lib/pr-analysis/index.ts';
import { tryRebaseAndVerify } from './rebase-verify.ts';
import {
  tryClaimPr,
  releasePrIfClaimed,
  defaultClaimDeps,
  type ClaimDeps,
} from './claim.ts';
import type { FixOutcome, MainBranchStatus, PatrolConfig, ScoredPr } from './types.ts';
import { LABELS } from './types.ts';
import {
  buildAbandonmentComment,
  buildFixAttemptComment,
  buildFixCompleteComment,
  buildNoOpComment,
  buildStuckEscalationComment,
  buildTimeoutComment,
  postEventComment,
} from './comments.ts';
import {
  appendJsonl,
  cl,
  getFailCount,
  INSTANT_FAILURE_THRESHOLD_SECONDS,
  isMainBranchAbandoned,
  isRecentlyProcessed,
  JSONL_FILE,
  log,
  MAIN_BRANCH_ABANDON_THRESHOLD,
  MAIN_BRANCH_COOLDOWN_SECONDS,
  markAbandoned,
  markPendingCICheck,
  markProcessed,
  recordFailure,
  recordFixAttempt,
  hasExceededMaxAttempts,
  recordInstantFailure,
  resetCircuit,
  resetFailCount,
  trackMainFixPr,
  getMainRedSince,
  setMainRedSince,
  clearMainRedSince,
  getMainFixAttempts,
  incrementMainFixAttempts,
  resetMainFixAttempts,
  setPersistedClaimedPr,
} from './state.ts';
import { buildMainBranchPrompt, buildPrompt } from './prompts.ts';
import { computeEffectiveBudget } from './scoring.ts';
import {
  buildOutput,
  newStreamJsonState,
  processStreamJsonLine,
} from './stream-json.ts';

/**
 * Default inline input-token cap for spawnClaude when PatrolConfig doesn't
 * supply one explicitly. Set to QUA-1071 AC#5's 50k threshold.
 */
export const DEFAULT_INPUT_TOKEN_CAP = 50_000;

// ── No-op detection ─────────────────────────────────────────────────────────

/**
 * Detect when Claude exited cleanly but didn't actually fix anything
 * (e.g., followed "stop early" guidance for human-required issues).
 */
const NO_OP_PATTERNS = [
  /no action needed/i,
  /no code changes? needed/i,
  /requires? human intervention/i,
  /needs? human/i,
  /cannot be fixed automatically/i,
  /pre-existing.*(failure|issue|problem)/i,
  /also failing on main/i,
  /stopping early/i,
  /nothing to fix/i,
];

export function looksLikeNoOp(output: string): boolean {
  // Only check the last portion of output (where the conclusion lives)
  const tail = output.slice(-1000);
  return NO_OP_PATTERNS.some((p) => p.test(tail));
}

// ── Main root cause detection ───────────────────────────────────────────────

/**
 * Detect when a PR fix no-op is because the root cause is on main branch.
 * This is a subset of no-op patterns — specifically indicates main is broken
 * and this PR's CI failure isn't its own fault.
 */
const MAIN_ROOT_CAUSE_PATTERNS = [
  /pre-existing.*(failure|issue|problem)/i,
  /also failing on main/i,
  /not (introduced|caused) by this PR/i,
  /main branch.*(is|also).*(failing|broken|red)/i,
  /failure.*(originat|com).*(from|on) main/i,
  /same (failure|error|issue) on main/i,
];

export function looksLikeMainRootCause(output: string): boolean {
  const tail = output.slice(-2000);
  return MAIN_ROOT_CAUSE_PATTERNS.some((p) => p.test(tail));
}

/**
 * Extract a fix PR number from Claude's output.
 * Looks for patterns like github.com/.../pull/1234 or "PR #1234".
 */
function extractFixPrNumber(output: string): number | null {
  const tail = output.slice(-3000);
  const urlMatch = tail.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/);
  if (urlMatch) return parseInt(urlMatch[1], 10);
  const prMatch = tail.match(/(?:PR|pull request)\s*#(\d+)/i);
  if (prMatch) return parseInt(prMatch[1], 10);
  return null;
}

// ── Concurrency pre-flight checks ───────────────────────────────────────────

/**
 * Check if there's already an open PR from a `claude/fix-*` branch targeting main.
 * Prevents multiple agents from racing to fix the same CI failure by detecting
 * existing fix attempts before creating a new branch.
 *
 * Returns the PR number if a competing fix is found, null otherwise.
 */
export async function findExistingMainFixPr(repo: string): Promise<{ number: number; branch: string } | null> {
  try {
    const result = await githubApi<{ items: Array<{ number: number; head: { ref: string } }> }>(
      `/search/issues?q=repo:${repo}+is:pr+is:open+head:claude/fix-&per_page=5`,
    );
    if (result.items && result.items.length > 0) {
      return { number: result.items[0].number, branch: result.items[0].head.ref };
    }
  } catch (e) {
    // Non-fatal — fall through to allow the fix attempt
    log(`  ${cl.yellow}Warning: pre-flight check for existing fix PRs failed: ${e instanceof Error ? e.message : String(e)}${cl.reset}`);
  }
  return null;
}

/**
 * Re-check a PR's labels immediately before claiming it.
 * Prevents race conditions where another patrol instance claimed the PR
 * between our initial scan and dispatch.
 *
 * Returns true if the PR is still available (no working labels).
 */
async function isPrStillAvailable(prNumber: number, repo: string): Promise<boolean> {
  try {
    const pr = await githubApi<{ labels: Array<{ name: string }> }>(
      `/repos/${repo}/issues/${prNumber}`,
    );
    const labels = pr.labels.map((l) => l.name);
    if (ANY_WORKING_LABELS.some((wl) => labels.includes(wl))) {
      log(`  ${cl.yellow}PR #${prNumber} already claimed by another agent — skipping${cl.reset}`);
      return false;
    }
    return true;
  } catch (e) {
    // If we can't check, proceed cautiously — the claim will succeed or fail
    log(`  ${cl.yellow}Warning: could not re-check PR #${prNumber} labels: ${e instanceof Error ? e.message : String(e)}${cl.reset}`);
    return true;
  }
}

// ── Main Branch CI Check (daemon wrapper) ────────────────────────────────────

export { type MainBranchStatus };

const MAIN_BRANCH_KEY = 'main-branch';

/**
 * Check main branch CI with daemon-specific cooldown and abandoned tracking.
 * Delegates to the pure lib function for the actual API call.
 */
export async function checkMainBranch(config: PatrolConfig): Promise<MainBranchStatus> {
  const notRed: MainBranchStatus = { isRed: false, runId: null, sha: '', htmlUrl: '' };

  // Check cooldown and abandoned status first
  if (isMainBranchAbandoned(MAIN_BRANCH_KEY)) {
    log(`  ${cl.yellow}Main branch fix abandoned (${MAIN_BRANCH_ABANDON_THRESHOLD} attempts) — escalating to coordinator (Opus)${cl.reset}`);
    return notRed;
  }
  if (isRecentlyProcessed(MAIN_BRANCH_KEY, MAIN_BRANCH_COOLDOWN_SECONDS)) {
    log(`  ${cl.dim}Main branch recently processed — skipping (${MAIN_BRANCH_COOLDOWN_SECONDS}s cooldown)${cl.reset}`);
    return notRed;
  }

  try {
    const status = await libCheckMainBranch(config.repo);

    if (status.isRed) {
      log(`  ${cl.red}🔴 Main branch CI is RED${cl.reset} (run #${status.runId}, sha ${status.sha.slice(0, 8)})`);

      // Track red-since state
      if (!getMainRedSince()) {
        setMainRedSince(new Date().toISOString());
      }

      // Identify likely culprits (PRs merged since last green)
      const culprits = await libFindRecentMerges(config.repo, status.lastGreenAt).catch(() => [] as RecentMerge[]);
      if (culprits.length > 0) {
        log(`  Likely culprits: ${culprits.map((c) => `#${c.prNumber} (${c.title.slice(0, 40)})`).join(', ')}`);
      }
    } else {
      // Main is green — reset tracking if it was red before
      if (getMainRedSince()) {
        log(`  Main branch recovered (was red since ${getMainRedSince()})`);
        clearMainRedSince();
        resetMainFixAttempts();
        resetFailCount(MAIN_BRANCH_KEY);
      }
      log(`  ${cl.green}Main branch CI is green${cl.reset}`);
    }

    return status;
  } catch (e) {
    log(`  ${cl.yellow}Warning: could not check main branch CI: ${e instanceof Error ? e.message : String(e)}${cl.reset}`);
    return notRed;
  }
}

export async function fixMainBranch(status: MainBranchStatus, config: PatrolConfig): Promise<void> {
  log(`${cl.bold}→${cl.reset} Fixing main branch CI (run #${status.runId})`);

  if (config.dryRun) {
    log(`  ${cl.dim}[DRY RUN] Would invoke Claude to fix main branch CI${cl.reset}`);
    appendJsonl(JSONL_FILE, {
      type: 'main_branch_result',
      run_id: status.runId,
      sha: status.sha,
      outcome: 'dry-run' as FixOutcome,
      elapsed_s: 0,
    });
    markProcessed(MAIN_BRANCH_KEY);
    return;
  }

  // ── Pre-flight: check for existing fix PRs ───────────────────────
  // Prevents the 7-agent race condition (#3814) where multiple patrol
  // instances independently create fix branches for the same CI failure.
  const existingFix = await findExistingMainFixPr(config.repo);
  if (existingFix) {
    log(`  ${cl.yellow}⚠ Existing fix PR #${existingFix.number} already open (${existingFix.branch}) — skipping duplicate fix${cl.reset}`);
    trackMainFixPr(existingFix.number);
    markProcessed(MAIN_BRANCH_KEY);
    appendJsonl(JSONL_FILE, {
      type: 'main_branch_result',
      run_id: status.runId,
      sha: status.sha,
      outcome: 'no-op' as FixOutcome,
      elapsed_s: 0,
      reason: `Existing fix PR #${existingFix.number} already open`,
    });
    return;
  }

  const attemptNum = incrementMainFixAttempts();
  log(`  Fix attempt #${attemptNum}`);

  // Create an isolated worktree for the fix (detached HEAD at origin/main).
  // Claude will create its own fix branch from there.
  const projectRoot = git('rev-parse', '--show-toplevel');
  const wtName = `patrol-main-${Date.now()}`;
  let worktreePath: string;
  try {
    worktreePath = createWorktree(projectRoot, wtName, 'origin/main', { detach: true });
    log(`  Worktree: ${cl.dim}${worktreePath}${cl.reset}`);
  } catch (e) {
    log(`${cl.red}✗ Failed to create worktree for main branch fix: ${e instanceof Error ? e.message : String(e)}${cl.reset}`);
    markProcessed(MAIN_BRANCH_KEY);
    return;
  }

  const prompt = buildMainBranchPrompt(status.runId!, config.repo);
  const startTime = Date.now();

  let outcome: FixOutcome = 'fixed';
  let reason = '';

  try {
    const result = await spawnClaude(prompt, config, {
      cwd: worktreePath,
      context: { label: `main-branch:${status.runId ?? '?'}` },
    });
    const elapsedS = Math.floor((Date.now() - startTime) / 1000);

    if (result.timedOut || result.budgetExceeded) {
      const failCount = recordFailure(MAIN_BRANCH_KEY);
      outcome = 'timeout';
      // QUA-1078: a budget kill is shaped like a timeout (daemon-initiated
      // SIGTERM, partial work) — fold into the same branch but emit a clearer
      // reason so operators don't see a meaningless "Exit code: null".
      reason = result.budgetExceeded
        ? `Killed after exceeding ${config.inputTokenCap ?? 0} cumulative input_tokens (observed ${result.inputTokens}) — attempt ${failCount}`
        : `Killed after ${config.timeoutMinutes}m timeout — attempt ${failCount}`;
      log(
        result.budgetExceeded
          ? `${cl.red}✗ Main branch fix killed for input-token budget (${result.inputTokens})${cl.reset} (attempt ${failCount})`
          : `${cl.red}✗ Main branch fix timed out after ${config.timeoutMinutes}m${cl.reset} (attempt ${failCount})`,
      );

      if (failCount >= MAIN_BRANCH_ABANDON_THRESHOLD) {
        reason = `Abandoned after ${failCount} failures (${result.budgetExceeded ? 'budget' : 'timeout'})`;
        log(`${cl.red}✗ Main branch fix abandoned after ${failCount} failures${cl.reset}`);
      }
    } else if (result.exitCode === 0 && !result.hitMaxTurns) {
      const isNoOp = looksLikeNoOp(result.output);
      outcome = isNoOp ? 'no-op' : 'fixed';
      if (isNoOp) {
        recordFailure(MAIN_BRANCH_KEY);
        reason = 'No-op: agent determined issue needs escalation to coordinator';
        log(`${cl.yellow}⚠ Main branch fix no-op — agent stopped early${cl.reset} (${elapsedS}s)`);
      } else {
        resetFailCount(MAIN_BRANCH_KEY);
        log(`${cl.green}✓ Main branch CI fix processed${cl.reset} (${elapsedS}s)`);
        // Track the fix PR so we can poll for merge and verify main is green
        const fixPrNum = extractFixPrNumber(result.output);
        if (fixPrNum) {
          trackMainFixPr(fixPrNum);
          log(`  ${cl.cyan}Tracking fix PR #${fixPrNum} for merge check${cl.reset}`);
        }
      }
    } else if (result.hitMaxTurns) {
      const failCount = recordFailure(MAIN_BRANCH_KEY);
      outcome = 'max-turns';
      reason = `Hit max turns (${config.maxTurns}) — attempt ${failCount}`;
      log(`${cl.yellow}⚠ Main branch fix hit max turns after ${elapsedS}s${cl.reset}`);

      if (failCount >= MAIN_BRANCH_ABANDON_THRESHOLD) {
        reason = `Abandoned after ${failCount} failures`;
        log(`${cl.red}✗ Main branch fix abandoned after ${failCount} failures${cl.reset}`);
      }
    } else {
      outcome = 'error';
      reason = `Exit code: ${result.exitCode}`;
      log(`${cl.red}✗ Main branch fix failed${cl.reset} (exit: ${result.exitCode}, ${elapsedS}s)`);
    }

    appendJsonl(JSONL_FILE, {
      type: 'main_branch_result',
      run_id: status.runId,
      sha: status.sha,
      outcome,
      elapsed_s: elapsedS,
      reason: reason || undefined,
    });
  } finally {
    removeWorktree(worktreePath);
    markProcessed(MAIN_BRANCH_KEY);
  }
}

// ── Claude spawning ─────────────────────────────────────────────────────────

export interface SpawnClaudeResult {
  exitCode: number;
  /**
   * Reconstructed agent output. Built from joined `assistant` text content +
   * `result.result` text + `tool_result` content (and any unparseable
   * passthrough lines), so the existing regex-based callers
   * (`looksLikeNoOp`, `looksLikeMainRootCause`, `extractFixPrNumber`,
   * fix-complete tail comments) keep matching without changes.
   */
  output: string;
  hitMaxTurns: boolean;
  timedOut: boolean;
  /** True if the subprocess was SIGTERM'd because cumulative input_tokens hit the cap. */
  budgetExceeded: boolean;
  /** Cumulative `input_tokens` summed across stream-json `assistant` events. */
  inputTokens: number;
}

export interface SpawnClaudeOpts {
  cwd?: string;
  extraEnv?: Record<string, string>;
  /**
   * Optional context attached to the `cycle_budget_exceeded` JSONL event
   * when the input-token cap fires. Lets fixPr / fixMainBranch / branch-agent
   * tag the entry without each caller having to log separately.
   */
  context?: { prNumber?: number | null; label?: string };
}

export function spawnClaude(
  prompt: string,
  config: PatrolConfig,
  opts?: SpawnClaudeOpts,
): Promise<SpawnClaudeResult> {
  return new Promise((resolve, reject) => {
    const args = [
      '--print',
      '--model',
      config.model,
      '--max-turns',
      String(config.maxTurns),
      '--output-format',
      'stream-json',
      '--verbose',
    ];
    if (config.skipPerms) args.push('--dangerously-skip-permissions');

    // Unset CLAUDECODE to prevent subprocess hang inside Claude Code sessions,
    // unless the caller explicitly passes it in extraEnv (parallel patrol needs it for auth).
    //
    // Strip ANTHROPIC_API_KEY so the spawned `claude` CLI uses our OAuth Claude
    // Code subscription, not API-direct billing. `.env.base` carries the key
    // for legitimate API-direct callers (crux internal LLM calls), but patrol
    // must not pass it through to claude — see QUA-1010 / QUA-612. Without
    // this strip, every patrol fix attempt silently bills the API.
    //
    // Fail loud, not silent: if the key was present, log a prominent warning
    // so an unattended overnight patrol run still leaves a trail for the
    // operator to see. The delete itself is the safety net; the warning is
    // the alarm bell.
    const env = { ...process.env };
    delete env.CLAUDECODE;
    const apiKeyEnvName = 'ANTHROPIC_API_KEY'; // anthropic-billing-key-remap-ok
    if (env[apiKeyEnvName]) {
      log(
        `  ${cl.yellow}⚠ ${apiKeyEnvName} was set in patrol env — stripping it before spawning claude so the OAuth subscription is used (see QUA-1010). Unset the key in your shell/.env to silence this warning.${cl.reset}`,
      );
      delete env[apiKeyEnvName];
    }
    if (opts?.extraEnv) Object.assign(env, opts.extraEnv);

    const child = spawn('claude', args, {
      cwd: opts?.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const state = newStreamJsonState();
    const cap = config.inputTokenCap ?? DEFAULT_INPUT_TOKEN_CAP;
    let timedOut = false;
    let budgetExceeded = false;
    let killedReason: 'timeout' | 'budget' | null = null;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    let stdoutBuffer = '';

    const clearTimers = () => {
      clearTimeout(timer);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
        forceKillTimer = null;
      }
    };

    // Single kill path — used by both timeout and budget. Idempotent so a
    // concurrent budget-cross + timeout doesn't double-fire SIGTERM.
    const triggerKill = (reason: 'timeout' | 'budget') => {
      if (killedReason) return;
      killedReason = reason;
      // If we got here from a close-handler drain (the partial-line buffer
      // crossing the cap *after* the child has already exited), the child
      // is gone — calling kill() is harmless but the SIGKILL fallback timer
      // would leak for 10s and delay clean shutdown. Skip it.
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }, 10_000);
    };

    // Hard timeout — kill subprocess if it runs too long
    const timeoutMs = config.timeoutMinutes * 60 * 1000;
    const timer = setTimeout(() => {
      timedOut = true;
      log(
        `  ${cl.yellow}⚠ Claude subprocess timed out after ${config.timeoutMinutes}m — killing${cl.reset}`,
      );
      triggerKill('timeout');
    }, timeoutMs);

    const handleLine = (line: string) => {
      const effect = processStreamJsonLine(line, state, cap);
      if (effect.stderrText) process.stderr.write(effect.stderrText + '\n');
      if (effect.budgetCrossedNow && !budgetExceeded) {
        budgetExceeded = true;
        log(
          `  ${cl.red}⚠ Input-token budget exceeded (observed ${state.cumulativeInputTokens} ≥ cap ${cap}) — killing claude subprocess${cl.reset}`,
        );
        triggerKill('budget');
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      let nlIdx;
      while ((nlIdx = stdoutBuffer.indexOf('\n')) !== -1) {
        const line = stdoutBuffer.slice(0, nlIdx);
        stdoutBuffer = stdoutBuffer.slice(nlIdx + 1);
        handleLine(line);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      // Surface stderr to the operator (claude warnings live here) but DO
      // NOT append to output: stderr can include partial credentials on auth
      // failure (e.g. truncated `sk-ant-...` echoes), and `output.slice(-500)`
      // is posted as a public PR comment via buildFixCompleteComment. The
      // pre-stream-json text mode concatenated stderr too — that was a
      // pre-existing leak risk we're tightening up here.
      process.stderr.write(chunk);
    });

    child.stdin.write(prompt);
    child.stdin.end();

    child.on('close', (code) => {
      clearTimers();
      // Drain any final partial line so we don't lose the result event.
      if (stdoutBuffer.trim()) handleLine(stdoutBuffer);
      stdoutBuffer = '';

      const output = buildOutput(state);
      // hitMaxTurns is already OR'd from three signals in `handleResult`
      // (subtype, stop_reason, regex against resultText). No need for a
      // redundant outer substring check — if the result event carried the
      // phrase, handleResult set the flag.
      const hitMaxTurns = state.hitMaxTurns;

      if (budgetExceeded) {
        // The kill-signal landed; verify whether the process actually exited
        // versus still hanging at SIGKILL deadline (close is firing now, so
        // it did exit — but record the signal source for forensics).
        const killSucceeded = child.exitCode !== null || child.signalCode !== null;
        try {
          appendJsonl(JSONL_FILE, {
            type: 'cycle_budget_exceeded',
            pr_num: opts?.context?.prNumber ?? null,
            label: opts?.context?.label ?? null,
            threshold: cap,
            observed_input_tokens: state.cumulativeInputTokens,
            kill_succeeded: killSucceeded,
            exit_code: code,
            signal: child.signalCode,
          });
        } catch (e) {
          // Don't let a disk-full error stall the promise; the kill itself
          // succeeded and the operator already has the live stderr warning.
          log(
            `  ${cl.yellow}Warning: could not append cycle_budget_exceeded JSONL: ${
              e instanceof Error ? e.message : String(e)
            }${cl.reset}`,
          );
        }
      }

      resolve({
        exitCode: code ?? 1,
        output,
        hitMaxTurns,
        timedOut,
        budgetExceeded,
        inputTokens: state.cumulativeInputTokens,
      });
    });
    child.on('error', (err) => {
      clearTimers();
      reject(err);
    });
  });
}

// ── PR claim management ─────────────────────────────────────────────────────
//
// Historically this file owned its own `claimPr`/`releasePr` pair. They now
// delegate to the shared helpers in `./claim.ts` so both the serial
// (execution.ts) and parallel (parallel.ts) dispatch paths use the same
// ownership-tracked claim/release flow. See claim.ts for the QUA-400 race
// fix context.

let claimedPr: number | null = null;

export function getClaimedPr(): number | null {
  return claimedPr;
}

/** ClaimDeps bound to this module's logger and claimedPr tracker. */
const serialClaimDeps: ClaimDeps = defaultClaimDeps((prNum, reason) => {
  log(`  ${cl.yellow}PR #${prNum} claim skipped: ${reason}${cl.reset}`);
});

/**
 * Attempt to claim a PR. Returns `true` if the claim was acquired.
 * On success, updates `claimedPr` and persisted state so a SIGINT/SIGTERM
 * can release the label on shutdown via `releaseCurrentClaim`.
 */
async function claimPr(prNum: number, repo: string): Promise<boolean> {
  const didClaim = await tryClaimPr(prNum, repo, serialClaimDeps);
  if (didClaim) {
    claimedPr = prNum;
    setPersistedClaimedPr(prNum);
  }
  return didClaim;
}

/**
 * Release the working label for a PR — but ONLY if this worker actually
 * claimed it (`didClaim === true`). When `didClaim === false`, this is a
 * no-op: another worker holds the label and we must not delete it.
 */
async function releasePr(
  didClaim: boolean,
  prNum: number,
  repo: string,
): Promise<void> {
  if (!didClaim) return;
  try {
    await releasePrIfClaimed(didClaim, prNum, repo, serialClaimDeps);
  } catch (e) {
    // defaultRemoveWorkingLabel already swallows 404. Anything that bubbles
    // up here is a real error — surface it so a stale pr-patrol:working
    // label can't silently block future scans of this PR.
    log(
      `  Warning: could not remove pr-patrol:working label from PR #${prNum}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (claimedPr === prNum) {
    claimedPr = null;
    setPersistedClaimedPr(null);
  }
}

export async function releaseCurrentClaim(repo: string): Promise<void> {
  if (claimedPr !== null) {
    // Shutdown path: we know we own the claim, so didClaim = true.
    await releasePr(true, claimedPr, repo).catch((e) => {
      // Best-effort cleanup during shutdown — label will be stale but not harmful
      log(`  Warning: could not release claim on PR #${claimedPr}: ${e instanceof Error ? e.message : String(e)}`);
    });
  }
}

// ── PR fix execution ────────────────────────────────────────────────────────

export interface FixPrResult {
  /** True when the PR's CI failure is caused by main branch being broken, not the PR itself. */
  mainIsRootCause: boolean;
}

export async function fixPr(pr: ScoredPr, config: PatrolConfig): Promise<FixPrResult> {
  log(`${cl.bold}→${cl.reset} Fixing PR ${cl.cyan}#${pr.number}${cl.reset} (${pr.title})`);
  log(`  Issues: ${cl.yellow}${pr.issues.join(', ')}${cl.reset}`);
  log(`  Branch: ${cl.dim}${pr.branch}${cl.reset}`);

  // ── Stuck-cycle escalation (QUA-286) ────────────────────────────────
  // Route through the EXISTING abandonment/coordinator escalation path
  // (see bf77960b6). No Claude dispatch — the coordinator (Opus) will
  // review and decide how to unstick the PR. A new push resets the
  // fingerprint via detectAllPrIssuesFromNodes() and clears abandonment.
  if (pr.issues.includes('stuck') && (pr.stuckCycles ?? 0) >= 3) {
    log(`  ${cl.red}✗ PR #${pr.number} stuck for ${pr.stuckCycles} cycles — escalating to coordinator (no Claude dispatch)${cl.reset}`);
    const headSha = git('ls-remote', 'origin', pr.branch).split(/\s/)[0] || undefined;
    markAbandoned(pr.number, headSha);
    markProcessed(pr.number);

    if (!config.dryRun) {
      await postEventComment(
        pr.number,
        config.repo,
        buildStuckEscalationComment(pr.stuckCycles ?? 0, pr.stuckReason ?? 'unknown', pr.issues),
      ).catch((e: unknown) =>
        log(`  ${cl.yellow}Warning: could not post stuck-escalation comment: ${e instanceof Error ? e.message : String(e)}${cl.reset}`),
      );
    }

    appendJsonl(JSONL_FILE, {
      type: 'pr_result',
      pr_num: pr.number,
      issues: pr.issues,
      outcome: 'no-op' as FixOutcome,
      elapsed_s: 0,
      reason: `Stuck-cycle escalation — ${pr.stuckCycles} cycles at fingerprint "${pr.stuckReason}"`,
      stuck_cycles: pr.stuckCycles,
      stuck_reason: pr.stuckReason,
    });
    return { mainIsRootCause: false };
  }

  // ── Anti-oscillation: check total fix attempts (#3755, #3757, #3826) ──
  if (hasExceededMaxAttempts(pr.number)) {
    log(`  ${cl.red}✗ PR #${pr.number} exceeded max total fix attempts — abandoning${cl.reset}`);
    // Persist current HEAD SHA so future detection can clear abandonment on new push
    const headSha = git('ls-remote', 'origin', pr.branch).split(/\s/)[0] || undefined;
    markAbandoned(pr.number, headSha);
    markProcessed(pr.number);
    appendJsonl(JSONL_FILE, {
      type: 'pr_result',
      pr_num: pr.number,
      issues: pr.issues,
      outcome: 'no-op' as FixOutcome,
      elapsed_s: 0,
      reason: `Exceeded max total fix attempts (oscillation prevention)`,
    });
    return { mainIsRootCause: false };
  }

  if (config.dryRun) {
    log(`  ${cl.dim}[DRY RUN] Would invoke Claude to fix${cl.reset}`);
    appendJsonl(JSONL_FILE, {
      type: 'pr_result',
      pr_num: pr.number,
      issues: pr.issues,
      outcome: 'dry-run' as FixOutcome,
      elapsed_s: 0,
    });
    markProcessed(pr.number);
    return { mainIsRootCause: false };
  }

  // ── Pre-claim re-check: verify PR is still unclaimed ─────────────
  // Prevents race conditions (#3814) where another patrol instance
  // claimed the PR between our initial scan and this dispatch.
  const available = await isPrStillAvailable(pr.number, config.repo);
  if (!available) {
    markProcessed(pr.number);
    appendJsonl(JSONL_FILE, {
      type: 'pr_result',
      pr_num: pr.number,
      issues: pr.issues,
      outcome: 'no-op' as FixOutcome,
      elapsed_s: 0,
      reason: 'Already claimed by another agent',
    });
    return { mainIsRootCause: false };
  }

  // ── Create worktree ──────────────────────────────────────────────
  const projectRoot = git('rev-parse', '--show-toplevel');
  const wtName = `patrol-pr-${pr.number}`;
  let worktreePath: string;
  try {
    worktreePath = createWorktree(projectRoot, wtName, pr.branch);
    log(`  Worktree: ${cl.dim}${worktreePath}${cl.reset}`);
  } catch (e) {
    log(`${cl.red}✗ Failed to create worktree for PR #${pr.number}: ${e instanceof Error ? e.message : String(e)}${cl.reset}`);
    return { mainIsRootCause: false };
  }

  // ── Claim the PR BEFORE the rebase/verify round-trip ─────────────
  // QUA-400 (CodeRabbit critical): `tryRebaseAndVerify` polls GitHub's
  // mergeable state for ~12s. If we ran it before claiming, another patrol
  // worker could grab the label during that window, and the unconditional
  // release in our `finally` below would delete the other worker's claim.
  //
  // Fix: claim first, track `didClaim` locally, only release on success.
  // If another worker beat us to the claim, bail out cleanly.
  const didClaim = await claimPr(pr.number, config.repo);
  if (!didClaim) {
    markProcessed(pr.number);
    appendJsonl(JSONL_FILE, {
      type: 'pr_result',
      pr_num: pr.number,
      issues: pr.issues,
      outcome: 'no-op' as FixOutcome,
      elapsed_s: 0,
      reason: 'Claim lost to concurrent worker',
    });
    removeWorktree(worktreePath);
    return { mainIsRootCause: false };
  }

  // Everything below this point runs while we hold the claim. The
  // outer try/finally at the end of this function guarantees we release
  // the label via `releasePr(didClaim, ...)` — which is a no-op if
  // `didClaim === false` (belt-and-suspenders; we already early-returned).
  let outcome: FixOutcome = 'fixed';
  let reason = '';
  let mainIsRootCause = false;

  try {
    // ── Automated rebase pre-step (runs in worktree) ──────────────────
    // For stale or conflicting PRs, try a plain git rebase first. Saves the
    // full Claude spawn (~5 turns, ~3-10 min) when rebase resolves cleanly.
    // `tryRebaseAndVerify` also polls GitHub's mergeable state to catch the
    // case where rebase pushed but GitHub still reports CONFLICTING due to
    // async recomputation or a concurrent commit (QUA-400, PR #4287).
    if (pr.issues.includes('stale') || pr.issues.includes('conflict')) {
      log('  Attempting automated rebase (no Claude needed)...');
      const rebaseOutcome = await tryRebaseAndVerify(
        pr.branch,
        pr.number,
        pr.issues,
        worktreePath,
        config.repo,
      );

      switch (rebaseOutcome.kind) {
        case 'rebase-failed':
          log(`  Automated rebase failed (${rebaseOutcome.status}) — falling through to Claude`);
          break;

        case 'verify-failed':
          log(
            `  ${cl.yellow}⚠ Automated rebase reported ${rebaseOutcome.rebaseStatus} but GitHub still shows conflict: ${rebaseOutcome.verify.reason}${cl.reset} — falling through to Claude`,
          );
          appendJsonl(JSONL_FILE, {
            type: 'rebase_verify_failed',
            pr_num: pr.number,
            rebase_status: rebaseOutcome.rebaseStatus,
            reason: rebaseOutcome.verify.reason,
            mergeable: rebaseOutcome.verify.mergeable,
            merge_state_status: rebaseOutcome.verify.mergeStateStatus,
            attempts: rebaseOutcome.verify.attempts,
          });
          break;

        case 'fully-resolved':
          log(`  ✓ Automated rebase ${rebaseOutcome.rebaseStatus} — no Claude needed`);
          appendJsonl(JSONL_FILE, {
            type: 'pr_result',
            pr_num: pr.number,
            issues: pr.issues,
            outcome: 'fixed' as FixOutcome,
            elapsed_s: 0,
            reason: `automated-rebase: ${rebaseOutcome.rebaseStatus} (verified)`,
          });
          // Claim-guarded early return: the outer finally below will
          // release the label and clean up the worktree.
          return { mainIsRootCause: false };

        case 'partially-resolved':
          log(`  ✓ Automated rebase ${rebaseOutcome.rebaseStatus} — no Claude needed`);
          pr.issues = rebaseOutcome.remainingIssues;
          log(`  Remaining issues after rebase: ${rebaseOutcome.remainingIssues.join(', ')} — falling through to Claude`);
          break;
      }
    }

    // Compute issue-specific budget (capped by global config)
    // Reduce budget on retry — the full budget already failed once, so give less on subsequent attempts
    const failCount = getFailCount(pr.number);
    const { maxTurns: effectiveMaxTurns, timeoutMinutes: effectiveTimeout } =
      computeEffectiveBudget(pr.issues, config.maxTurns, config.timeoutMinutes, failCount);

    if (failCount > 0) {
      log(`  ${cl.dim}Retry #${failCount + 1} — budget reduced to ${effectiveMaxTurns} turns / ${effectiveTimeout}m${cl.reset}`);
    }
    log(`  Budget: ${effectiveMaxTurns} max-turns, ${effectiveTimeout}m timeout (based on: ${pr.issues.join(', ')})`);

    // Record fix attempt after worktree creation (not before dry-run/early-return paths)
    recordFixAttempt(pr.number);

    // Post "attempting fix" event comment before spawning Claude
    await postEventComment(pr.number, config.repo, buildFixAttemptComment(pr.issues))
      .catch((e: unknown) => log(`  Warning: could not post fix attempt comment: ${e instanceof Error ? e.message : String(e)}`));

    const prompt = buildPrompt(pr, config.repo);
    const startTime = Date.now();

    const result = await spawnClaude(prompt, {
      ...config,
      maxTurns: effectiveMaxTurns,
      timeoutMinutes: effectiveTimeout,
    }, { cwd: worktreePath, context: { prNumber: pr.number } });
    const elapsedS = Math.floor((Date.now() - startTime) / 1000);

    if (result.timedOut || result.budgetExceeded) {
      // Timeouts AND budget kills count toward abandonment — a PR that
      // repeatedly times out or repeatedly blows the input-token cap is
      // likely unfixable and shouldn't keep burning compute. QUA-1078: fold
      // budget kills into this branch so the reason string doesn't read
      // "Exit code: null" — operators need to see what actually happened.
      const failCount = recordFailure(pr.number);
      outcome = 'timeout';
      reason = result.budgetExceeded
        ? `Killed after exceeding ${config.inputTokenCap ?? 0} cumulative input_tokens (observed ${result.inputTokens}) — attempt ${failCount}`
        : `Killed after ${effectiveTimeout}m timeout — attempt ${failCount}`;
      log(
        result.budgetExceeded
          ? `${cl.red}✗ PR #${pr.number} killed for input-token budget (${result.inputTokens})${cl.reset} (attempt ${failCount})`
          : `${cl.red}✗ PR #${pr.number} timed out after ${effectiveTimeout}m${cl.reset} (attempt ${failCount})`,
      );

      if (failCount >= 2) {
        markAbandoned(pr.number);
        reason = `Abandoned after ${failCount} failures (${result.budgetExceeded ? 'budget' : 'timeout'})`;
        log(`${cl.red}✗ PR #${pr.number} abandoned after ${failCount} consecutive failures${cl.reset}`);
        await postEventComment(pr.number, config.repo, buildAbandonmentComment(failCount, pr.issues))
          .catch((e: unknown) => log(`  Warning: could not post abandonment comment: ${e instanceof Error ? e.message : String(e)}`));
      } else {
        await postEventComment(pr.number, config.repo, buildTimeoutComment(failCount, effectiveTimeout, pr.issues))
          .catch((e: unknown) => log(`  Warning: could not post timeout comment: ${e instanceof Error ? e.message : String(e)}`));
      }
    } else if (result.exitCode === 0 && !result.hitMaxTurns) {
      const isNoOp = looksLikeNoOp(result.output);
      outcome = isNoOp ? 'no-op' : 'fixed';

      if (isNoOp) {
        if (looksLikeMainRootCause(result.output)) {
          // PR's CI failure is caused by main being broken — don't penalize this PR.
          // No recordFailure() here: main-root-cause no-ops shouldn't count against
          // the PR's failure counter. The cooldown from markProcessed() prevents
          // infinite retries, and the counter resets when main goes green.
          mainIsRootCause = true;
          reason = `No-op: CI failure is pre-existing on main branch`;
          log(`${cl.yellow}⚠ PR #${pr.number} no-op — root cause is on main branch${cl.reset} (${elapsedS}s)`);
        } else {
          // No-op: Claude determined the issue can't be fixed automatically.
          // Don't reset fail count — treat like a soft failure so the PR
          // gets skipped on future cycles instead of being retried forever.
          const failCount = recordFailure(pr.number);
          reason = `No-op: agent determined issue needs escalation to coordinator (attempt ${failCount})`;
          log(`${cl.yellow}⚠ PR #${pr.number} no-op — agent stopped early${cl.reset} (${elapsedS}s)`);
        }

        await postEventComment(pr.number, config.repo, buildNoOpComment(pr.issues))
          .catch((e: unknown) => log(`  Warning: could not post no-op comment: ${e instanceof Error ? e.message : String(e)}`));
      } else {
        // Don't reset fail count immediately — mark as pending CI check.
        // The fail counter will be reset when CI passes on the next cycle.
        markPendingCICheck(pr.number);
        log(`${cl.green}✓ PR #${pr.number} processed successfully${cl.reset} (${elapsedS}s) — pending CI check`);

        // Post fix-complete summary comment
        const outputTail = result.output.slice(-500);
        await postEventComment(pr.number, config.repo, buildFixCompleteComment(elapsedS, effectiveMaxTurns, config.model, pr.issues, outputTail))
          .catch((e: unknown) => log(`  Warning: could not post fix-complete comment: ${e instanceof Error ? e.message : String(e)}`));
      }
    } else if (result.hitMaxTurns) {
      const failCount = recordFailure(pr.number);
      outcome = 'max-turns';
      reason = `Hit max turns (${effectiveMaxTurns}) — attempt ${failCount}`;
      log(`${cl.yellow}⚠ PR #${pr.number} hit max turns after ${elapsedS}s${cl.reset} (attempt ${failCount})`);

      if (failCount >= 2) {
        markAbandoned(pr.number);
        reason = `Abandoned after ${failCount} failures`;
        log(
          `${cl.red}✗ PR #${pr.number} abandoned after ${failCount} consecutive failures${cl.reset}`,
        );
        await postEventComment(pr.number, config.repo, buildAbandonmentComment(failCount, pr.issues))
          .catch((e: unknown) => log(`  Warning: could not post abandonment comment: ${e instanceof Error ? e.message : String(e)}`));
      }
    } else {
      outcome = 'error';
      reason = `Exit code: ${result.exitCode}`;
      log(
        `${cl.red}✗ PR #${pr.number} processing failed${cl.reset} (exit: ${result.exitCode}, ${elapsedS}s)`,
      );

      // Track errors as failures so the PR gets abandoned after repeated failures
      // (previously missing — errored PRs would retry forever after cooldown expired)
      const failCount = recordFailure(pr.number);
      if (failCount >= 2) {
        markAbandoned(pr.number);
        reason = `Abandoned after ${failCount} failures (last: exit code ${result.exitCode})`;
        log(
          `${cl.red}✗ PR #${pr.number} abandoned after ${failCount} consecutive failures${cl.reset}`,
        );
        await postEventComment(pr.number, config.repo, buildAbandonmentComment(failCount, pr.issues))
          .catch((e: unknown) => log(`  Warning: could not post abandonment comment: ${e instanceof Error ? e.message : String(e)}`));
      }
    }

    // Circuit breaker: track instant failures (error + <15s) vs non-instant outcomes
    if (outcome === 'error' && elapsedS < INSTANT_FAILURE_THRESHOLD_SECONDS) {
      const tripped = recordInstantFailure();
      if (tripped) {
        log(`${cl.red}Circuit breaker TRIPPED — 3+ consecutive instant failures. Pausing dispatch for 15 min.${cl.reset}`);
      }
    } else {
      resetCircuit();
    }

    appendJsonl(JSONL_FILE, {
      type: 'pr_result',
      pr_num: pr.number,
      issues: pr.issues,
      outcome,
      elapsed_s: elapsedS,
      reason: reason || undefined,
    });
  } finally {
    // Only release the working label if THIS worker actually claimed the
    // PR. When didClaim === false we bailed out early (above), but this
    // gate is belt-and-suspenders against future refactors.
    await releasePr(didClaim, pr.number, config.repo);

    // Clean up worktree (handles rebase/merge abort internally)
    removeWorktree(worktreePath);

    markProcessed(pr.number);
  }

  return { mainIsRootCause };
}
