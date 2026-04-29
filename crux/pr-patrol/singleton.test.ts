/**
 * PR Patrol — daemon singleton guard tests (QUA-835).
 *
 * Verifies that `checkSingletonDaemon()` correctly detects when another live
 * patrol process owns the PID file — the guard `runDaemon` uses to refuse
 * second invocations. Without it, parallel daemons spawn and each maintains
 * its own cycle counter (visible as cycle resets in production logs).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { spawn, type ChildProcess } from 'child_process';

import {
  acquirePidFile,
  checkSingletonDaemon,
  getDaemonPid,
} from './index.ts';

function makePidFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pr-patrol-singleton-test-'));
  return join(dir, 'daemon.pid');
}

function cleanup(file: string): void {
  try {
    rmSync(dirname(file), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * Spawn a long-lived child for "live PID" tests, return it + a cleanup
 * function that awaits the child's exit. Using `await stop()` in finally{}
 * guarantees we don't leak the child past the test, which Vitest's worker
 * pool would otherwise carry across test files.
 */
async function spawnLiveChild(): Promise<{ child: ChildProcess; pid: number; stop: () => Promise<void> }> {
  const child = spawn(process.execPath, [
    '-e',
    'setTimeout(() => {}, 60000); process.on("SIGTERM", () => process.exit(0))',
  ]);
  // Brief wait so the child has registered its SIGTERM handler before we
  // probe with `process.kill(pid, 0)` or send SIGTERM ourselves.
  await new Promise((r) => setTimeout(r, 50));
  const pid = child.pid!;
  const stop = (): Promise<void> => new Promise<void>((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    const onExit = (): void => resolve();
    child.once('exit', onExit);
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone — exit handler will fire (or we resolve via fallback)
    }
    // Fallback timeout — never block tests forever on a stuck child.
    setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve();
    }, 2000);
  });
  return { child, pid, stop };
}

describe('checkSingletonDaemon', () => {
  let file: string;

  beforeEach(() => {
    file = makePidFile();
  });
  afterEach(() => {
    cleanup(file);
  });

  it('returns { running: false } when no PID file exists', () => {
    expect(existsSync(file)).toBe(false);
    expect(checkSingletonDaemon(file)).toEqual({ running: false });
  });

  it('returns { running: false } when the PID file points at a dead process', async () => {
    // Spawn a short-lived child, capture its PID, await exit, then write
    // that (now-dead) PID. Cross-platform "definitely dead" pattern.
    const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
    const deadPid = child.pid!;
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    // Give the OS a moment to reap the PID.
    await new Promise((r) => setTimeout(r, 50));
    writeFileSync(file, String(deadPid));
    expect(checkSingletonDaemon(file)).toEqual({ running: false });
  });

  it('returns { running: false } when the PID file contains the current process pid (idempotent re-entry)', () => {
    writeFileSync(file, String(process.pid));
    expect(checkSingletonDaemon(file)).toEqual({ running: false });
  });

  it('returns { running: true, pid } when the PID file points at a different live process', async () => {
    const { pid: livePid, stop } = await spawnLiveChild();
    try {
      writeFileSync(file, String(livePid));
      expect(checkSingletonDaemon(file)).toEqual({ running: true, pid: livePid });
    } finally {
      await stop();
    }
  });

  it('returns { running: false } when the PID file is malformed', () => {
    writeFileSync(file, 'not-a-number');
    expect(checkSingletonDaemon(file)).toEqual({ running: false });
  });

  it('getDaemonPid mirrors checkSingletonDaemon for live external pids', async () => {
    const { pid: livePid, stop } = await spawnLiveChild();
    try {
      writeFileSync(file, String(livePid));
      expect(getDaemonPid(file)).toBe(livePid);
    } finally {
      await stop();
    }
  });
});

// ── acquirePidFile (atomic singleton acquisition) ──────────────────────────

describe('acquirePidFile', () => {
  let file: string;

  beforeEach(() => {
    file = makePidFile();
  });
  afterEach(() => {
    cleanup(file);
  });

  it('writes our PID and returns { ok: true } when the file does not exist', () => {
    expect(existsSync(file)).toBe(false);
    expect(acquirePidFile(file)).toEqual({ ok: true });
    expect(readFileSync(file, 'utf-8').trim()).toBe(String(process.pid));
  });

  it('replaces a stale PID file (owner is dead) and returns { ok: true }', async () => {
    // Use a definitely-dead PID by spawning + awaiting exit.
    const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
    const deadPid = child.pid!;
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    await new Promise((r) => setTimeout(r, 50));
    writeFileSync(file, String(deadPid));

    expect(acquirePidFile(file)).toEqual({ ok: true });
    expect(readFileSync(file, 'utf-8').trim()).toBe(String(process.pid));
  });

  it('returns { ok: false, existingPid } when a different live process owns the file', async () => {
    const { pid: livePid, stop } = await spawnLiveChild();
    try {
      writeFileSync(file, String(livePid));
      const result = acquirePidFile(file);
      expect(result).toEqual({ ok: false, existingPid: livePid });
      // Critical: must NOT have overwritten the file. The owner's PID stays.
      expect(readFileSync(file, 'utf-8').trim()).toBe(String(livePid));
    } finally {
      await stop();
    }
  });

  it('returns { ok: true } when the PID file already contains our pid (idempotent re-entry)', () => {
    writeFileSync(file, String(process.pid));
    expect(acquirePidFile(file)).toEqual({ ok: true });
    expect(readFileSync(file, 'utf-8').trim()).toBe(String(process.pid));
  });

  it('writes our PID over a malformed file (treated as stale)', () => {
    writeFileSync(file, 'corrupt-data-not-a-pid');
    expect(acquirePidFile(file)).toEqual({ ok: true });
    expect(readFileSync(file, 'utf-8').trim()).toBe(String(process.pid));
  });
});
