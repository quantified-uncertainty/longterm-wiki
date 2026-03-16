/**
 * PR Patrol — Parallel dispatch engine
 *
 * Dispatches PR fixes to idle agent workspace slots (lw/a2–a15) in parallel,
 * using Promise.allSettled() across slots. Each fix runs in an isolated clone,
 * avoiding the git state pollution that worktrees cause.
 *
 * Designed to complement the existing serial daemon — shares cooldowns, failure
 * tracking, and claim labels. New subcommand: `crux pr-patrol parallel`.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { execSync } from 'child_process';
import { tryAutomatedRebase } from '../lib/pr-analysis/rebase.ts';
import { parseIntOpt } from '../lib/cli.ts';
import { REPO } from '../lib/github.ts';
import type { PatrolConfig, ScoredPr, FixOutcome } from './types.ts';
import {
  appendJsonl,
  cl,
  ensureDirs,
  getFailCount,
  isAbandoned,
  isRecentlyProcessed,
  JSONL_FILE,
  log,
  logHeader,
  markProcessed,
  recordFailure,
  resetFailCount,
  setParallelState,
} from './state.ts';
import {
  detectAllPrIssuesFromNodes,
  fetchOpenPrs,
} from './detection.ts';
import { rankPrs, computeEffectiveBudget } from './scoring.ts';
import { buildPrompt } from './prompts.ts';
import {
  looksLikeNoOp,
  looksLikeMainRootCause,
  spawnClaude,
} from './execution.ts';
import { githubApi } from '../lib/github.ts';
import { LABELS } from './types.ts';
import {
  buildAbandonmentComment,
  buildFixAttemptComment,
  buildFixCompleteComment,
  buildNoOpComment,
  buildTimeoutComment,
  buildStatusCommentBody,
  postEventComment,
  upsertStatusComment,
} from './comments.ts';
import {
  findMergeCandidates,
  enqueuePr,
  undraftPr,
  reconcileMergeQueueLabels,
} from './merge.ts';
import { checkDeployHealth as libCheckDeployHealth } from '../lib/pr-analysis/deploy-status.ts';
import type { DeployHealthStatus } from '../lib/pr-analysis/deploy-status.ts';

// ── Parallel config ──────────────────────────────────────────────────────────

export interface ParallelConfig extends PatrolConfig {
  maxSlots: number;
  slotRange: [number, number]; // inclusive [min, max]
  reserveSlots: number;
  abandonThreshold: number;
}

const LOCK_FILE_NAME = '.pr-patrol-lock';

/** Parse a .env file and return key-value pairs. */
function loadDotEnv(dir: string): Record<string, string> {
  const envFile = join(dir, '.env');
  if (!existsSync(envFile)) return {};
  const vars: Record<string, string> = {};
  for (const line of readFileSync(envFile, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    vars[key] = val;
  }
  return vars;
}

// ── Slot discovery ───────────────────────────────────────────────────────────

/** Resolve the `lw/` parent directory from PROJECT_ROOT. */
export function getLwDir(): string {
  const projectRoot = process.cwd();
  const parent = dirname(projectRoot);
  const dirName = projectRoot.split('/').pop() || '';

  if (/^(a\d+|main)$/.test(dirName) && parent.endsWith('/lw')) {
    return parent;
  }

  return join(parent, 'lw');
}

/** Run a git command in a directory and return trimmed output. */
function gitInDir(dir: string, ...args: string[]): string {
  try {
    return execSync(`git ${args.join(' ')}`, {
      cwd: dir,
      encoding: 'utf-8',
      timeout: 30000,
    }).trim();
  } catch {
    return '';
  }
}

interface SlotInfo {
  dir: string;
  slot: number;
}

/** Find all agent slot directories under lw/. */
function findSlotDirs(lwDir: string): SlotInfo[] {
  if (!existsSync(lwDir)) return [];

  try {
    const entries = execSync('ls', { cwd: lwDir, encoding: 'utf-8' })
      .trim()
      .split('\n')
      .filter((name) => /^a\d+$/.test(name));

    const results: SlotInfo[] = [];
    for (const name of entries) {
      const dir = join(lwDir, name);
      try {
        const slotFile = join(dir, '.agent-slot');
        if (!existsSync(slotFile)) continue;
        const raw = readFileSync(slotFile, 'utf-8').trim();
        const slot = parseInt(raw, 10);
        if (Number.isInteger(slot) && slot > 0) {
          results.push({ dir, slot });
        }
      } catch {
        // Skip directories without valid .agent-slot
      }
    }

    return results.sort((a, b) => a.slot - b.slot);
  } catch {
    return [];
  }
}

// ── Idle slot detection ──────────────────────────────────────────────────────

/**
 * Find idle slots: on main branch, clean working tree, no .agent-task,
 * no .pr-patrol-lock, within configured slot range.
 */
export function findIdleSlots(
  lwDir: string,
  slotRange: [number, number],
): SlotInfo[] {
  const allSlots = findSlotDirs(lwDir);
  const idle: SlotInfo[] = [];

  for (const s of allSlots) {
    if (s.slot < slotRange[0] || s.slot > slotRange[1]) continue;

    // Skip if manually claimed by an agent
    if (existsSync(join(s.dir, '.agent-task'))) {
      log(`  ${cl.dim}Slot a${s.slot}: has .agent-task — skipping${cl.reset}`);
      continue;
    }

    // Skip if already locked by parallel patrol
    if (existsSync(join(s.dir, LOCK_FILE_NAME))) {
      log(`  ${cl.dim}Slot a${s.slot}: locked by parallel patrol — skipping${cl.reset}`);
      continue;
    }

    const branch = gitInDir(s.dir, 'branch', '--show-current');
    if (branch !== 'main') {
      log(`  ${cl.dim}Slot a${s.slot}: on branch ${branch} — skipping${cl.reset}`);
      continue;
    }

    const porcelain = gitInDir(s.dir, 'status', '--porcelain');
    const significantChanges = porcelain
      ? porcelain.split('\n').filter((l) => l && !l.endsWith('.agent-slot') && !l.endsWith('.envrc'))
      : [];
    if (significantChanges.length > 0) {
      log(`  ${cl.dim}Slot a${s.slot}: dirty working tree — skipping${cl.reset}`);
      continue;
    }

    idle.push(s);
  }

  return idle;
}

// ── Slot preparation and reset ───────────────────────────────────────────────

/** Lock a slot with an advisory lock file. */
function lockSlot(slotDir: string, prNumber: number): void {
  writeFileSync(
    join(slotDir, LOCK_FILE_NAME),
    JSON.stringify({ prNumber, lockedAt: new Date().toISOString(), pid: process.pid }),
  );
}

/** Remove the advisory lock file. */
function unlockSlot(slotDir: string): void {
  try {
    const lockFile = join(slotDir, LOCK_FILE_NAME);
    if (existsSync(lockFile)) unlinkSync(lockFile);
  } catch {
    // Best-effort cleanup
  }
}

/** Check if a lock file is stale (process dead or lock too old). */
function isLockStale(slotDir: string): boolean {
  const lockFile = join(slotDir, LOCK_FILE_NAME);
  if (!existsSync(lockFile)) return false;
  try {
    const data = JSON.parse(readFileSync(lockFile, 'utf-8'));
    // Check if the locking process is still alive
    if (typeof data.pid === 'number') {
      try {
        process.kill(data.pid, 0); // signal 0 = check if alive
        // Process is alive — lock is not stale
      } catch {
        // Process is dead — lock is stale
        return true;
      }
    }
    // Check if lock is older than 2 hours (safety net)
    if (typeof data.lockedAt === 'string') {
      const age = Date.now() - new Date(data.lockedAt).getTime();
      if (age > 2 * 60 * 60 * 1000) return true;
    }
    return false;
  } catch {
    // Can't parse — treat as stale
    return true;
  }
}

/** Clean up stale lock files from crashed processes. */
function cleanStaleLocks(lwDir: string): void {
  const allSlots = findSlotDirs(lwDir);
  for (const s of allSlots) {
    if (isLockStale(s.dir)) {
      log(`  ${cl.yellow}Cleaning stale lock in a${s.slot} (process dead or lock expired)${cl.reset}`);
      unlockSlot(s.dir);
    }
  }
}

/** Fetch latest and checkout a PR branch in a slot. */
export function prepareSlot(slotDir: string, branch: string): boolean {
  try {
    // Fetch latest from origin
    execSync('git fetch origin', {
      cwd: slotDir,
      encoding: 'utf-8',
      timeout: 60000,
      stdio: 'pipe',
    });

    // Checkout the PR branch
    execSync(`git checkout -B "${branch}" "origin/${branch}"`, {
      cwd: slotDir,
      encoding: 'utf-8',
      timeout: 30000,
      stdio: 'pipe',
    });

    return true;
  } catch (e) {
    log(`  ${cl.red}Failed to prepare slot: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}${cl.reset}`);
    return false;
  }
}

/** Return a slot to main branch after fix. */
export function resetSlot(slotDir: string, branch?: string): void {
  try {
    // Discard any local changes
    try {
      execSync('git checkout -- .', { cwd: slotDir, timeout: 10000, stdio: 'pipe' });
    } catch { /* no tracked changes */ }
    try {
      execSync('git clean -fd --exclude=.agent-slot --exclude=.pr-patrol-lock --exclude=.envrc', {
        cwd: slotDir, timeout: 10000, stdio: 'pipe',
      });
    } catch { /* ignore */ }

    // Switch back to main
    execSync('git checkout main', { cwd: slotDir, timeout: 10000, stdio: 'pipe' });

    // Delete the old local branch
    if (branch) {
      try {
        execSync(`git branch -D "${branch}"`, { cwd: slotDir, timeout: 5000, stdio: 'pipe' });
      } catch { /* branch may not exist locally */ }
    }
  } catch (e) {
    log(`  ${cl.yellow}Warning: slot reset incomplete: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}${cl.reset}`);
  }
}

// ── PR claim management (parallel-safe) ──────────────────────────────────────

async function claimPr(prNum: number, repo: string): Promise<void> {
  try {
    await githubApi(`/repos/${repo}/issues/${prNum}/labels`, {
      method: 'POST',
      body: { labels: [LABELS.PR_PATROL_WORKING] },
    });
  } catch {
    log(`  ${cl.yellow}Warning: could not add ${LABELS.PR_PATROL_WORKING} label to PR #${prNum}${cl.reset}`);
  }
}

async function releasePr(prNum: number, repo: string): Promise<void> {
  try {
    await githubApi(
      `/repos/${repo}/issues/${prNum}/labels/${encodeURIComponent(LABELS.PR_PATROL_WORKING)}`,
      { method: 'DELETE' },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes('404') && !msg.includes('Not Found')) {
      log(`  Warning: could not remove pr-patrol:working label from PR #${prNum}: ${msg}`);
    }
  }
}

// ── Outcome classification ───────────────────────────────────────────────────

interface ClaudeResult {
  exitCode: number;
  output: string;
  hitMaxTurns: boolean;
  timedOut: boolean;
}

interface ClassifiedOutcome {
  outcome: FixOutcome;
  reason: string;
  mainIsRootCause: boolean;
}

/**
 * Classify the outcome of a Claude fix session.
 * Shared logic between serial and parallel modes.
 */
export function classifyFixOutcome(
  result: ClaudeResult,
  prNumber: number,
  effectiveTimeout: number,
  effectiveMaxTurns: number,
): ClassifiedOutcome {
  if (result.timedOut) {
    const failCount = recordFailure(prNumber);
    const reason = failCount >= 2
      ? `Abandoned after ${failCount} failures (timeout)`
      : `Killed after ${effectiveTimeout}m timeout — attempt ${failCount}`;
    return { outcome: 'timeout', reason, mainIsRootCause: false };
  }

  if (result.exitCode === 0 && !result.hitMaxTurns) {
    const isNoOp = looksLikeNoOp(result.output);
    if (isNoOp) {
      if (looksLikeMainRootCause(result.output)) {
        return {
          outcome: 'no-op',
          reason: 'No-op: CI failure is pre-existing on main branch',
          mainIsRootCause: true,
        };
      }
      const failCount = recordFailure(prNumber);
      return {
        outcome: 'no-op',
        reason: `No-op: agent determined issue needs human intervention (attempt ${failCount})`,
        mainIsRootCause: false,
      };
    }

    resetFailCount(prNumber);
    return { outcome: 'fixed', reason: '', mainIsRootCause: false };
  }

  if (result.hitMaxTurns) {
    const failCount = recordFailure(prNumber);
    const reason = failCount >= 2
      ? `Abandoned after ${failCount} failures`
      : `Hit max turns (${effectiveMaxTurns}) — attempt ${failCount}`;
    return { outcome: 'max-turns', reason, mainIsRootCause: false };
  }

  // Error exit
  const failCount = recordFailure(prNumber);
  const reason = failCount >= 2
    ? `Abandoned after ${failCount} failures (last: exit code ${result.exitCode})`
    : `Exit code: ${result.exitCode}`;
  return { outcome: 'error', reason, mainIsRootCause: false };
}

// ── Fix PR in slot ───────────────────────────────────────────────────────────

interface SlotFixResult {
  prNumber: number;
  slot: number;
  outcome: FixOutcome;
  reason: string;
  elapsedS: number;
}

async function fixPrInSlot(
  pr: ScoredPr,
  slot: SlotInfo,
  config: ParallelConfig,
): Promise<SlotFixResult> {
  const prefix = `[a${slot.slot}/#${pr.number}]`;
  log(`${prefix} Starting fix: ${pr.title}`);
  log(`${prefix} Issues: ${pr.issues.join(', ')}`);

  if (config.dryRun) {
    log(`${prefix} ${cl.dim}[DRY RUN] Would fix PR #${pr.number} in slot a${slot.slot}${cl.reset}`);
    return {
      prNumber: pr.number,
      slot: slot.slot,
      outcome: 'dry-run',
      reason: '',
      elapsedS: 0,
    };
  }

  const startTime = Date.now();

  // Lock slot
  lockSlot(slot.dir, pr.number);

  try {
    // Prepare slot: fetch + checkout PR branch
    if (!prepareSlot(slot.dir, pr.branch)) {
      return {
        prNumber: pr.number,
        slot: slot.slot,
        outcome: 'error',
        reason: 'Failed to checkout branch in slot',
        elapsedS: Math.floor((Date.now() - startTime) / 1000),
      };
    }

    // Automated rebase pre-step
    if (pr.issues.includes('stale') || pr.issues.includes('conflict')) {
      log(`${prefix} Attempting automated rebase...`);
      const rebaseResult = tryAutomatedRebase(pr.branch, slot.dir);

      if (rebaseResult.success) {
        log(`${prefix} Automated rebase ${rebaseResult.status} — no Claude needed`);
        const remainingIssues = pr.issues.filter((i) => i !== 'stale' && i !== 'conflict');
        if (remainingIssues.length === 0) {
          markProcessed(pr.number);
          return {
            prNumber: pr.number,
            slot: slot.slot,
            outcome: 'fixed',
            reason: `automated-rebase: ${rebaseResult.status}`,
            elapsedS: Math.floor((Date.now() - startTime) / 1000),
          };
        }
        pr.issues = remainingIssues;
        log(`${prefix} Remaining issues after rebase: ${remainingIssues.join(', ')}`);
      } else {
        log(`${prefix} Automated rebase failed (${rebaseResult.status}) — falling through to Claude`);
      }
    }

    // Claim PR on GitHub
    await claimPr(pr.number, config.repo);

    // Compute budget
    const failCount = getFailCount(pr.number);
    const { maxTurns: effectiveMaxTurns, timeoutMinutes: effectiveTimeout } =
      computeEffectiveBudget(pr.issues, config.maxTurns, config.timeoutMinutes, failCount);

    if (failCount > 0) {
      log(`${prefix} Retry #${failCount + 1} — budget reduced to ${effectiveMaxTurns} turns / ${effectiveTimeout}m`);
    }
    log(`${prefix} Budget: ${effectiveMaxTurns} max-turns, ${effectiveTimeout}m timeout`);

    // Post "attempting fix" comment
    await postEventComment(pr.number, config.repo, buildFixAttemptComment(pr.issues))
      .catch((e: unknown) => log(`${prefix} Warning: could not post fix attempt comment: ${e instanceof Error ? e.message : String(e)}`));

    // Build prompt and spawn Claude
    // Load slot's .env so Claude has API keys (parent process may not have them)
    const slotEnv = loadDotEnv(slot.dir);
    const prompt = buildPrompt(pr, config.repo);
    const result = await spawnClaude(prompt, {
      ...config,
      maxTurns: effectiveMaxTurns,
      timeoutMinutes: effectiveTimeout,
    }, { cwd: slot.dir, extraEnv: slotEnv });

    const elapsedS = Math.floor((Date.now() - startTime) / 1000);

    // Classify outcome
    const classified = classifyFixOutcome(result, pr.number, effectiveTimeout, effectiveMaxTurns);

    // Post outcome comments
    if (classified.outcome === 'fixed') {
      log(`${prefix} ${cl.green}Fixed${cl.reset} (${elapsedS}s)`);
      const outputTail = result.output.slice(-500);
      await postEventComment(pr.number, config.repo, buildFixCompleteComment(elapsedS, effectiveMaxTurns, config.model, pr.issues, outputTail))
        .catch((e: unknown) => log(`${prefix} Warning: could not post fix-complete comment: ${e instanceof Error ? e.message : String(e)}`));
    } else if (classified.outcome === 'no-op') {
      log(`${prefix} ${cl.yellow}No-op${cl.reset}: ${classified.reason} (${elapsedS}s)`);
      await postEventComment(pr.number, config.repo, buildNoOpComment(pr.issues))
        .catch((e: unknown) => log(`${prefix} Warning: could not post no-op comment: ${e instanceof Error ? e.message : String(e)}`));
    } else if (classified.outcome === 'timeout') {
      log(`${prefix} ${cl.red}Timeout${cl.reset} (${elapsedS}s)`);
      const currentFailCount = getFailCount(pr.number);
      if (currentFailCount >= config.abandonThreshold) {
        await postEventComment(pr.number, config.repo, buildAbandonmentComment(currentFailCount, pr.issues))
          .catch((e: unknown) => log(`${prefix} Warning: could not post abandonment comment: ${e instanceof Error ? e.message : String(e)}`));
      } else {
        await postEventComment(pr.number, config.repo, buildTimeoutComment(currentFailCount, effectiveTimeout, pr.issues))
          .catch((e: unknown) => log(`${prefix} Warning: could not post timeout comment: ${e instanceof Error ? e.message : String(e)}`));
      }
    } else if (classified.outcome === 'max-turns') {
      log(`${prefix} ${cl.yellow}Max turns${cl.reset} (${elapsedS}s)`);
      const currentFailCount = getFailCount(pr.number);
      if (currentFailCount >= config.abandonThreshold) {
        await postEventComment(pr.number, config.repo, buildAbandonmentComment(currentFailCount, pr.issues))
          .catch((e: unknown) => log(`${prefix} Warning: could not post abandonment comment: ${e instanceof Error ? e.message : String(e)}`));
      }
    } else {
      log(`${prefix} ${cl.red}Error${cl.reset}: ${classified.reason} (${elapsedS}s)`);
      const currentFailCount = getFailCount(pr.number);
      if (currentFailCount >= config.abandonThreshold) {
        await postEventComment(pr.number, config.repo, buildAbandonmentComment(currentFailCount, pr.issues))
          .catch((e: unknown) => log(`${prefix} Warning: could not post abandonment comment: ${e instanceof Error ? e.message : String(e)}`));
      }
    }

    // Log to JSONL
    appendJsonl(JSONL_FILE, {
      type: 'pr_result',
      pr_num: pr.number,
      issues: pr.issues,
      outcome: classified.outcome,
      elapsed_s: elapsedS,
      reason: classified.reason || undefined,
      parallel: true,
      slot: slot.slot,
    });

    markProcessed(pr.number);

    return {
      prNumber: pr.number,
      slot: slot.slot,
      outcome: classified.outcome,
      reason: classified.reason,
      elapsedS,
    };
  } finally {
    // Always release PR claim and reset slot
    await releasePr(pr.number, config.repo);
    resetSlot(slot.dir, pr.branch);
    unlockSlot(slot.dir);
  }
}

// ── Parallel dispatch ────────────────────────────────────────────────────────

interface CycleResult {
  dispatched: number;
  results: SlotFixResult[];
}

/**
 * Dispatch fixes across available slots in parallel.
 */
async function dispatchFixes(
  ranked: ScoredPr[],
  slots: SlotInfo[],
  config: ParallelConfig,
): Promise<CycleResult> {
  const pairs = ranked.slice(0, slots.length).map((pr, i) => ({
    pr,
    slot: slots[i],
  }));

  if (pairs.length === 0) {
    return { dispatched: 0, results: [] };
  }

  log('');
  log(`${cl.bold}Dispatching ${pairs.length} fix(es) in parallel:${cl.reset}`);
  for (const { pr, slot } of pairs) {
    log(`  a${slot.slot} → PR #${pr.number} (${pr.issues.join(', ')}) — ${pr.title}`);
  }
  log('');

  const promises = pairs.map(({ pr, slot }) =>
    fixPrInSlot(pr, slot, config).catch((e): SlotFixResult => {
      log(`${cl.red}[a${slot.slot}/#${pr.number}] Unexpected error: ${e instanceof Error ? e.message : String(e)}${cl.reset}`);
      return {
        prNumber: pr.number,
        slot: slot.slot,
        outcome: 'error',
        reason: `Unexpected: ${e instanceof Error ? e.message : String(e)}`,
        elapsedS: 0,
      };
    }),
  );

  const settled = await Promise.allSettled(promises);
  const results = settled.map((r) =>
    r.status === 'fulfilled'
      ? r.value
      : {
          prNumber: 0,
          slot: 0,
          outcome: 'error' as FixOutcome,
          reason: `Promise rejected: ${r.reason}`,
          elapsedS: 0,
        },
  );

  return { dispatched: pairs.length, results };
}

// ── Auto-refresh merged-PR slots ─────────────────────────────────────────────

/**
 * Automatically reset slots whose PR has been merged back to main.
 * This keeps the slot pool healthy without manual intervention.
 */
function autoRefreshSlots(lwDir: string, slotRange: [number, number]): void {
  const allSlots = findSlotDirs(lwDir);
  for (const s of allSlots) {
    if (s.slot < slotRange[0] || s.slot > slotRange[1]) continue;

    const branch = gitInDir(s.dir, 'branch', '--show-current');
    if (branch === 'main' || !branch) continue;

    // Skip locked slots
    if (existsSync(join(s.dir, LOCK_FILE_NAME)) && !isLockStale(s.dir)) continue;

    // Check if the branch's PR has been merged
    let prState = '';
    try {
      prState = execSync(
        `gh pr view "${branch}" --json state --jq .state 2>/dev/null`,
        { cwd: s.dir, encoding: 'utf-8', timeout: 10000 },
      ).trim();
    } catch {
      // gh not available or no PR — skip
      continue;
    }

    if (prState === 'MERGED') {
      log(`  ${cl.cyan}Auto-refreshing a${s.slot}: ${branch} (PR merged)${cl.reset}`);
      resetSlot(s.dir, branch);
    }
  }
}

// ── Single parallel cycle ────────────────────────────────────────────────────

export async function runParallelCycle(config: ParallelConfig): Promise<CycleResult> {
  logHeader('Parallel patrol cycle');

  // 0. Housekeeping: clean stale locks and refresh merged-PR slots
  const lwDir = getLwDir();
  cleanStaleLocks(lwDir);
  autoRefreshSlots(lwDir, config.slotRange);

  // 1. Detect: Fetch open PRs and find issues
  const allPrs = await fetchOpenPrs(config);
  const detected = detectAllPrIssuesFromNodes(allPrs, config);

  if (detected.length === 0) {
    log(`${cl.green}All PRs clean${cl.reset} — nothing to fix`);
    return { dispatched: 0, results: [] };
  }

  // Filter cooldowns and abandoned (parallel uses higher threshold than serial)
  const eligible = detected.filter((pr) => {
    if (getFailCount(pr.number) >= config.abandonThreshold) {
      log(`  ${cl.dim}Skipping PR #${pr.number} (abandoned — ${getFailCount(pr.number)} failures, threshold ${config.abandonThreshold})${cl.reset}`);
      return false;
    }
    if (isRecentlyProcessed(pr.number, config.cooldownSeconds)) {
      log(`  ${cl.dim}Skipping PR #${pr.number} (recently processed)${cl.reset}`);
      return false;
    }
    return true;
  });

  const ranked = rankPrs(eligible);
  if (ranked.length === 0) {
    log(`${cl.dim}All issues recently processed — nothing to fix${cl.reset}`);
    return { dispatched: 0, results: [] };
  }

  log(`${cl.bold}Fix queue${cl.reset} (${ranked.length} items):`);
  for (const pr of ranked) {
    log(`  [score=${pr.score}] PR ${cl.cyan}#${pr.number}${cl.reset}: ${pr.issues.join(',')} — ${pr.title}`);
  }

  // 2. Allocate: Find idle slots
  log('');
  log(`${cl.bold}Scanning slots${cl.reset} (range a${config.slotRange[0]}–a${config.slotRange[1]})...`);
  const idleSlots = findIdleSlots(lwDir, config.slotRange);

  if (idleSlots.length === 0) {
    log(`${cl.yellow}No idle slots available${cl.reset}`);
    return { dispatched: 0, results: [] };
  }

  // Reserve slots for manual use
  const availableSlots = idleSlots.length > config.reserveSlots
    ? idleSlots.slice(0, idleSlots.length - config.reserveSlots)
    : [];

  if (availableSlots.length === 0) {
    log(`${cl.yellow}All ${idleSlots.length} idle slot(s) reserved (--reserve-slots=${config.reserveSlots})${cl.reset}`);
    return { dispatched: 0, results: [] };
  }

  // Cap by maxSlots
  const slotsToUse = availableSlots.slice(0, config.maxSlots);
  log(`${cl.green}${slotsToUse.length} slot(s) available${cl.reset} (${idleSlots.length} idle, ${config.reserveSlots} reserved): ${slotsToUse.map((s) => `a${s.slot}`).join(', ')}`);

  // 3. Dispatch fixes
  const result = await dispatchFixes(ranked, slotsToUse, config);

  // 4. Merge phase — reconcile labels, undraft, enqueue eligible PRs
  await reconcileMergeQueueLabels(allPrs, config);

  const deployHealth: DeployHealthStatus = await libCheckDeployHealth(config.repo).catch((e) => {
    log(`  ${cl.yellow}Warning: deploy health check failed: ${e instanceof Error ? e.message : String(e)}${cl.reset}`);
    return { healthy: true, lastDeploy: null, failingSince: null } as DeployHealthStatus;
  });

  // Undraft phase
  const draftCandidates = findMergeCandidates(allPrs).filter(
    (c) => !c.eligible && c.blockReasons.length === 1 && c.blockReasons[0] === 'is-draft',
  );
  const undraftedNumbers = new Set<number>();
  for (const candidate of draftCandidates) {
    if (config.dryRun) {
      log(`  [DRY RUN] Would undraft PR #${candidate.number}`);
      undraftedNumbers.add(candidate.number);
    } else {
      const success = await undraftPr(candidate.number, config);
      if (success) undraftedNumbers.add(candidate.number);
    }
  }

  // Re-evaluate merge candidates after undrafting
  const mergeCandidates = findMergeCandidates(allPrs).map((c) => {
    if (undraftedNumbers.has(c.number)) {
      const updated = { ...c, blockReasons: c.blockReasons.filter((r) => r !== 'is-draft') };
      return { ...updated, eligible: updated.blockReasons.length === 0 };
    }
    return c;
  });
  const eligibleForMerge = mergeCandidates.filter((c) => c.eligible);

  // Upsert status comments
  const prNodeByNumber = new Map(allPrs.map((p) => [p.number, p]));
  for (const mc of mergeCandidates) {
    const prNode = prNodeByNumber.get(mc.number);
    if (!prNode) continue;
    const statusBody = buildStatusCommentBody(prNode, mc.blockReasons);
    await upsertStatusComment(mc.number, config.repo, statusBody)
      .catch((e: unknown) => log(`  ${cl.yellow}Warning: could not upsert status comment on PR #${mc.number}: ${e instanceof Error ? e.message : String(e)}${cl.reset}`));
  }

  // Enqueue eligible PRs (skip if deploy is failing)
  const enqueuedPrs: number[] = [];
  if (!deployHealth.healthy) {
    log(`  ${cl.yellow}Skipping merge enqueue — deploy pipeline is failing${cl.reset}`);
  } else {
    for (const candidate of eligibleForMerge) {
      const outcome = await enqueuePr(candidate, config);
      if (outcome === 'enqueued' || outcome === 'dry-run') {
        enqueuedPrs.push(candidate.number);
      }
    }
  }

  // 5. Summary
  log('');
  logHeader('Parallel cycle complete');
  const fixed = result.results.filter((r) => r.outcome === 'fixed').length;
  const noOps = result.results.filter((r) => r.outcome === 'no-op').length;
  const errors = result.results.filter((r) => r.outcome === 'error' || r.outcome === 'timeout' || r.outcome === 'max-turns').length;
  const dryRuns = result.results.filter((r) => r.outcome === 'dry-run').length;

  const mergeInfo = enqueuedPrs.length > 0
    ? `, Enqueued: [${enqueuedPrs.map((n) => `#${n}`).join(', ')}]`
    : mergeCandidates.length > 0
      ? `, Merge candidates: ${mergeCandidates.length} (${eligibleForMerge.length} eligible)`
      : '';
  log(`Dispatched: ${result.dispatched}, Fixed: ${fixed}, No-op: ${noOps}, Errors: ${errors}${dryRuns > 0 ? `, Dry-run: ${dryRuns}` : ''}${mergeInfo}`);

  for (const r of result.results) {
    const icon = r.outcome === 'fixed' ? cl.green + '✓' :
                 r.outcome === 'dry-run' ? cl.dim + '○' :
                 r.outcome === 'no-op' ? cl.yellow + '⚠' :
                 cl.red + '✗';
    log(`  ${icon}${cl.reset} a${r.slot} → PR #${r.prNumber}: ${r.outcome} (${r.elapsedS}s)${r.reason ? ` — ${r.reason}` : ''}`);
  }

  // Log cycle summary
  appendJsonl(JSONL_FILE, {
    type: 'parallel_cycle_summary',
    dispatched: result.dispatched,
    fixed,
    no_ops: noOps,
    errors,
    prs_enqueued: enqueuedPrs.length > 0 ? enqueuedPrs : undefined,
    merge_candidates: mergeCandidates.length,
    merge_eligible: eligibleForMerge.length,
    deploy_healthy: deployHealth.healthy,
    slots_used: slotsToUse.map((s) => s.slot),
    results: result.results.map((r) => ({
      pr: r.prNumber,
      slot: r.slot,
      outcome: r.outcome,
      elapsed_s: r.elapsedS,
    })),
  });

  // Write state file for monitoring
  setParallelState({
    lastCycleAt: new Date().toISOString(),
    slotsUsed: slotsToUse.map((s) => s.slot),
    dispatched: result.dispatched,
    fixed,
    errors,
  });

  return result;
}

// ── Parallel daemon (continuous loop) ────────────────────────────────────────

export async function runParallelDaemon(config: ParallelConfig): Promise<void> {
  ensureDirs();

  logHeader('PR Patrol Parallel starting');
  log(`Config: max-slots=${config.maxSlots}, slot-range=${config.slotRange[0]}-${config.slotRange[1]}, reserve-slots=${config.reserveSlots}`);
  log(`  interval=${config.intervalSeconds}s, model=${config.model}, cooldown=${config.cooldownSeconds}s`);
  log(`  mode=${config.once ? 'single pass' : config.dryRun ? 'dry run' : 'continuous'}`);
  log(`  JSONL: ${JSONL_FILE}`);

  if (!process.env.GITHUB_TOKEN) {
    log(`${cl.red}ERROR: GITHUB_TOKEN not set${cl.reset}`);
    process.exit(1);
  }

  // Signal handlers for graceful shutdown
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('Shutting down parallel patrol...');
    // Locks will be cleaned up naturally on next cycle since they contain PIDs
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown());
  process.on('SIGTERM', () => shutdown());

  if (config.once) {
    await runParallelCycle(config);
    return;
  }

  let cycleCount = 0;
  while (!shuttingDown) {
    cycleCount++;
    try {
      await runParallelCycle(config);
    } catch (e) {
      log(`${cl.red}Parallel cycle failed: ${e instanceof Error ? e.message : String(e)}${cl.reset}`);
    }

    log(`${cl.dim}Sleeping ${config.intervalSeconds}s until next cycle...${cl.reset}`);
    await new Promise((r) => setTimeout(r, config.intervalSeconds * 1000));
  }
}

// ── Config builder ───────────────────────────────────────────────────────────

export function buildParallelConfig(
  args: string[],
  options: Record<string, unknown>,
): ParallelConfig {
  // Build base config inline (mirrors buildConfig in index.ts to avoid circular import)
  const base: PatrolConfig = {
    repo: (process.env.PR_PATROL_REPO as string) ?? REPO,
    intervalSeconds: parseIntOpt(
      options.interval ?? process.env.PR_PATROL_INTERVAL,
      300,
    ),
    maxTurns: parseIntOpt(
      options.maxTurns ?? process.env.PR_PATROL_MAX_TURNS,
      60,
    ),
    cooldownSeconds: parseIntOpt(
      options.cooldown ?? process.env.PR_PATROL_COOLDOWN,
      1800,
    ),
    staleHours: parseIntOpt(
      options.staleHours ?? process.env.PR_PATROL_STALE_HOURS,
      48,
    ),
    model:
      (options.model as string) ??
      process.env.PR_PATROL_MODEL ??
      'sonnet',
    skipPerms:
      options.skipPerms === true ||
      process.env.PR_PATROL_SKIP_PERMS === '1',
    once: options.once === true,
    dryRun: options.dryRun === true,
    verbose: options.verbose === true,
    reflectionInterval: Math.max(
      1,
      parseIntOpt(process.env.PR_PATROL_REFLECTION_INTERVAL, 10),
    ),
    timeoutMinutes: parseIntOpt(
      options.timeout ?? process.env.PR_PATROL_TIMEOUT_MINUTES,
      60,
    ),
  };

  // Parse slot range (e.g., "2-10")
  let slotRange: [number, number] = [2, 15];
  if (typeof options.slotRange === 'string') {
    const match = options.slotRange.match(/^(\d+)-(\d+)$/);
    if (match) {
      slotRange = [parseInt(match[1], 10), parseInt(match[2], 10)];
    }
  }

  return {
    ...base,
    maxSlots: typeof options.maxSlots === 'number'
      ? options.maxSlots
      : typeof options.maxSlots === 'string'
        ? parseInt(options.maxSlots, 10) || 5
        : 5,
    slotRange,
    reserveSlots: typeof options.reserveSlots === 'number'
      ? options.reserveSlots
      : typeof options.reserveSlots === 'string'
        ? parseInt(options.reserveSlots, 10) || 2
        : 2,
    abandonThreshold: typeof options.abandonThreshold === 'number'
      ? options.abandonThreshold
      : typeof options.abandonThreshold === 'string'
        ? parseInt(options.abandonThreshold, 10) || 4
        : 4,
  };
}
