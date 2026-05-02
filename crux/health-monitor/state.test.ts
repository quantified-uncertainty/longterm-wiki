/**
 * Health Monitor — State persistence tests.
 *
 * Uses a temp directory per test to avoid touching ~/.cache.
 */

import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  alertFilePath,
  appendHistory,
  clearAlert,
  ensureDirs,
  historyFilePath,
  pidFilePath,
  readAlert,
  readPidFile,
  readRecentHistory,
  trimHistory,
  writeAlert,
  writePidFile,
} from './state.ts';
import type { Alert, HealthSnapshot } from './types.ts';

let CACHE_DIR: string;

beforeEach(() => {
  CACHE_DIR = mkdtempSync(join(tmpdir(), 'health-monitor-test-'));
});

afterEach(() => {
  rmSync(CACHE_DIR, { recursive: true, force: true });
});

const NOW = new Date('2026-05-02T12:00:00Z').getTime();

function snap(opts: {
  minutesAgo: number;
  pendingJobs: number | null;
  ageSeconds: number | null;
  serverHealthy?: boolean;
}): HealthSnapshot {
  return {
    ts: new Date(NOW - opts.minutesAgo * 60_000).toISOString(),
    pendingJobs: opts.pendingJobs,
    oldestPendingJobAgeSeconds: opts.ageSeconds,
    uptime: 1000,
    serverHealthy: opts.serverHealthy ?? true,
  };
}

describe('alert files', () => {
  it('writes and reads back an alert', () => {
    const alert: Alert = {
      signal: 'ci-stale',
      since: '2026-05-02T10:00:00Z',
      detectedAt: '2026-05-02T11:00:00Z',
      context: { ageSeconds: 9000, lastConclusion: 'failure' },
    };
    writeAlert(CACHE_DIR, alert);
    const read = readAlert(CACHE_DIR, 'ci-stale');
    expect(read).toEqual(alert);
  });

  it('returns null for a non-existent alert', () => {
    expect(readAlert(CACHE_DIR, 'jobs-stuck')).toBeNull();
  });

  it('clearAlert removes the file', () => {
    writeAlert(CACHE_DIR, {
      signal: 'jobs-stuck',
      since: '2026-05-02T10:00:00Z',
      detectedAt: '2026-05-02T11:00:00Z',
      context: {},
    });
    expect(readAlert(CACHE_DIR, 'jobs-stuck')).not.toBeNull();
    clearAlert(CACHE_DIR, 'jobs-stuck');
    expect(readAlert(CACHE_DIR, 'jobs-stuck')).toBeNull();
  });

  it('clearAlert is a no-op when the file is absent', () => {
    expect(() => clearAlert(CACHE_DIR, 'ci-stale')).not.toThrow();
  });

  it('returns null on corrupt JSON', () => {
    ensureDirs(CACHE_DIR);
    writeFileSync(alertFilePath(CACHE_DIR, 'ci-stale'), 'not-valid-json{');
    expect(readAlert(CACHE_DIR, 'ci-stale')).toBeNull();
  });
});

describe('history persistence', () => {
  it('appends and reads back snapshots within window', () => {
    const a = snap({ minutesAgo: 10, pendingJobs: 5, ageSeconds: 600 });
    const b = snap({ minutesAgo: 5, pendingJobs: 5, ageSeconds: 900 });
    appendHistory(CACHE_DIR, a);
    appendHistory(CACHE_DIR, b);

    const all = readRecentHistory(CACHE_DIR, 30 * 60, NOW);
    expect(all).toHaveLength(2);
    expect(all[0].oldestPendingJobAgeSeconds).toBe(600);
    expect(all[1].oldestPendingJobAgeSeconds).toBe(900);
  });

  it('filters out snapshots older than window', () => {
    appendHistory(CACHE_DIR, snap({ minutesAgo: 60, pendingJobs: 5, ageSeconds: 100 }));
    appendHistory(CACHE_DIR, snap({ minutesAgo: 5, pendingJobs: 5, ageSeconds: 900 }));

    const out = readRecentHistory(CACHE_DIR, 15 * 60, NOW);
    expect(out).toHaveLength(1);
    expect(out[0].oldestPendingJobAgeSeconds).toBe(900);
  });

  it('returns empty array when history file is absent', () => {
    expect(readRecentHistory(CACHE_DIR, 60, NOW)).toEqual([]);
  });

  it('skips corrupt JSON lines', () => {
    ensureDirs(CACHE_DIR);
    const f = historyFilePath(CACHE_DIR);
    const validRow = JSON.stringify(snap({ minutesAgo: 1, pendingJobs: 5, ageSeconds: 100 }));
    writeFileSync(f, `corrupt-line\n${validRow}\n{also-bad`);
    const out = readRecentHistory(CACHE_DIR, 30 * 60, NOW);
    expect(out).toHaveLength(1);
  });

  it('trimHistory removes rows older than keep window', () => {
    appendHistory(CACHE_DIR, snap({ minutesAgo: 60, pendingJobs: 5, ageSeconds: 100 }));
    appendHistory(CACHE_DIR, snap({ minutesAgo: 30, pendingJobs: 5, ageSeconds: 200 }));
    appendHistory(CACHE_DIR, snap({ minutesAgo: 5, pendingJobs: 5, ageSeconds: 900 }));

    trimHistory(CACHE_DIR, 15 * 60, NOW);
    const remaining = readFileSync(historyFilePath(CACHE_DIR), 'utf-8').trim().split('\n');
    expect(remaining).toHaveLength(1);
    expect(JSON.parse(remaining[0]).oldestPendingJobAgeSeconds).toBe(900);
  });

  it('trimHistory writes empty content when no rows are kept', () => {
    appendHistory(CACHE_DIR, snap({ minutesAgo: 60, pendingJobs: 5, ageSeconds: 100 }));
    trimHistory(CACHE_DIR, 60, NOW);     // keep last 60s — nothing should remain
    const remaining = readFileSync(historyFilePath(CACHE_DIR), 'utf-8');
    expect(remaining).toBe('');
  });
});

describe('clearAlert ENOENT-safety', () => {
  it('is a no-op when called twice in a row', () => {
    writeAlert(CACHE_DIR, {
      signal: 'ci-stale',
      since: '2026-05-02T10:00:00Z',
      detectedAt: '2026-05-02T10:00:00Z',
      context: {},
    });
    expect(() => {
      // First call deletes; second call must not throw ENOENT.
      // (Real-world: another process unlinks between our existsSync and unlink.)
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      clearAlert(CACHE_DIR, 'ci-stale');
      clearAlert(CACHE_DIR, 'ci-stale');
    }).not.toThrow();
  });
});

describe('pid file', () => {
  it('writes and reads pid', () => {
    writePidFile(CACHE_DIR, 12345);
    expect(readPidFile(CACHE_DIR)).toBe(12345);
  });

  it('returns null when pid file is absent', () => {
    expect(readPidFile(CACHE_DIR)).toBeNull();
  });

  it('returns null when pid file is malformed', () => {
    ensureDirs(CACHE_DIR);
    writeFileSync(pidFilePath(CACHE_DIR), 'not-a-number');
    expect(readPidFile(CACHE_DIR)).toBeNull();
  });
});
