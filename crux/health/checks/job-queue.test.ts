/**
 * Tests for crux/health/checks/job-queue.ts
 *
 * Tests the evaluation logic that determines PASS/WARN/FAIL for job queue
 * health. Uses the pure evaluateJobStats() function to avoid mocking fetch.
 *
 * Key scenarios tested:
 *   - The exact failure scenario from issue #3692: 59% failure rate with
 *     small sample size (13 failed / 22 total) and 146 pending jobs should
 *     NOT fail CI (was failing before the fix).
 *   - High failure rate with large sample → FAIL
 *   - High failure rate with tiny sample → INFO (insufficient sample)
 *   - Moderate failure rate → WARN (not FAIL)
 *   - Large pending backlog → FAIL only above FAIL_PENDING threshold
 *   - Legacy response (no recentTotal) → backwards compatible
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateJobStats,
  MIN_SAMPLE_SIZE,
  FAIL_RATE_PCT,
  WARN_RATE_PCT,
  FAIL_PENDING,
  WARN_PENDING,
  EXCLUDED_JOB_TYPES,
  type JobStatsResponse,
} from './job-queue.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStats(overrides: {
  pending?: number;
  failed?: number;
  completed?: number;
  running?: number;
  failureRate?: number;
  recentTotal?: number;
  recentFailed?: number;
}) {
  const byStatus: Record<string, number> = {};
  if (overrides.pending != null) byStatus['pending'] = overrides.pending;
  if (overrides.failed != null) byStatus['failed'] = overrides.failed;
  if (overrides.completed != null) byStatus['completed'] = overrides.completed;
  if (overrides.running != null) byStatus['running'] = overrides.running;
  return {
    byStatus,
    failureRate: overrides.failureRate,
    recentTotal: overrides.recentTotal,
    recentFailed: overrides.recentFailed,
  };
}

// ---------------------------------------------------------------------------
// Issue #3692 regression test
// ---------------------------------------------------------------------------

describe('issue #3692: resource-ingest 59% failure + 146 pending', () => {
  it('should NOT fail CI with the actual production data that caused the outage', () => {
    // Exact scenario from the CI logs on 2026-04-02:
    // resource-ingest: 59% failure rate (13 failed), 146 pending jobs
    const data: JobStatsResponse = {
      totalJobs: 8155,
      hours: 48,
      byType: {
        'claim-sourcing': makeStats({ pending: 0, running: 0, failed: 0, failureRate: 0, recentTotal: 5, recentFailed: 0 }), // server-side job type name
        'ping': makeStats({ pending: 0, running: 0, failed: 0, failureRate: 0, recentTotal: 2, recentFailed: 0 }),
        'resource-enrich': makeStats({ pending: 0, running: 0, failed: 0, failureRate: 0, recentTotal: 3, recentFailed: 0 }),
        'resource-ingest': makeStats({
          pending: 146,
          running: 0,
          failed: 13,
          completed: 9,
          failureRate: 0.59,
          recentTotal: 22,
          recentFailed: 13,
        }),
        'resource-verify': makeStats({ pending: 0, running: 0, failed: 1506, failureRate: 0.19, recentTotal: 100, recentFailed: 19 }),
      },
    };

    const result = evaluateJobStats(data);

    // Should NOT have any failures — 59% is above WARN but below FAIL,
    // and 146 pending is above WARN but below FAIL
    expect(result.failures).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Failure rate thresholds
// ---------------------------------------------------------------------------

describe('failure rate evaluation', () => {
  it('FAIL: >80% failure rate with sufficient sample', () => {
    const data: JobStatsResponse = {
      totalJobs: 50,
      byType: {
        'resource-ingest': makeStats({
          pending: 0,
          failureRate: 0.85,
          recentTotal: 20,
          recentFailed: 17,
        }),
      },
    };

    const result = evaluateJobStats(data);
    expect(result.failures.length).toBe(1);
    expect(result.failures[0]).toMatch(/resource-ingest.*85% failure rate/);
    expect(result.detail.some(l => l.startsWith('FAIL'))).toBe(true);
  });

  it('WARN (not FAIL): 50% failure rate with sufficient sample', () => {
    const data: JobStatsResponse = {
      totalJobs: 30,
      byType: {
        'resource-ingest': makeStats({
          pending: 0,
          failureRate: 0.50,
          recentTotal: 20,
          recentFailed: 10,
        }),
      },
    };

    const result = evaluateJobStats(data);
    expect(result.failures).toEqual([]);
    expect(result.detail.some(l => l.includes('WARN'))).toBe(true);
  });

  it('INFO: high failure rate but insufficient sample', () => {
    const data: JobStatsResponse = {
      totalJobs: 5,
      byType: {
        'resource-ingest': makeStats({
          pending: 0,
          failureRate: 0.90,
          recentTotal: 5,
          recentFailed: 4,
        }),
      },
    };

    const result = evaluateJobStats(data);
    // 90% rate but only 5 samples — should not fail
    expect(result.failures).toEqual([]);
    expect(result.detail.some(l => l.includes('INFO') && l.includes('insufficient sample'))).toBe(true);
  });

  it('PASS: low failure rate', () => {
    const data: JobStatsResponse = {
      totalJobs: 100,
      byType: {
        'resource-ingest': makeStats({
          pending: 0,
          failureRate: 0.05,
          recentTotal: 100,
          recentFailed: 5,
        }),
      },
    };

    const result = evaluateJobStats(data);
    expect(result.failures).toEqual([]);
    expect(result.detail.some(l => l.startsWith('PASS'))).toBe(true);
  });

  it('FAIL threshold boundary: exactly 80% does not fail, 81% does', () => {
    const at80: JobStatsResponse = {
      totalJobs: 10,
      byType: {
        'test': makeStats({ failureRate: 0.80, recentTotal: 10, recentFailed: 8 }),
      },
    };
    const at81: JobStatsResponse = {
      totalJobs: 100,
      byType: {
        'test': makeStats({ failureRate: 0.81, recentTotal: 100, recentFailed: 81 }),
      },
    };

    expect(evaluateJobStats(at80).failures).toEqual([]);
    expect(evaluateJobStats(at81).failures.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Pending backlog thresholds
// ---------------------------------------------------------------------------

describe('pending backlog evaluation', () => {
  it('FAIL: pending > 500', () => {
    const data: JobStatsResponse = {
      totalJobs: 0,
      byType: {
        'resource-ingest': makeStats({ pending: 501, failureRate: 0 }),
      },
    };

    const result = evaluateJobStats(data);
    expect(result.failures.length).toBe(1);
    expect(result.failures[0]).toMatch(/501 pending/);
  });

  it('WARN (not FAIL): pending = 200', () => {
    const data: JobStatsResponse = {
      totalJobs: 0,
      byType: {
        'resource-ingest': makeStats({ pending: 200, failureRate: 0 }),
      },
    };

    const result = evaluateJobStats(data);
    expect(result.failures).toEqual([]);
    expect(result.detail.some(l => l.includes('WARN') && l.includes('200 pending'))).toBe(true);
  });

  it('PASS: pending = 50 (below WARN threshold)', () => {
    const data: JobStatsResponse = {
      totalJobs: 0,
      byType: {
        'resource-ingest': makeStats({ pending: 50, failureRate: 0 }),
      },
    };

    const result = evaluateJobStats(data);
    expect(result.failures).toEqual([]);
    // No WARN line for pending
    expect(result.detail.some(l => l.includes('WARN') && l.includes('pending'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Backwards compatibility
// ---------------------------------------------------------------------------

describe('backwards compatibility with older server responses', () => {
  it('works without recentTotal/recentFailed (legacy server)', () => {
    const data: JobStatsResponse = {
      totalJobs: 100,
      byType: {
        'resource-ingest': {
          byStatus: { pending: 10, completed: 80, failed: 10 },
          failureRate: 0.5,
          // No recentTotal or recentFailed
        },
      },
    };

    const result = evaluateJobStats(data);
    // Without recentTotal, assumes sufficient sample — 50% is WARN not FAIL
    expect(result.failures).toEqual([]);
    expect(result.detail.some(l => l.includes('WARN'))).toBe(true);
  });

  it('without recentTotal, very high rate still fails', () => {
    const data: JobStatsResponse = {
      totalJobs: 100,
      byType: {
        'resource-ingest': {
          byStatus: { pending: 0, completed: 10, failed: 90 },
          failureRate: 0.9,
          // No recentTotal — assumes sufficient sample
        },
      },
    };

    const result = evaluateJobStats(data);
    expect(result.failures.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Multiple job types
// ---------------------------------------------------------------------------

describe('multiple job types', () => {
  it('one type failing does not affect other types', () => {
    const data: JobStatsResponse = {
      totalJobs: 200,
      byType: {
        'ping': makeStats({ pending: 0, failureRate: 0, recentTotal: 50, recentFailed: 0 }),
        'resource-ingest': makeStats({
          pending: 0,
          failureRate: 0.95,
          recentTotal: 50,
          recentFailed: 48,
        }),
      },
    };

    const result = evaluateJobStats(data);
    expect(result.failures.length).toBe(1);
    expect(result.failures[0]).toMatch(/resource-ingest/);
    // ping should still show PASS
    expect(result.detail.some(l => l.includes('PASS') && l.includes('ping'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Excluded job types
// ---------------------------------------------------------------------------

describe('excluded job types', () => {
  it('auto-update is excluded and does not trigger failure', () => {
    const data: JobStatsResponse = {
      totalJobs: 100,
      byType: {
        'auto-update': makeStats({
          pending: 0,
          failureRate: 1.0,
          recentTotal: 50,
          recentFailed: 50,
        }),
        'ping': makeStats({ pending: 0, failureRate: 0, recentTotal: 10, recentFailed: 0 }),
      },
    };

    const result = evaluateJobStats(data);
    expect(result.failures).toEqual([]);
    expect(result.detail.some(l => l.includes('SKIP') && l.includes('auto-update'))).toBe(true);
    expect(result.detail.some(l => l.includes('PASS') && l.includes('ping'))).toBe(true);
  });

  it('EXCLUDED_JOB_TYPES contains auto-update', () => {
    expect(EXCLUDED_JOB_TYPES.has('auto-update')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('empty byType returns no failures', () => {
    const data: JobStatsResponse = { totalJobs: 0, byType: {} };
    const result = evaluateJobStats(data);
    expect(result.failures).toEqual([]);
  });

  it('missing byType field returns no failures', () => {
    const data: JobStatsResponse = { totalJobs: 0 };
    const result = evaluateJobStats(data);
    expect(result.failures).toEqual([]);
  });

  it('0% failure rate always passes', () => {
    const data: JobStatsResponse = {
      totalJobs: 0,
      byType: {
        'test': makeStats({ pending: 0, failureRate: 0, recentTotal: 100, recentFailed: 0 }),
      },
    };
    const result = evaluateJobStats(data);
    expect(result.failures).toEqual([]);
    expect(result.detail.some(l => l.startsWith('PASS'))).toBe(true);
  });
});
