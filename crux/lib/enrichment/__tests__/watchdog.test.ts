import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  computeSpendRate,
  runWatchdog,
  isRunKilled,
  type WatchdogRunSnapshot,
} from '../watchdog.ts';

describe('computeSpendRate', () => {
  it('returns $/hour from a 30-minute window', () => {
    const first = { costUsd: 0, updatedAt: '2026-04-24T00:00:00Z' };
    const last = { costUsd: 5, updatedAt: '2026-04-24T00:30:00Z' };
    const r = computeSpendRate(first, last);
    expect(r.deltaUsd).toBe(5);
    expect(r.deltaMinutes).toBe(30);
    expect(r.spendPerHour).toBe(10); // $5 / 0.5h = $10/h
    expect(r.reliable).toBe(true);
  });

  it('flags short windows as unreliable', () => {
    const first = { costUsd: 0, updatedAt: '2026-04-24T00:00:00Z' };
    const last = { costUsd: 1, updatedAt: '2026-04-24T00:01:00Z' }; // 1 min
    const r = computeSpendRate(first, last);
    expect(r.reliable).toBe(false);
    expect(r.spendPerHour).toBe(60); // rate exists; caller must ignore
  });

  it('clamps negative deltas (cost never goes down) to 0', () => {
    const first = { costUsd: 10, updatedAt: '2026-04-24T00:00:00Z' };
    const last = { costUsd: 5, updatedAt: '2026-04-24T00:30:00Z' };
    const r = computeSpendRate(first, last);
    expect(r.deltaUsd).toBe(0);
    expect(r.spendPerHour).toBe(0);
  });

  it('handles zero-duration gracefully', () => {
    const t = '2026-04-24T00:00:00Z';
    const r = computeSpendRate(
      { costUsd: 0, updatedAt: t },
      { costUsd: 5, updatedAt: t },
    );
    expect(r.deltaMinutes).toBe(0);
    expect(r.spendPerHour).toBe(0);
    expect(r.reliable).toBe(false);
  });
});

function mkSnap(
  updatedAt: string,
  costUsd: number,
): WatchdogRunSnapshot {
  return {
    runId: 'burst-test',
    costUsd,
    proposesAccepted: 0,
    proposesRejected: 0,
    updatedAt,
  };
}

describe('runWatchdog', () => {
  let killDir: string;
  afterEach(() => {
    if (killDir && existsSync(killDir)) {
      rmSync(killDir, { recursive: true, force: true });
    }
  });

  it('does not kill when the run is not found (oneshot)', async () => {
    killDir = mkdtempSync(join(tmpdir(), 'watchdog-'));
    const res = await runWatchdog({
      runId: 'does-not-exist',
      maxSpendPerHour: 20,
      windowMinutes: 30,
      pollSeconds: 5,
      oneshot: true,
      killMarkerDir: killDir,
      fetchSnapshot: async () => null,
      sleep: async () => {},
    });
    expect(res.killed).toBe(false);
    expect(res.summary).toMatch(/not found/);
  });

  it('kills when spend rate exceeds cap after ≥3 min window', async () => {
    killDir = mkdtempSync(join(tmpdir(), 'watchdog-'));
    // Two polls: $0 at t=0, $10 at t=+10min → $60/h, cap $20/h → kill.
    const snaps = [
      mkSnap('2026-04-24T00:00:00Z', 0),
      mkSnap('2026-04-24T00:10:00Z', 10),
    ];
    let idx = 0;
    const posted: Array<{ webhook: string; body: unknown }> = [];
    const res = await runWatchdog({
      runId: 'burst-test',
      maxSpendPerHour: 20,
      windowMinutes: 30,
      pollSeconds: 1,
      oneshot: false,
      killMarkerDir: killDir,
      maxIterations: 2,
      fetchSnapshot: async () => snaps[idx++] ?? null,
      sleep: async () => {},
      discordWebhook: 'https://example.com/webhook',
      discordPost: async (webhook, body) => {
        posted.push({ webhook, body });
      },
    });
    expect(res.killed).toBe(true);
    expect(res.spendPerHour).toBeCloseTo(60, 1);
    expect(res.deltaMinutes).toBeCloseTo(10, 1);
    expect(res.killMarkerPath).toBeTruthy();
    expect(isRunKilled('burst-test', killDir)).toBe(true);
    expect(posted).toHaveLength(1);
    expect((posted[0].body as { content: string }).content).toMatch(/KILL/);
  });

  it('does NOT kill when window is too short to be reliable', async () => {
    killDir = mkdtempSync(join(tmpdir(), 'watchdog-'));
    // 1-min window: $5 → would be $300/h if trusted. Reliability gate
    // requires ≥3 minutes, so the watchdog should refuse to kill.
    const snaps = [
      mkSnap('2026-04-24T00:00:00Z', 0),
      mkSnap('2026-04-24T00:01:00Z', 5),
    ];
    let idx = 0;
    const res = await runWatchdog({
      runId: 'burst-test',
      maxSpendPerHour: 20,
      windowMinutes: 30,
      pollSeconds: 1,
      oneshot: true,
      killMarkerDir: killDir,
      fetchSnapshot: async () => snaps[idx++] ?? null,
      sleep: async () => {},
    });
    expect(res.killed).toBe(false);
    expect(isRunKilled('burst-test', killDir)).toBe(false);
    expect(res.summary).toMatch(/window too short/);
  });

  it('does NOT kill when spend rate is below cap', async () => {
    killDir = mkdtempSync(join(tmpdir(), 'watchdog-'));
    // $1 over 10 min → $6/h, cap $20/h → healthy.
    const snaps = [
      mkSnap('2026-04-24T00:00:00Z', 0),
      mkSnap('2026-04-24T00:10:00Z', 1),
    ];
    let idx = 0;
    const res = await runWatchdog({
      runId: 'burst-test',
      maxSpendPerHour: 20,
      windowMinutes: 30,
      pollSeconds: 1,
      oneshot: false,
      killMarkerDir: killDir,
      maxIterations: 2,
      fetchSnapshot: async () => snaps[idx++] ?? null,
      sleep: async () => {},
    });
    // maxIterations=2 exits via the "exited after iterations" branch — but
    // crucially, no kill fired.
    expect(res.killed).toBe(false);
    expect(isRunKilled('burst-test', killDir)).toBe(false);
  });

  it('sanitizes weird run ids in the kill marker path', async () => {
    killDir = mkdtempSync(join(tmpdir(), 'watchdog-'));
    const snaps = [
      { ...mkSnap('2026-04-24T00:00:00Z', 0), runId: '../evil/../run' },
      { ...mkSnap('2026-04-24T00:10:00Z', 10), runId: '../evil/../run' },
    ];
    let idx = 0;
    const res = await runWatchdog({
      runId: '../evil/../run',
      maxSpendPerHour: 20,
      windowMinutes: 30,
      pollSeconds: 1,
      oneshot: false,
      killMarkerDir: killDir,
      maxIterations: 2,
      fetchSnapshot: async () => snaps[idx++] ?? null,
      sleep: async () => {},
    });
    expect(res.killed).toBe(true);
    expect(res.killMarkerPath).toContain(killDir);
    // Path separators were replaced with underscores; there must be no
    // parent-traversal segment remaining inside the sanitized filename.
    const markerFilename = res.killMarkerPath!.split('/').pop() ?? '';
    expect(markerFilename).not.toMatch(/\.\.(\/|\\|$)/);
    expect(markerFilename).toMatch(/^kill-[A-Za-z0-9_.-]+$/);
  });
});
