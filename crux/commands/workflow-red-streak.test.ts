/**
 * Tests for the workflow-red-streak audit subcommand (QUA-411 / PR #4319).
 *
 * Covers:
 * - evaluateWorkflowRedStreak: pure logic — threshold math, status-only
 *   counting (no `cancelled`/`timed_out`), empty input, all-pass, all-fail.
 * - fetchWorkflowRuns: error paths — gh missing, bad JSON, non-array,
 *   runtime throw. The happy path is covered by a stub `exec`.
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateWorkflowRedStreak,
  fetchWorkflowRuns,
  execOutput,
  DEFAULT_MAX_AGE_DAYS,
  type WorkflowRun,
} from './audits.ts';

// ---------------------------------------------------------------------------
// evaluateWorkflowRedStreak
// ---------------------------------------------------------------------------

/**
 * Fixed clock, hours after the timestamps `mk` produces, so the staleness
 * guard is inert for the threshold tests. Staleness gets its own block below.
 */
const NOW = new Date('2026-04-13T12:00:00Z');

const mk = (concs: Array<string | null>): WorkflowRun[] =>
  concs.map((c, i) => ({
    conclusion: c,
    createdAt: `2026-04-13T0${i}:00:00Z`,
    url: `https://example/run/${i}`,
  }));

describe('evaluateWorkflowRedStreak', () => {
  it('passes when zero failures in recent runs', () => {
    const r = evaluateWorkflowRedStreak(mk(['success', 'success', 'success', 'success', 'success']), 3, { now: NOW });
    expect(r.status).toBe('pass');
    expect(r.failures).toBe(0);
    expect(r.totalConsidered).toBe(5);
    expect(r.message).toContain('PASS');
    expect(r.failingRuns).toBeUndefined();
  });

  it('passes when failures < threshold', () => {
    const r = evaluateWorkflowRedStreak(mk(['failure', 'success', 'failure', 'success', 'success']), 3, { now: NOW });
    expect(r.status).toBe('pass');
    expect(r.failures).toBe(2);
    expect(r.message).toContain('PASS');
  });

  it('fails when failures === threshold', () => {
    const r = evaluateWorkflowRedStreak(mk(['failure', 'failure', 'failure', 'success', 'success']), 3, { now: NOW });
    expect(r.status).toBe('fail');
    expect(r.failures).toBe(3);
    expect(r.message).toContain('FAIL');
    expect(r.failingRuns).toHaveLength(3);
  });

  it('fails when failures > threshold', () => {
    const r = evaluateWorkflowRedStreak(mk(['failure', 'failure', 'failure', 'failure', 'failure']), 3, { now: NOW });
    expect(r.status).toBe('fail');
    expect(r.failures).toBe(5);
    expect(r.totalConsidered).toBe(5);
  });

  it('does NOT count cancelled / timed_out / startup_failure as failures', () => {
    // These are infra flakes, not test regressions — intentionally excluded.
    const r = evaluateWorkflowRedStreak(
      mk(['cancelled', 'timed_out', 'startup_failure', 'success', 'success']),
      3,
      { now: NOW },
    );
    expect(r.failures).toBe(0);
    expect(r.status).toBe('pass');
  });

  it('does NOT count null conclusion (in-progress) as failure', () => {
    const r = evaluateWorkflowRedStreak(mk([null, null, null, 'success', 'success']), 3, { now: NOW });
    expect(r.failures).toBe(0);
    expect(r.status).toBe('pass');
  });

  it('handles an empty run list (no data) as pass with 0/0', () => {
    // Note: the subcommand translates a fetch error into fail-closed before
    // reaching this function, so empty-array input represents "gh returned
    // no runs" (e.g., brand-new workflow), not "we couldn't fetch".
    const r = evaluateWorkflowRedStreak([], 3, { now: NOW });
    expect(r.status).toBe('pass');
    expect(r.failures).toBe(0);
    expect(r.totalConsidered).toBe(0);
    expect(r.newestRunAgeDays).toBeUndefined();
  });

  it('threshold of 1 fails on a single failure', () => {
    const r = evaluateWorkflowRedStreak(mk(['failure', 'success', 'success']), 1, { now: NOW });
    expect(r.status).toBe('fail');
    expect(r.failures).toBe(1);
    expect(r.failingRuns).toHaveLength(1);
  });

  it('reports threshold and totals in the message', () => {
    const r = evaluateWorkflowRedStreak(mk(['failure', 'failure', 'failure']), 3, { now: NOW });
    expect(r.message).toContain('3/3');
    expect(r.message).toContain('threshold=3');
  });
});

// ---------------------------------------------------------------------------
// Staleness guard (#4989 (c))
// ---------------------------------------------------------------------------

describe('evaluateWorkflowRedStreak — staleness guard', () => {
  /** Runs all dated `daysAgo` before NOW. */
  const aged = (concs: string[], daysAgo: number): WorkflowRun[] =>
    concs.map((c, i) => ({
      conclusion: c,
      createdAt: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString(),
      url: `https://example/run/${i}`,
    }));

  it('reproduces the e2e-post-deploy bug: an all-red window from 92 days ago is STALE, not FAIL', () => {
    // The exact shape that kept `e2e-post-deploy-red-streak` red for three
    // months while the workflow had not run at all since 2026-06-20.
    const r = evaluateWorkflowRedStreak(aged(['failure', 'failure', 'failure', 'failure'], 92), 3, { now: NOW });
    expect(r.status).toBe('stale');
    expect(r.message).toContain('STALE');
    expect(r.message).not.toContain('FAIL');
    expect(r.newestRunAgeDays).toBe(92);
    // Still surfaces the offending runs so the operator can see the window.
    expect(r.failingRuns).toHaveLength(4);
  });

  it('does not mark a fresh all-red window as stale', () => {
    const r = evaluateWorkflowRedStreak(aged(['failure', 'failure', 'failure'], 1), 3, { now: NOW });
    expect(r.status).toBe('fail');
    expect(r.newestRunAgeDays).toBe(1);
  });

  it('is inclusive at the boundary — exactly maxAgeDays old is not stale', () => {
    const r = evaluateWorkflowRedStreak(aged(['failure', 'failure', 'failure'], DEFAULT_MAX_AGE_DAYS), 3, { now: NOW });
    expect(r.status).toBe('fail');
    expect(r.newestRunAgeDays).toBe(DEFAULT_MAX_AGE_DAYS);
  });

  it('trips one day past the boundary', () => {
    const r = evaluateWorkflowRedStreak(aged(['failure', 'failure', 'failure'], DEFAULT_MAX_AGE_DAYS + 1), 3, { now: NOW });
    expect(r.status).toBe('stale');
  });

  it('maxAgeDays=0 disables the guard, restoring the old FAIL behaviour', () => {
    const r = evaluateWorkflowRedStreak(aged(['failure', 'failure', 'failure'], 400), 3, { now: NOW, maxAgeDays: 0 });
    expect(r.status).toBe('fail');
  });

  it('a stale window below threshold is STALE, not a vacuous PASS', () => {
    // "Nothing has run in months" must not read as "everything is fine".
    const r = evaluateWorkflowRedStreak(aged(['success', 'success'], 92), 3, { now: NOW });
    expect(r.status).toBe('stale');
  });

  it('uses the newest run even when the list is not sorted newest-first', () => {
    const runs: WorkflowRun[] = [
      { conclusion: 'failure', createdAt: new Date(NOW.getTime() - 90 * 86_400_000).toISOString() },
      { conclusion: 'failure', createdAt: new Date(NOW.getTime() - 1 * 86_400_000).toISOString() },
      { conclusion: 'failure', createdAt: new Date(NOW.getTime() - 60 * 86_400_000).toISOString() },
    ];
    const r = evaluateWorkflowRedStreak(runs, 3, { now: NOW });
    expect(r.status).toBe('fail');
    expect(r.newestRunAgeDays).toBe(1);
  });

  it('skips the guard when no run carries a parseable timestamp', () => {
    const runs: WorkflowRun[] = [
      { conclusion: 'failure' },
      { conclusion: 'failure', createdAt: 'not-a-date' },
      { conclusion: 'failure', createdAt: '' },
    ];
    const r = evaluateWorkflowRedStreak(runs, 3, { now: NOW });
    expect(r.status).toBe('fail');
    expect(r.newestRunAgeDays).toBeUndefined();
  });

  it('ignores unparseable timestamps but still uses the parseable ones', () => {
    const runs: WorkflowRun[] = [
      { conclusion: 'failure', createdAt: 'garbage' },
      { conclusion: 'failure', createdAt: new Date(NOW.getTime() - 92 * 86_400_000).toISOString() },
    ];
    const r = evaluateWorkflowRedStreak(runs, 2, { now: NOW });
    expect(r.status).toBe('stale');
    expect(r.newestRunAgeDays).toBe(92);
  });

  it('treats a future-dated run as fresh rather than stale', () => {
    // Clock skew on the runner must not flip the verdict.
    const runs: WorkflowRun[] = [
      { conclusion: 'failure', createdAt: new Date(NOW.getTime() + 3 * 86_400_000).toISOString() },
      { conclusion: 'failure', createdAt: new Date(NOW.getTime() - 200 * 86_400_000).toISOString() },
    ];
    const r = evaluateWorkflowRedStreak(runs, 2, { now: NOW });
    expect(r.status).toBe('fail');
    expect(r.newestRunAgeDays).toBe(-3);
  });

  it('defaults maxAgeDays to DEFAULT_MAX_AGE_DAYS when opts are omitted', () => {
    const r = evaluateWorkflowRedStreak(
      [{ conclusion: 'failure', createdAt: new Date(Date.now() - 365 * 86_400_000).toISOString() }],
      1,
    );
    expect(r.status).toBe('stale');
  });
});

// ---------------------------------------------------------------------------
// execOutput — run-auto no longer swallows a failing check's diagnosis
// ---------------------------------------------------------------------------

describe('execOutput', () => {
  it('reads a string stdout off an execSync error', () => {
    const err = Object.assign(new Error('Command failed: foo'), { stdout: '  FAIL: 4/5 runs failed  ' });
    expect(execOutput(err, 'stdout')).toBe('FAIL: 4/5 runs failed');
  });

  it('reads a Buffer stderr off an execSync error', () => {
    const err = Object.assign(new Error('boom'), { stderr: Buffer.from('gh: not authenticated\n') });
    expect(execOutput(err, 'stderr')).toBe('gh: not authenticated');
  });

  it('returns empty string when the stream is absent or the wrong type', () => {
    expect(execOutput(new Error('x'), 'stdout')).toBe('');
    expect(execOutput(Object.assign(new Error('x'), { stdout: null }), 'stdout')).toBe('');
    expect(execOutput(Object.assign(new Error('x'), { stdout: 42 }), 'stdout')).toBe('');
  });

  it('returns empty string for non-object errors', () => {
    expect(execOutput('a string error', 'stdout')).toBe('');
    expect(execOutput(null, 'stderr')).toBe('');
    expect(execOutput(undefined, 'stdout')).toBe('');
  });

  it('truncates very large output instead of flooding the report', () => {
    const err = Object.assign(new Error('x'), { stdout: 'y'.repeat(50_000) });
    const out = execOutput(err, 'stdout');
    expect(out.length).toBeLessThan(50_000);
    expect(out).toContain('(truncated)');
  });
});

// ---------------------------------------------------------------------------
// fetchWorkflowRuns
// ---------------------------------------------------------------------------

describe('fetchWorkflowRuns', () => {
  it('returns parsed runs on happy path', () => {
    const fakeExec = (() =>
      JSON.stringify([
        { conclusion: 'success', createdAt: '2026-04-13T00:00:00Z', url: 'https://x/1' },
        { conclusion: 'failure', createdAt: '2026-04-12T00:00:00Z', url: 'https://x/2' },
      ])) as unknown as typeof import('child_process').execFileSync;

    const runs = fetchWorkflowRuns('e2e-post-deploy.yml', 'owner/repo', 5, { exec: fakeExec });
    expect(runs).not.toBeNull();
    expect(runs!).toHaveLength(2);
    expect(runs![0].conclusion).toBe('success');
    expect(runs![1].conclusion).toBe('failure');
    expect(runs![1].url).toBe('https://x/2');
  });

  it('returns null when gh fails (throws)', () => {
    const fakeExec = (() => {
      throw new Error('gh: command not found');
    }) as unknown as typeof import('child_process').execFileSync;
    const runs = fetchWorkflowRuns('w.yml', 'o/r', 5, { exec: fakeExec });
    expect(runs).toBeNull();
  });

  it('returns null on unparseable JSON', () => {
    const fakeExec = (() => 'not json at all') as unknown as typeof import('child_process').execFileSync;
    const runs = fetchWorkflowRuns('w.yml', 'o/r', 5, { exec: fakeExec });
    expect(runs).toBeNull();
  });

  it('returns null on non-array JSON', () => {
    const fakeExec = (() =>
      JSON.stringify({ error: 'rate limited' })) as unknown as typeof import('child_process').execFileSync;
    const runs = fetchWorkflowRuns('w.yml', 'o/r', 5, { exec: fakeExec });
    expect(runs).toBeNull();
  });

  it('coerces malformed entries to safe shape (no throw)', () => {
    const fakeExec = (() =>
      JSON.stringify([
        { conclusion: 'success' }, // missing createdAt/url
        { conclusion: 123, url: null }, // bogus types
        {}, // empty
      ])) as unknown as typeof import('child_process').execFileSync;

    const runs = fetchWorkflowRuns('w.yml', 'o/r', 5, { exec: fakeExec });
    expect(runs).toEqual([
      { conclusion: 'success', createdAt: undefined, url: undefined },
      { conclusion: null, createdAt: undefined, url: undefined },
      { conclusion: null, createdAt: undefined, url: undefined },
    ]);
  });

  it('returns empty array when gh returns no runs', () => {
    const fakeExec = (() => '[]') as unknown as typeof import('child_process').execFileSync;
    const runs = fetchWorkflowRuns('w.yml', 'o/r', 5, { exec: fakeExec });
    expect(runs).toEqual([]);
  });
});
