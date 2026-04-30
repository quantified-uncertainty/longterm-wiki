/**
 * PR Patrol — State management (cooldowns, failure tracking, JSONL logging)
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import lockfile from 'proper-lockfile';
import { getColors } from '../lib/output.ts';

// ── Paths ────────────────────────────────────────────────────────────────────

export const CACHE_DIR = join(process.env.HOME ?? '/tmp', '.cache', 'pr-patrol');
// State persists across reboots in ~/.cache (not /tmp which is cleared on restart)
export const STATE_DIR = join(CACHE_DIR, 'state');
export const JSONL_FILE = join(CACHE_DIR, 'runs.jsonl');
export const REFLECTION_FILE = join(CACHE_DIR, 'reflections.jsonl');

const LEGACY_STATE_DIR = '/tmp/pr-patrol-shared';

export function ensureDirs(): void {
  mkdirSync(STATE_DIR, { recursive: true });
  mkdirSync(CACHE_DIR, { recursive: true });

  // Migrate legacy state files from /tmp/pr-patrol-shared/ to ~/.cache/pr-patrol/state/
  if (existsSync(LEGACY_STATE_DIR)) {
    try {
      const files = readdirSync(LEGACY_STATE_DIR);
      for (const file of files) {
        const src = join(LEGACY_STATE_DIR, file);
        const dest = join(STATE_DIR, file);
        if (!existsSync(dest)) {
          writeFileSync(dest, readFileSync(src, 'utf-8'));
        }
      }
    } catch {
      // Migration is best-effort — old state will be re-created naturally
    }
  }
}

// ── Logging ──────────────────────────────────────────────────────────────────

const cl = getColors();

/** Exported for submodules that need to colorize their own log messages. */
export { cl };

function formatLocalTime(): string {
  return new Date().toLocaleTimeString('en-US', {
    timeZone: 'America/Los_Angeles',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function log(msg: string): void {
  console.error(`${cl.dim}${formatLocalTime()}${cl.reset} ${msg}`);
}

export function logHeader(msg: string): void {
  const t = formatLocalTime();
  console.error('');
  console.error(`${cl.dim}${t}${cl.reset} ${cl.cyan}${'─'.repeat(50)}${cl.reset}`);
  console.error(`${cl.dim}${t}${cl.reset} ${cl.bold}${msg}${cl.reset}`);
  console.error(`${cl.dim}${t}${cl.reset} ${cl.cyan}${'─'.repeat(50)}${cl.reset}`);
}

export function appendJsonl(file: string, entry: Record<string, unknown>): void {
  appendFileSync(
    file,
    JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + '\n',
  );
}

/**
 * Append a JSONL entry while holding an exclusive file lock, so concurrent
 * patrol runs (e.g., two slots calling `pr-patrol once` simultaneously) don't
 * produce interleaved / truncated lines.
 *
 * Uses a sibling `.lock` directory next to the target file. Each call retries
 * briefly on contention and always releases the lock in a finally block.
 *
 * Falls back to a plain appendFileSync on any lock-setup error so writes are
 * never lost — worst case, we risk corruption of a single line, which the
 * readAllEntries skip-malformed-line tolerance already handles.
 */
export async function appendJsonlLocked(
  file: string,
  entry: Record<string, unknown>,
): Promise<void> {
  const line =
    JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + '\n';

  // proper-lockfile requires the locked file to exist; create it if missing.
  if (!existsSync(file)) {
    try {
      writeFileSync(file, '', { flag: 'a' });
    } catch {
      /* best-effort; fall through */
    }
  }

  let release: (() => Promise<void>) | null = null;
  try {
    release = await lockfile.lock(file, {
      retries: { retries: 10, minTimeout: 20, maxTimeout: 200 },
      stale: 10_000, // stale locks expire after 10s
    });
    appendFileSync(file, line);
  } catch {
    // Lock acquisition failed — fall back to unlocked append.
    // The reader already skips malformed lines, so a rare interleave is tolerable.
    try {
      appendFileSync(file, line);
    } catch {
      /* best-effort */
    }
  } finally {
    if (release) {
      try {
        await release();
      } catch {
        /* best-effort */
      }
    }
  }
}

// ── Cooldown tracking ────────────────────────────────────────────────────────

export function isRecentlyProcessed(key: number | string, cooldownSeconds: number): boolean {
  const file = join(STATE_DIR, `processed-${key}`);
  if (!existsSync(file)) return false;
  const last = Number(readFileSync(file, 'utf-8').trim());
  return Date.now() / 1000 - last < cooldownSeconds;
}

export function markProcessed(key: number | string): void {
  writeFileSync(
    join(STATE_DIR, `processed-${key}`),
    String(Math.floor(Date.now() / 1000)),
  );
}

// ── Failure tracking ─────────────────────────────────────────────────────────

export function getFailCount(key: number | string): number {
  // Check both new and legacy file names for backwards compat
  const newFile = join(STATE_DIR, `failures-${key}`);
  const legacyFile = join(STATE_DIR, `max-turns-${key}`);
  if (existsSync(newFile)) {
    return parseInt(readFileSync(newFile, 'utf-8').trim(), 10) || 0;
  }
  if (existsSync(legacyFile)) {
    return parseInt(readFileSync(legacyFile, 'utf-8').trim(), 10) || 0;
  }
  return 0;
}

export function recordFailure(key: number | string): number {
  const count = getFailCount(key) + 1;
  writeFileSync(join(STATE_DIR, `failures-${key}`), String(count));
  return count;
}

export function resetFailCount(key: number | string): void {
  const file = join(STATE_DIR, `failures-${key}`);
  if (existsSync(file)) writeFileSync(file, '0');
  // Also clear legacy file so getFailCount() doesn't return stale values
  const legacyFile = join(STATE_DIR, `max-turns-${key}`);
  if (existsSync(legacyFile)) writeFileSync(legacyFile, '0');
}

/**
 * Check if a PR is permanently abandoned. Uses a persistent file rather than
 * deriving from fail count, so abandonment survives cooldown expiry.
 * A new push to the PR branch (detected by SHA change) clears the flag.
 */
export function isAbandoned(key: number | string): boolean {
  const file = join(STATE_DIR, `abandoned-${key}`);
  if (!existsSync(file)) {
    // Fallback: also check fail count for backward compat with pre-migration state
    return getFailCount(key) >= 2;
  }
  return true;
}

/**
 * Mark a PR as permanently abandoned (persisted to disk).
 * Stores the HEAD SHA at abandonment time so we can detect new pushes.
 */
export function markAbandoned(prNumber: number | string, headSha?: string): void {
  const file = join(STATE_DIR, `abandoned-${prNumber}`);
  writeFileSync(file, JSON.stringify({
    abandonedAt: new Date().toISOString(),
    headSha: headSha ?? '',
  }));
}

/**
 * Get the SHA that was HEAD when the PR was abandoned (for detecting new pushes).
 */
export function getAbandonedSha(prNumber: number | string): string | null {
  const file = join(STATE_DIR, `abandoned-${prNumber}`);
  if (!existsSync(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, 'utf-8'));
    return data.headSha || null;
  } catch {
    return null;
  }
}

/**
 * Clear abandoned state (used when a new push is detected on the PR).
 */
export function clearAbandoned(prNumber: number | string): void {
  const file = join(STATE_DIR, `abandoned-${prNumber}`);
  if (existsSync(file)) {
    try { unlinkSync(file); } catch { /* best-effort */ }
  }
  // Also reset fail count so the PR gets a fresh start
  resetFailCount(prNumber);
}

// ── Main branch cooldown (shorter than PR cooldown) ─────────────────────────

/** Main branch uses a much shorter cooldown (5 min) since it blocks all PR work. */
export const MAIN_BRANCH_COOLDOWN_SECONDS = 300;

/**
 * Main branch gets a higher abandonment threshold (4 vs 2) because:
 * - Misdiagnosis is common (flaky vs real failure)
 * - Main being broken blocks all PR work, so retrying is high-value
 */
export const MAIN_BRANCH_ABANDON_THRESHOLD = 4;

export function isMainBranchAbandoned(key: string): boolean {
  return getFailCount(key) >= MAIN_BRANCH_ABANDON_THRESHOLD;
}

// ── Tracked main fix PR ─────────────────────────────────────────────────────
// When the patrol creates a fix PR for main, track it so we can poll for merge
// and re-evaluate blocked PRs once main is green.

const TRACKED_FIX_FILE = join(STATE_DIR, 'tracked-main-fix');

export interface TrackedMainFix {
  prNumber: number;
  createdAt: string; // ISO timestamp
}

export function trackMainFixPr(prNumber: number): void {
  const data: TrackedMainFix = {
    prNumber,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(TRACKED_FIX_FILE, JSON.stringify(data));
}

/** Max age (24h) before we stop polling a tracked fix PR and clear the tracking. */
const TRACKED_FIX_TTL_MS = 24 * 60 * 60 * 1000;

export function getTrackedMainFixPr(): TrackedMainFix | null {
  if (!existsSync(TRACKED_FIX_FILE)) return null;
  try {
    const raw = JSON.parse(readFileSync(TRACKED_FIX_FILE, 'utf-8'));
    // Validate expected shape
    if (typeof raw?.prNumber !== 'number' || typeof raw?.createdAt !== 'string') {
      return null;
    }
    // Auto-expire stale tracked PRs (>24h)
    const age = Date.now() - new Date(raw.createdAt).getTime();
    if (age > TRACKED_FIX_TTL_MS) {
      clearTrackedMainFixPr();
      return null;
    }
    return raw as TrackedMainFix;
  } catch {
    return null;
  }
}

export function clearTrackedMainFixPr(): void {
  try {
    if (existsSync(TRACKED_FIX_FILE)) unlinkSync(TRACKED_FIX_FILE);
  } catch {
    // Best-effort cleanup — file may already be gone
  }
}

// ── Circuit breaker for systematic spawn failures ────────────────────────────
// When 3+ consecutive dispatches fail instantly (< 15s, exit code error),
// pause all dispatching for 15 minutes to prevent cascade waste.

const CIRCUIT_BREAKER_FILE = join(STATE_DIR, 'circuit-breaker');
const CIRCUIT_THRESHOLD = 3; // consecutive instant failures to trip
const CIRCUIT_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes
const INSTANT_FAILURE_THRESHOLD_S = 15; // failures under this duration count

interface CircuitBreakerState {
  consecutiveInstantFailures: number;
  trippedAt: string | null; // ISO timestamp when circuit was opened
}

function readCircuitState(): CircuitBreakerState {
  if (!existsSync(CIRCUIT_BREAKER_FILE)) {
    return { consecutiveInstantFailures: 0, trippedAt: null };
  }
  try {
    return JSON.parse(readFileSync(CIRCUIT_BREAKER_FILE, 'utf-8'));
  } catch {
    return { consecutiveInstantFailures: 0, trippedAt: null };
  }
}

function writeCircuitState(state: CircuitBreakerState): void {
  writeFileSync(CIRCUIT_BREAKER_FILE, JSON.stringify(state));
}

/**
 * Record an instant failure (outcome "error" with elapsed < 15s).
 * Returns true if the circuit just tripped.
 */
export function recordInstantFailure(): boolean {
  const state = readCircuitState();
  state.consecutiveInstantFailures += 1;
  if (state.consecutiveInstantFailures >= CIRCUIT_THRESHOLD && !state.trippedAt) {
    state.trippedAt = new Date().toISOString();
    writeCircuitState(state);
    return true; // just tripped
  }
  writeCircuitState(state);
  return false;
}

/**
 * Reset the circuit breaker (called on any non-instant outcome).
 */
export function resetCircuit(): void {
  const state = readCircuitState();
  if (state.consecutiveInstantFailures > 0 || state.trippedAt) {
    writeCircuitState({ consecutiveInstantFailures: 0, trippedAt: null });
  }
}

/**
 * Check if the circuit breaker is open (dispatching should be paused).
 * The circuit auto-closes after CIRCUIT_COOLDOWN_MS.
 */
export function isCircuitOpen(): boolean {
  const state = readCircuitState();
  if (!state.trippedAt) return false;
  const elapsed = Date.now() - new Date(state.trippedAt).getTime();
  if (elapsed >= CIRCUIT_COOLDOWN_MS) {
    // Auto-close the circuit after cooldown expires
    writeCircuitState({ consecutiveInstantFailures: 0, trippedAt: null });
    return false;
  }
  return true;
}

/** Threshold in seconds below which a failure is considered "instant". */
export const INSTANT_FAILURE_THRESHOLD_SECONDS = INSTANT_FAILURE_THRESHOLD_S;

// ── Auto-merge availability circuit breaker (QUA-858) ───────────────────────
// When GitHub returns "Auto merge is not allowed for this repository", the
// repository setting is disabled. Retrying every cycle wastes API calls and
// pollutes PR threads with failure comments. Pause auto-merge attempts for
// 1 hour so a fix to the repo setting is auto-detected on next attempt.

const AUTO_MERGE_DISABLED_FILE = join(STATE_DIR, 'auto-merge-disabled');
const AUTO_MERGE_DISABLED_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

/** Substring of the GitHub error message that indicates a repo-level disable. */
export const REPO_AUTO_MERGE_DISABLED_ERROR_FRAGMENT =
  'Auto merge is not allowed for this repository';

interface AutoMergeDisabledState {
  reason: string;
  disabledAt: string; // ISO timestamp
}

/**
 * Mark auto-merge as disabled at the repository level. Subsequent calls to
 * `isAutoMergeDisabled()` return `disabled: true` until the cooldown elapses.
 * Idempotent — repeated calls do not extend the cooldown beyond the first
 * mark, so a flapping setting still self-heals after one cooldown window.
 */
export function markAutoMergeDisabled(reason: string): void {
  if (existsSync(AUTO_MERGE_DISABLED_FILE)) {
    // Already marked — preserve the original disabledAt so cooldown is bounded
    return;
  }
  const state: AutoMergeDisabledState = {
    reason,
    disabledAt: new Date().toISOString(),
  };
  writeFileSync(AUTO_MERGE_DISABLED_FILE, JSON.stringify(state));
}

/**
 * Returns whether auto-merge is currently paused due to a prior repo-level
 * failure. Auto-clears the state file once the cooldown has elapsed.
 */
export function isAutoMergeDisabled():
  | { disabled: false }
  | { disabled: true; reason: string; disabledAt: string } {
  if (!existsSync(AUTO_MERGE_DISABLED_FILE)) return { disabled: false };
  try {
    const state = JSON.parse(
      readFileSync(AUTO_MERGE_DISABLED_FILE, 'utf-8'),
    ) as AutoMergeDisabledState;
    const elapsed = Date.now() - new Date(state.disabledAt).getTime();
    if (elapsed >= AUTO_MERGE_DISABLED_COOLDOWN_MS) {
      try { unlinkSync(AUTO_MERGE_DISABLED_FILE); } catch { /* best-effort */ }
      return { disabled: false };
    }
    return { disabled: true, reason: state.reason, disabledAt: state.disabledAt };
  } catch {
    // Corrupt file — treat as cleared
    try { unlinkSync(AUTO_MERGE_DISABLED_FILE); } catch { /* best-effort */ }
    return { disabled: false };
  }
}

/** Manually clear the auto-merge-disabled state (useful for tests / operators). */
export function clearAutoMergeDisabled(): void {
  if (existsSync(AUTO_MERGE_DISABLED_FILE)) {
    try { unlinkSync(AUTO_MERGE_DISABLED_FILE); } catch { /* best-effort */ }
  }
}

/** Cooldown duration exposed for tests. */
export const AUTO_MERGE_DISABLED_COOLDOWN_SECONDS =
  AUTO_MERGE_DISABLED_COOLDOWN_MS / 1000;

// ── Total fix attempt tracking (anti-oscillation) ───────────────────────────
// Tracks cumulative fix attempts per PR regardless of intermediate successes.
// Prevents the fix→verify-fail→fix→verify-fail oscillation pattern (#3755, #3757)
// where intermittent CI passes reset the consecutive fail counter.
// Total attempts are only cleared on new pushes (SHA change), not on CI pass.

const MAX_TOTAL_FIX_ATTEMPTS = 4;

export function getTotalFixAttempts(prNumber: number | string): number {
  const file = join(STATE_DIR, `total-attempts-${prNumber}`);
  if (!existsSync(file)) return 0;
  return parseInt(readFileSync(file, 'utf-8').trim(), 10) || 0;
}

export function recordFixAttempt(prNumber: number | string): number {
  const count = getTotalFixAttempts(prNumber) + 1;
  writeFileSync(join(STATE_DIR, `total-attempts-${prNumber}`), String(count));
  return count;
}

export function clearTotalFixAttempts(prNumber: number | string): void {
  const file = join(STATE_DIR, `total-attempts-${prNumber}`);
  if (existsSync(file)) {
    try { unlinkSync(file); } catch { /* best-effort */ }
  }
}

export function hasExceededMaxAttempts(prNumber: number | string): boolean {
  return getTotalFixAttempts(prNumber) >= MAX_TOTAL_FIX_ATTEMPTS;
}

// ── Pending CI check (post-fix) ──────────────────────────────────────
// After a "fixed" outcome, we don't reset the fail counter immediately.
// Instead we mark the PR as "pending CI check" and only reset when CI passes.

export function markPendingCICheck(prNumber: number): void {
  writeFileSync(join(STATE_DIR, `pending-verify-${prNumber}`), new Date().toISOString());
}

export function isPendingCICheck(prNumber: number): boolean {
  return existsSync(join(STATE_DIR, `pending-verify-${prNumber}`));
}

export function clearPendingCICheck(prNumber: number): void {
  const file = join(STATE_DIR, `pending-verify-${prNumber}`);
  if (existsSync(file)) {
    try { unlinkSync(file); } catch { /* best-effort */ }
  }
}

// ── Processed blocking comments (QUA-514) ───────────────────────────────────
//
// Patrol idempotency for `self-authored-feedback`: before this tracker, patrol
// would re-detect the same post-push OWNER comment every cycle and dispatch
// a fresh fix attempt (PR #4371 burned ~20 cycles on one dismissed CodeRabbit
// nit). We cache `(prNumber, headSha, commentId[])` so a comment is only
// acted on once per SHA. A new push (SHA change) invalidates the cache —
// a fresh push gets a fresh look.
//
// File layout: `processed-comments-<N>.json` with `{ headSha, ids[] }`. If
// the stored headSha doesn't match the caller's current headSha, we treat
// the file as stale and return an empty set (we do NOT delete, since the
// next mark call will overwrite anyway).

interface ProcessedBlockingCommentsFile {
  headSha: string;
  ids: string[];
}

function processedCommentsFile(prNumber: number | string): string {
  return join(STATE_DIR, `processed-comments-${prNumber}.json`);
}

function readProcessedCommentsFile(
  prNumber: number | string,
): ProcessedBlockingCommentsFile | null {
  const file = processedCommentsFile(prNumber);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    if (
      raw &&
      typeof raw === 'object' &&
      typeof raw.headSha === 'string' &&
      Array.isArray(raw.ids) &&
      raw.ids.every((x: unknown) => typeof x === 'string')
    ) {
      return raw as ProcessedBlockingCommentsFile;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Return the set of blocking comment IDs patrol has already processed for
 * this PR at the given head SHA. If the stored file is for a different SHA
 * (or missing/corrupt), returns an empty set — the caller will then treat
 * every current blocking comment as new.
 */
export function getProcessedBlockingCommentIds(
  prNumber: number | string,
  headSha: string,
): Set<string> {
  const data = readProcessedCommentsFile(prNumber);
  if (!data || data.headSha !== headSha) return new Set();
  return new Set(data.ids);
}

/**
 * Merge `newIds` into the processed-comments set for this PR at `headSha`.
 *
 * - If the stored file is for a different SHA, the old list is discarded
 *   and replaced with `newIds` (force-push resets the cache naturally).
 * - If the stored file matches, `newIds` is unioned with the existing list.
 * - Empty `newIds` with a matching SHA is a no-op.
 */
export function markBlockingCommentsProcessed(
  prNumber: number | string,
  headSha: string,
  newIds: readonly string[],
): void {
  const existing = readProcessedCommentsFile(prNumber);
  const ids =
    existing && existing.headSha === headSha
      ? Array.from(new Set([...existing.ids, ...newIds]))
      : Array.from(new Set(newIds));
  if (ids.length === 0 && !existing) return;
  const payload: ProcessedBlockingCommentsFile = { headSha, ids };
  writeFileSync(processedCommentsFile(prNumber), JSON.stringify(payload));
}

/** Remove the processed-comments cache file for this PR. */
export function clearProcessedBlockingComments(prNumber: number | string): void {
  const file = processedCommentsFile(prNumber);
  if (existsSync(file)) {
    try {
      unlinkSync(file);
    } catch {
      /* best-effort */
    }
  }
}

// ── CodeRabbit review retry tracking ─────────────────────────────────────────
// When CodeRabbit rate-limits a review, we schedule a retry after the cooldown.
// Only retries once per rate-limit event to avoid spamming.

/** Default wait time before retrying a CodeRabbit review (30 minutes). */
export const CODERABBIT_DEFAULT_RETRY_DELAY_MS = 30 * 60 * 1000;

/**
 * Get the scheduled retry time for a CodeRabbit review on a PR.
 * Returns the ISO timestamp when we should post `@coderabbitai review`, or null if not scheduled.
 */
export function getCodeRabbitRetryTime(prNumber: number): string | null {
  const file = join(STATE_DIR, `coderabbit-retry-${prNumber}`);
  if (!existsSync(file)) return null;
  const content = readFileSync(file, 'utf-8').trim();
  return content || null;
}

/**
 * Schedule a CodeRabbit review retry at the given ISO timestamp.
 */
export function setCodeRabbitRetryTime(prNumber: number, isoTimestamp: string): void {
  writeFileSync(join(STATE_DIR, `coderabbit-retry-${prNumber}`), isoTimestamp);
}

/**
 * Clear the CodeRabbit retry state for a PR (after posting or if no longer needed).
 */
export function clearCodeRabbitRetryTime(prNumber: number): void {
  const file = join(STATE_DIR, `coderabbit-retry-${prNumber}`);
  if (existsSync(file)) {
    try { unlinkSync(file); } catch { /* best-effort */ }
  }
}

// ── Clear cooldown ──────────────────────────────────────────────────────────

export function clearProcessed(key: number | string): void {
  const file = join(STATE_DIR, `processed-${key}`);
  if (existsSync(file)) writeFileSync(file, '0');
}

// ── Main branch red-since tracking ──────────────────────────────────────────

const MAIN_RED_SINCE_FILE = join(STATE_DIR, 'main-red-since');
const MAIN_FIX_ATTEMPTS_FILE = join(STATE_DIR, 'main-fix-attempts');

export function getMainRedSince(): string | null {
  const file = MAIN_RED_SINCE_FILE;
  if (!existsSync(file)) return null;
  const content = readFileSync(file, 'utf-8').trim();
  return content || null;
}

export function setMainRedSince(timestamp: string): void {
  writeFileSync(MAIN_RED_SINCE_FILE, timestamp);
}

export function clearMainRedSince(): void {
  const file = MAIN_RED_SINCE_FILE;
  if (existsSync(file)) writeFileSync(file, '');
}

export function getMainFixAttempts(): number {
  const file = MAIN_FIX_ATTEMPTS_FILE;
  if (!existsSync(file)) return 0;
  return parseInt(readFileSync(file, 'utf-8').trim(), 10) || 0;
}

export function incrementMainFixAttempts(): number {
  const count = getMainFixAttempts() + 1;
  writeFileSync(MAIN_FIX_ATTEMPTS_FILE, String(count));
  return count;
}

export function resetMainFixAttempts(): void {
  const file = MAIN_FIX_ATTEMPTS_FILE;
  if (existsSync(file)) writeFileSync(file, '0');
}

// ── Claimed PR tracking (shared between daemon and watcher) ────────────────

const CLAIMED_PR_FILE = join(STATE_DIR, 'claimed-pr');

export function getPersistedClaimedPr(): number | null {
  if (!existsSync(CLAIMED_PR_FILE)) return null;
  const content = readFileSync(CLAIMED_PR_FILE, 'utf-8').trim();
  if (!content) return null;
  const n = parseInt(content, 10);
  return Number.isNaN(n) ? null : n;
}

export function setPersistedClaimedPr(prNum: number | null): void {
  writeFileSync(CLAIMED_PR_FILE, prNum != null ? String(prNum) : '');
}

// ── Parallel patrol state ───────────────────────────────────────────────────

export const PARALLEL_STATE_FILE = join(CACHE_DIR, 'parallel-state.json');

export interface ParallelState {
  lastHeartbeat: string;
  lastCycleAt: string;
  pid: number;
  status: 'idle' | 'dispatching' | 'sleeping';
  cycleCount: number;
  prsScanned: number;
  slotsUsed: number[];
  dispatched: number;
  fixed: number;
  errors: number;
}

export function getParallelState(): ParallelState | null {
  if (!existsSync(PARALLEL_STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(PARALLEL_STATE_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

export function setParallelState(state: ParallelState): void {
  writeFileSync(PARALLEL_STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Stuck-cycle detection (same-state consecutive cycles) ───────────────────
//
// A PR is "stuck" when the same (mergeable, rollupConclusion, blockingCommentCount)
// signal repeats for N cycles without change — even if the agent pushed new
// commits. This catches:
//   - Silent gate-blocked retries (push, CI still fails the same way)
//   - Maintainer-blocking-comment loops where patrol rebases past feedback
//   - Same CI-failure reason after supposed "fix"
//
// IMPORTANT: the fingerprint deliberately EXCLUDES headSha. Including it would
// reset the counter on every push, which is exactly the oscillation pattern we
// want to detect (push → still broken → push → still broken).

export interface PrCycleSnapshot {
  type: 'pr_cycle_snapshot';
  timestamp: string;
  pr_num: number;
  /** `${mergeable}:${rollupConclusion}:${blockingCommentCount}` — see stateFingerprint() */
  fingerprint: string;
  head_sha?: string;
  mergeable?: string;
  rollup_conclusion?: string;
  blocking_comment_count?: number;
}

/**
 * Compute the stability fingerprint for a PR's current state.
 *
 * The fingerprint is deliberately coarse so that:
 *   - Pushing new commits (new headSha) still counts as "stuck" if the
 *     mergeable / rollup / comment signal didn't change.
 *   - Tiny rollup timing variations (SUCCESS ↔ EXPECTED, PENDING ↔ null)
 *     resolve to a single bucket.
 */
export function stateFingerprint(parts: {
  mergeable?: string | null;
  rollupConclusion?: string | null;
  blockingCommentCount?: number | null;
}): string {
  const m = (parts.mergeable ?? 'UNKNOWN').toString().toUpperCase();
  const r = (parts.rollupConclusion ?? 'NONE').toString().toUpperCase();
  const c = Number.isFinite(parts.blockingCommentCount ?? NaN)
    ? Number(parts.blockingCommentCount)
    : 0;
  return `${m}:${r}:${c}`;
}

/**
 * A "healthy" fingerprint state means the PR is awaiting human approval, not
 * stuck on a problem the patrol can fix. UNKNOWN mergeable is included
 * because GitHub frequently lags the mergeability lookup; persistent UNKNOWN
 * with passing CI is more likely a stale-cache PR than a broken one. FAIL on
 * the rollup is unhealthy regardless of mergeability.
 */
export function isHealthyState(parts: {
  mergeable?: string | null;
  rollupConclusion?: string | null;
  blockingCommentCount?: number | null;
}): boolean {
  const m = (parts.mergeable ?? '').toString().toUpperCase();
  const r = (parts.rollupConclusion ?? '').toString().toUpperCase();
  const c = parts.blockingCommentCount ?? 0;
  return (m === 'MERGEABLE' || m === 'UNKNOWN') && r !== 'FAIL' && c === 0;
}

/**
 * Read the most-recent N `pr_cycle_snapshot` entries for a PR from JSONL,
 * in newest-first order. Malformed lines are skipped.
 *
 * Reads the whole file (patrol JSONL is small — thousands of lines at most
 * and rotates implicitly via patrol retention). If the file grows very large
 * in the future we can add a tail-window optimization.
 */
export function readRecentPrCycles(
  prNumber: number,
  limit = 50,
  file: string = JSONL_FILE,
): PrCycleSnapshot[] {
  if (!existsSync(file)) return [];
  const content = (() => {
    try {
      return readFileSync(file, 'utf-8');
    } catch {
      return '';
    }
  })();
  if (!content) return [];

  const out: PrCycleSnapshot[] = [];
  // Iterate lines back-to-front so we can early-exit when we hit `limit`.
  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const raw = lines[i];
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === 'object' &&
        parsed.type === 'pr_cycle_snapshot' &&
        parsed.pr_num === prNumber &&
        typeof parsed.fingerprint === 'string'
      ) {
        out.push(parsed as PrCycleSnapshot);
      }
    } catch {
      // Skip malformed lines (pre-lock corruption, partial writes, etc.)
    }
  }
  return out;
}

/**
 * Count how many of the most-recent consecutive snapshots match
 * `currentFingerprint` in newest-first order. Stops at the first mismatch.
 *
 * **Important**: this counts snapshots already persisted to the JSONL log.
 * Callers should decide whether to write the current cycle's snapshot
 * before or after invoking this — the convention used in detection.ts is:
 *   1. Call this with the current fingerprint → get `priorMatching`
 *   2. Compute `stuckCycles = priorMatching + 1` (includes current cycle)
 *   3. Persist the current snapshot
 *
 * Example returns:
 *   - 0 → no recorded cycles match the fingerprint (first occurrence)
 *   - 1 → last snapshot matches, one before it differs
 *   - 3 → last 3 snapshots match, a 4th differs (so this is the 4th stuck cycle)
 */
export function countConsecutiveCycles(
  prNumber: number,
  currentFingerprint: string,
  file: string = JSONL_FILE,
): number {
  const history = readRecentPrCycles(prNumber, 50, file);
  let n = 0;
  for (const snap of history) {
    if (snap.fingerprint === currentFingerprint) {
      n++;
    } else {
      break; // streak broken
    }
  }
  return n;
}
