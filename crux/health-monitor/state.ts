/**
 * Health Monitor — File-based state management.
 *
 * Layout under cacheDir (default ~/.cache/health-monitor/):
 *   daemon.pid               singleton lock — pid of the live daemon
 *   run.log                  written by the supervisor (not by this module)
 *   history.jsonl            append-only stream of HealthSnapshot rows
 *   state/alert-<signal>     present iff the signal is currently alerting
 *
 * The injector hook (scripts/inject-health-status.sh) reads
 * state/alert-* files and surfaces them as <system-reminder> blocks.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Alert, HealthSnapshot, SignalId } from './types.ts';

const HOME = process.env.HOME ?? '/tmp';

export function defaultCacheDir(): string {
  return join(HOME, '.cache', 'health-monitor');
}

export function ensureDirs(cacheDir: string): void {
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(join(cacheDir, 'state'), { recursive: true });
}

export function pidFilePath(cacheDir: string): string {
  return join(cacheDir, 'daemon.pid');
}

export function historyFilePath(cacheDir: string): string {
  return join(cacheDir, 'history.jsonl');
}

export function alertFilePath(cacheDir: string, signal: SignalId): string {
  return join(cacheDir, 'state', `alert-${signal}`);
}

export function writeAlert(cacheDir: string, alert: Alert): void {
  ensureDirs(cacheDir);
  writeFileSync(alertFilePath(cacheDir, alert.signal), JSON.stringify(alert, null, 2));
}

export function clearAlert(cacheDir: string, signal: SignalId): void {
  // ENOENT-safe: a concurrent process may have just unlinked it. The
  // existsSync→unlinkSync sequence is non-atomic; rely on the unlink itself
  // and swallow ENOENT. Other errors (EPERM, EISDIR) propagate.
  const f = alertFilePath(cacheDir, signal);
  try {
    unlinkSync(f);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

export function readAlert(cacheDir: string, signal: SignalId): Alert | null {
  const f = alertFilePath(cacheDir, signal);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf-8')) as Alert;
  } catch {
    return null;
  }
}

export function appendHistory(cacheDir: string, snapshot: HealthSnapshot): void {
  ensureDirs(cacheDir);
  appendFileSync(historyFilePath(cacheDir), JSON.stringify(snapshot) + '\n');
}

/** Read history rows whose `ts` is within the given window of `nowMs`. */
export function readRecentHistory(
  cacheDir: string,
  windowSeconds: number,
  nowMs = Date.now(),
): HealthSnapshot[] {
  const f = historyFilePath(cacheDir);
  if (!existsSync(f)) return [];
  const cutoffMs = nowMs - windowSeconds * 1000;
  const out: HealthSnapshot[] = [];
  for (const line of readFileSync(f, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const snap = JSON.parse(line) as HealthSnapshot;
      if (new Date(snap.ts).getTime() >= cutoffMs) out.push(snap);
    } catch {
      // Skip corrupt lines silently — the trim pass will remove them eventually.
    }
  }
  return out;
}

/**
 * Trim history older than `keepSeconds` to bound disk usage.
 *
 * Crash-safe: writes to `<file>.tmp` then atomically renames over the
 * original. A SIGKILL during the rewrite leaves either the original intact
 * or the new file fully written — never a zero-byte file. (Caught in
 * QUA-1048 review pass.)
 *
 * Concurrency caveat: if another process appends to the original file
 * between our read and the rename, that append is lost. The `runDaemon`
 * singleton makes the daemon→daemon case impossible; the daemon→`once`
 * race is documented in the command help.
 */
export function trimHistory(
  cacheDir: string,
  keepSeconds: number,
  nowMs = Date.now(),
): void {
  const f = historyFilePath(cacheDir);
  if (!existsSync(f)) return;
  const cutoffMs = nowMs - keepSeconds * 1000;
  const kept: string[] = [];
  for (const line of readFileSync(f, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const snap = JSON.parse(line) as HealthSnapshot;
      if (new Date(snap.ts).getTime() >= cutoffMs) kept.push(line);
    } catch {
      // drop corrupt
    }
  }
  const tmp = f + '.tmp';
  writeFileSync(tmp, kept.join('\n') + (kept.length > 0 ? '\n' : ''));
  renameSync(tmp, f);
}

export function writePidFile(cacheDir: string, pid: number): void {
  ensureDirs(cacheDir);
  writeFileSync(pidFilePath(cacheDir), String(pid));
}

export function readPidFile(cacheDir: string): number | null {
  const f = pidFilePath(cacheDir);
  if (!existsSync(f)) return null;
  const pid = parseInt(readFileSync(f, 'utf-8').trim(), 10);
  return Number.isNaN(pid) ? null : pid;
}

export function clearPidFile(cacheDir: string): void {
  const f = pidFilePath(cacheDir);
  if (existsSync(f)) unlinkSync(f);
}

export function pidIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
