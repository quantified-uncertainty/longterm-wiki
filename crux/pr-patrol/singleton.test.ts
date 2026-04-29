/**
 * PR Patrol — daemon singleton guard tests (QUA-835).
 *
 * Verifies that `checkSingletonDaemon()` correctly detects when another live
 * patrol process owns the PID file — the guard `runDaemon` uses to refuse
 * second invocations. Without it, parallel daemons spawn and each maintains
 * its own cycle counter (visible as cycle resets in production logs).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';

import { checkSingletonDaemon, getDaemonPid } from './index.ts';

function makePidFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pr-patrol-singleton-test-'));
  return join(dir, 'daemon.pid');
}

function cleanup(file: string): void {
  try {
    const dir = file.substring(0, file.lastIndexOf('/'));
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
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

  it('returns { running: false } when the PID file points at a dead process', () => {
    // Spawn a short-lived child, capture its PID, wait for exit, then write
    // that (now-dead) PID. The cross-platform "definitely dead" trick.
    const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
    const deadPid = child.pid!;
    return new Promise<void>((resolve, reject) => {
      child.on('exit', () => {
        try {
          // Tiny delay to make sure the OS has reaped the PID.
          setTimeout(() => {
            try {
              writeFileSync(file, String(deadPid));
              expect(checkSingletonDaemon(file)).toEqual({ running: false });
              resolve();
            } catch (e) {
              reject(e);
            }
          }, 50);
        } catch (e) {
          reject(e);
        }
      });
      child.on('error', reject);
    });
  });

  it('returns { running: false } when the PID file contains the current process pid (idempotent re-entry)', () => {
    writeFileSync(file, String(process.pid));
    expect(checkSingletonDaemon(file)).toEqual({ running: false });
  });

  it('returns { running: true, pid } when the PID file points at a different live process', async () => {
    // Spawn a long-running child we can probe and kill at the end.
    const child = spawn(process.execPath, [
      '-e',
      'setTimeout(() => {}, 60000); process.on("SIGTERM", () => process.exit(0))',
    ]);
    const livePid = child.pid!;
    try {
      // Wait briefly to ensure the child is ready to receive a probe.
      await new Promise((r) => setTimeout(r, 50));
      writeFileSync(file, String(livePid));
      const result = checkSingletonDaemon(file);
      expect(result).toEqual({ running: true, pid: livePid });
    } finally {
      try {
        child.kill('SIGTERM');
      } catch {
        /* best-effort */
      }
    }
  });

  it('returns { running: false } when the PID file is malformed', () => {
    writeFileSync(file, 'not-a-number');
    expect(checkSingletonDaemon(file)).toEqual({ running: false });
  });

  it('getDaemonPid mirrors checkSingletonDaemon for live external pids', async () => {
    const child = spawn(process.execPath, [
      '-e',
      'setTimeout(() => {}, 60000); process.on("SIGTERM", () => process.exit(0))',
    ]);
    const livePid = child.pid!;
    try {
      await new Promise((r) => setTimeout(r, 50));
      writeFileSync(file, String(livePid));
      expect(getDaemonPid(file)).toBe(livePid);
    } finally {
      try {
        child.kill('SIGTERM');
      } catch {
        /* best-effort */
      }
    }
  });
});
