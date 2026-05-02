/**
 * Health Monitor — Signal evaluation tests.
 */

import { describe, expect, it } from 'vitest';
import { evaluateCiStale, evaluateJobsStuck } from './signals.ts';
import type { CiSnapshot, HealthSnapshot } from './types.ts';

const CI_THRESHOLD = 2 * 60 * 60; // 2h
const TREND_WINDOW = 15 * 60;     // 15min
const MIN_GROWTH = 12 * 60;       // 12min

const ciConfig = { ciStaleThresholdSeconds: CI_THRESHOLD };
const jobsConfig = {
  jobsTrendWindowSeconds: TREND_WINDOW,
  jobsTrendMinGrowthSeconds: MIN_GROWTH,
};

const NOW = new Date('2026-05-02T12:00:00Z').getTime();

function isoMinutesAgo(min: number): string {
  return new Date(NOW - min * 60_000).toISOString();
}

function snap(opts: {
  minutesAgo: number;
  pendingJobs: number | null;
  ageSeconds: number | null;
  serverHealthy?: boolean;
  fetchError?: string;
}): HealthSnapshot {
  return {
    ts: isoMinutesAgo(opts.minutesAgo),
    pendingJobs: opts.pendingJobs,
    oldestPendingJobAgeSeconds: opts.ageSeconds,
    uptime: 1000,
    serverHealthy: opts.serverHealthy ?? true,
    fetchError: opts.fetchError,
  };
}

function ciSnap(opts: Partial<CiSnapshot> & { ts?: string } = {}): CiSnapshot {
  return {
    ts: opts.ts ?? new Date(NOW).toISOString(),
    lastGreenAt: opts.lastGreenAt ?? null,
    lastConclusion: opts.lastConclusion ?? null,
    completedRunsSampled: opts.completedRunsSampled ?? 0,
    oldestSampledAt: opts.oldestSampledAt ?? null,
    fetchError: opts.fetchError,
  };
}

describe('evaluateCiStale', () => {
  it('clears the alert when last green is recent', () => {
    const ci = ciSnap({
      lastGreenAt: isoMinutesAgo(30),
      lastConclusion: 'success',
      completedRunsSampled: 5,
    });
    const res = evaluateCiStale(ci, ciConfig, NOW);
    expect(res.alert).toBeNull();
    expect(res.reason).toMatch(/under/);
  });

  it('alerts when last green is older than threshold', () => {
    const ci = ciSnap({
      lastGreenAt: isoMinutesAgo(180),
      lastConclusion: 'failure',
      completedRunsSampled: 5,
    });
    const res = evaluateCiStale(ci, ciConfig, NOW);
    expect(res.alert).not.toBeNull();
    expect(res.alert!.signal).toBe('ci-stale');
    expect(res.alert!.context).toMatchObject({
      lastConclusion: 'failure',
      thresholdSeconds: CI_THRESHOLD,
    });
    expect(res.alert!.context.ageSeconds).toBe(180 * 60);
  });

  it('exact threshold counts as stale (>= threshold)', () => {
    const ci = ciSnap({
      lastGreenAt: isoMinutesAgo(120),
      lastConclusion: 'success',
      completedRunsSampled: 5,
    });
    const res = evaluateCiStale(ci, ciConfig, NOW);
    expect(res.alert).not.toBeNull();
  });

  it('alerts when sampled window has runs but none are green (QUA-1048 review fix)', () => {
    const ci = ciSnap({
      lastGreenAt: null,
      lastConclusion: 'failure',
      completedRunsSampled: 10,
      oldestSampledAt: isoMinutesAgo(300),  // 5h old → ≥ threshold
    });
    const res = evaluateCiStale(ci, ciConfig, NOW);
    expect(res.alert).not.toBeNull();
    expect(res.alert!.context).toMatchObject({
      lastGreenAt: null,
      completedRunsSampled: 10,
      syntheticAge: true,
    });
    expect(res.alert!.context.ageSeconds).toBe(300 * 60);
    expect(res.reason).toMatch(/no green in last 10/);
  });

  it('uses the threshold as a lower bound when oldest sampled run is fresher than threshold', () => {
    const ci = ciSnap({
      lastGreenAt: null,
      lastConclusion: 'failure',
      completedRunsSampled: 10,
      oldestSampledAt: isoMinutesAgo(30),   // only 30 min old
    });
    const res = evaluateCiStale(ci, ciConfig, NOW);
    expect(res.alert).not.toBeNull();
    expect(res.alert!.context.ageSeconds).toBe(CI_THRESHOLD);
  });

  it('does NOT alert when zero completed runs sampled (quiet repo)', () => {
    const ci = ciSnap({
      lastGreenAt: null,
      lastConclusion: null,
      completedRunsSampled: 0,
    });
    const res = evaluateCiStale(ci, ciConfig, NOW);
    expect(res.alert).toBeNull();
    expect(res.reason).toMatch(/no completed runs/);
  });

  it('does not alert when fetch failed (transient API outage)', () => {
    const ci = ciSnap({
      fetchError: 'rate limit',
    });
    const res = evaluateCiStale(ci, ciConfig, NOW);
    expect(res.alert).toBeNull();
    expect(res.reason).toMatch(/ci-fetch-error/);
  });

  it('does not crash on unparseable timestamps', () => {
    const ci = ciSnap({
      lastGreenAt: 'not-a-date',
      lastConclusion: 'success',
      completedRunsSampled: 5,
    });
    const res = evaluateCiStale(ci, ciConfig, NOW);
    expect(res.alert).toBeNull();
    expect(res.reason).toMatch(/unparseable/);
  });
});

describe('evaluateJobsStuck', () => {
  it('returns null when history is empty', () => {
    const res = evaluateJobsStuck([], jobsConfig);
    expect(res.alert).toBeNull();
  });

  it('returns null when sample span is shorter than 90% of window', () => {
    // 10 minutes of samples, but window is 15
    const history = [
      snap({ minutesAgo: 10, pendingJobs: 5, ageSeconds: 700 }),
      snap({ minutesAgo: 0, pendingJobs: 5, ageSeconds: 1300 }),
    ];
    const res = evaluateJobsStuck(history, jobsConfig);
    expect(res.alert).toBeNull();
    expect(res.reason).toMatch(/only/);
  });

  it('alerts when pendingJobs > 0 throughout window and age grew enough', () => {
    // 16 min span, age went from 100s to 1100s (grew by ~17min) — clear stuck
    const history = [
      snap({ minutesAgo: 16, pendingJobs: 12, ageSeconds: 100 }),
      snap({ minutesAgo: 12, pendingJobs: 12, ageSeconds: 340 }),
      snap({ minutesAgo: 8, pendingJobs: 12, ageSeconds: 580 }),
      snap({ minutesAgo: 4, pendingJobs: 12, ageSeconds: 820 }),
      snap({ minutesAgo: 0, pendingJobs: 12, ageSeconds: 1100 }),
    ];
    const res = evaluateJobsStuck(history, jobsConfig);
    expect(res.alert).not.toBeNull();
    expect(res.alert!.signal).toBe('jobs-stuck');
    expect(res.alert!.context).toMatchObject({
      windowStartAge: 100,
      windowEndAge: 1100,
      growthSeconds: 1000,
      pendingJobsLatest: 12,
      sampleCount: 5,
    });
  });

  it('does not alert when queue drained mid-window', () => {
    const history = [
      snap({ minutesAgo: 16, pendingJobs: 12, ageSeconds: 100 }),
      snap({ minutesAgo: 8, pendingJobs: 0, ageSeconds: 0 }),  // drained!
      snap({ minutesAgo: 0, pendingJobs: 12, ageSeconds: 800 }),
    ];
    const res = evaluateJobsStuck(history, jobsConfig);
    expect(res.alert).toBeNull();
    expect(res.reason).toMatch(/drained/);
  });

  it('does not alert when growth is below minimum', () => {
    // Age grew only 100s over the window — well under 720s threshold
    const history = [
      snap({ minutesAgo: 16, pendingJobs: 5, ageSeconds: 1000 }),
      snap({ minutesAgo: 0, pendingJobs: 5, ageSeconds: 1100 }),
    ];
    const res = evaluateJobsStuck(history, jobsConfig);
    expect(res.alert).toBeNull();
    expect(res.reason).toMatch(/grew only/);
  });

  it('does not alert when oldest age is shorter than the window (fresh slow job)', () => {
    // Age grew from 0 to 800s over 16 minutes — looks like a fresh job
    // that's been running 800s, not a queue stuck for 15+ minutes
    const history = [
      snap({ minutesAgo: 16, pendingJobs: 5, ageSeconds: 0 }),
      snap({ minutesAgo: 0, pendingJobs: 5, ageSeconds: 800 }),
    ];
    const res = evaluateJobsStuck(history, jobsConfig);
    expect(res.alert).toBeNull();
    expect(res.reason).toMatch(/shorter than window/);
  });

  it('ignores samples with fetchError or unhealthy server', () => {
    const history = [
      snap({ minutesAgo: 20, pendingJobs: null, ageSeconds: null, serverHealthy: false, fetchError: 'down' }),
      snap({ minutesAgo: 16, pendingJobs: 12, ageSeconds: 100 }),
      snap({ minutesAgo: 8, pendingJobs: null, ageSeconds: null, serverHealthy: false, fetchError: 'timeout' }),
      snap({ minutesAgo: 0, pendingJobs: 12, ageSeconds: 1100 }),
    ];
    // Two usable samples spanning 16min — should still alert
    const res = evaluateJobsStuck(history, jobsConfig);
    expect(res.alert).not.toBeNull();
    expect(res.alert!.context.sampleCount).toBe(2);
  });

  it('uses the OLDEST snapshot timestamp as `since` (preserves first-detected time)', () => {
    const history = [
      snap({ minutesAgo: 20, pendingJobs: 10, ageSeconds: 500 }),
      snap({ minutesAgo: 0, pendingJobs: 10, ageSeconds: 1700 }),
    ];
    const res = evaluateJobsStuck(history, jobsConfig);
    expect(res.alert).not.toBeNull();
    expect(res.alert!.since).toBe(history[0].ts);
    expect(res.alert!.detectedAt).toBe(history[1].ts);
  });

  it('handles unsorted history correctly', () => {
    const history = [
      snap({ minutesAgo: 0, pendingJobs: 12, ageSeconds: 1100 }),
      snap({ minutesAgo: 16, pendingJobs: 12, ageSeconds: 100 }),
      snap({ minutesAgo: 8, pendingJobs: 12, ageSeconds: 580 }),
    ];
    const res = evaluateJobsStuck(history, jobsConfig);
    expect(res.alert).not.toBeNull();
    expect(res.alert!.context.windowStartAge).toBe(100);
    expect(res.alert!.context.windowEndAge).toBe(1100);
  });
});
