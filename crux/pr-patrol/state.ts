/**
 * PR Patrol — State management (cooldowns, failure tracking, JSONL logging)
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
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

// ── Pending CI verification (post-fix) ──────────────────────────────────────
// After a "fixed" outcome, we don't reset the fail counter immediately.
// Instead we mark the PR as "pending verification" and only reset when CI passes.

export function markPendingVerification(prNumber: number): void {
  writeFileSync(join(STATE_DIR, `pending-verify-${prNumber}`), new Date().toISOString());
}

export function isPendingVerification(prNumber: number): boolean {
  return existsSync(join(STATE_DIR, `pending-verify-${prNumber}`));
}

export function clearPendingVerification(prNumber: number): void {
  const file = join(STATE_DIR, `pending-verify-${prNumber}`);
  if (existsSync(file)) {
    try { unlinkSync(file); } catch { /* best-effort */ }
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
  lastCycleAt: string;
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
