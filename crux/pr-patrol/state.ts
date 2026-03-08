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

export function isAbandoned(key: number | string): boolean {
  return getFailCount(key) >= 2;
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
