/**
 * PR Patrol — State management (cooldowns, failure tracking, JSONL logging)
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
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
