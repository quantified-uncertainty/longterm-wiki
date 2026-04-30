/**
 * PR Patrol — daemon singleton acquisition tests.
 *
 * Verifies `acquirePidFile()`'s atomic claim semantics (the production code
 * path used by `runDaemon`) plus the underlying `getDaemonPid()` reader.
 * Without these, two `pr-patrol run` invocations spawn parallel loops with
 * independent cycle counters (the QUA-835 production symptom).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { spawn, type ChildProcess } from 'child_process';

import { acquirePidFile, getDaemonPid } from './index.ts';

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
 * Spawn a long-lived child for "live PID" tests. Returns the child + a
 * cleanup function that awaits the child's exit. Awaiting the exit (rather
 * than fire-and-forget) prevents leaking child processes into Vitest's
 * worker pool. The fallback timer is `.unref()`'d so it doesn't pin the
 * event loop past the test.
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
    let fallback: NodeJS.Timeout | undefined;
    const onExit = (): void => {
      if (fallback) clearTimeout(fallback);
      resolve();
    };
    child.once('exit', onExit);
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone — exit handler will fire (or fallback resolves)
    }
    // Escalate to SIGKILL if SIGTERM doesn't take. unref() so a stuck child
    // can never pin the event loop past test completion.
    fallback = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      child.removeListener('exit', onExit);
      resolve();
    }, 2000);
    fallback.unref?.();
  });
  return { child, pid, stop };
}

// ── getDaemonPid (read-only liveness probe) ────────────────────────────────

describe('getDaemonPid', () => {
  let file: string;

  beforeEach(() => {
    file = makePidFile();
  });
  afterEach(() => {
    cleanup(file);
  });

  it('returns null when no PID file exists', () => {
    expect(existsSync(file)).toBe(false);
    expect(getDaemonPid(file)).toBeNull();
  });

  it('returns null when the PID file points at a dead process', async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
    const deadPid = child.pid!;
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    writeFileSync(file, String(deadPid));
    expect(getDaemonPid(file)).toBeNull();
  });

  it('returns the current process pid when the file contains it (self-reference)', () => {
    writeFileSync(file, String(process.pid));
    expect(getDaemonPid(file)).toBe(process.pid);
  });

  it('returns the live PID when a different process owns the file', async () => {
    const { pid: livePid, stop } = await spawnLiveChild();
    try {
      writeFileSync(file, String(livePid));
      expect(getDaemonPid(file)).toBe(livePid);
    } finally {
      await stop();
    }
  });

  it('returns null when the PID file is malformed', () => {
    writeFileSync(file, 'not-a-number');
    expect(getDaemonPid(file)).toBeNull();
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

  it('replaces a stale PID file (owner is dead) and writes our pid', async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
    const deadPid = child.pid!;
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    writeFileSync(file, String(deadPid));

    expect(acquirePidFile(file)).toEqual({ ok: true });
    expect(readFileSync(file, 'utf-8').trim()).toBe(String(process.pid));
  });

  it('refuses with { ok: false, existingPid } when a different live process owns the file', async () => {
    const { pid: livePid, stop } = await spawnLiveChild();
    try {
      writeFileSync(file, String(livePid));
      expect(acquirePidFile(file)).toEqual({ ok: false, existingPid: livePid });
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
