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
  type WorkflowRun,
} from './audits.ts';

// ---------------------------------------------------------------------------
// evaluateWorkflowRedStreak
// ---------------------------------------------------------------------------

describe('evaluateWorkflowRedStreak', () => {
  const mk = (concs: Array<string | null>): WorkflowRun[] =>
    concs.map((c, i) => ({
      conclusion: c,
      createdAt: `2026-04-13T0${i}:00:00Z`,
      url: `https://example/run/${i}`,
    }));

  it('passes when zero failures in recent runs', () => {
    const r = evaluateWorkflowRedStreak(mk(['success', 'success', 'success', 'success', 'success']), 3);
    expect(r.status).toBe('pass');
    expect(r.failures).toBe(0);
    expect(r.totalConsidered).toBe(5);
    expect(r.message).toContain('PASS');
    expect(r.failingRuns).toBeUndefined();
  });

  it('passes when failures < threshold', () => {
    const r = evaluateWorkflowRedStreak(mk(['failure', 'success', 'failure', 'success', 'success']), 3);
    expect(r.status).toBe('pass');
    expect(r.failures).toBe(2);
    expect(r.message).toContain('PASS');
  });

  it('fails when failures === threshold', () => {
    const r = evaluateWorkflowRedStreak(mk(['failure', 'failure', 'failure', 'success', 'success']), 3);
    expect(r.status).toBe('fail');
    expect(r.failures).toBe(3);
    expect(r.message).toContain('FAIL');
    expect(r.failingRuns).toHaveLength(3);
  });

  it('fails when failures > threshold', () => {
    const r = evaluateWorkflowRedStreak(mk(['failure', 'failure', 'failure', 'failure', 'failure']), 3);
    expect(r.status).toBe('fail');
    expect(r.failures).toBe(5);
    expect(r.totalConsidered).toBe(5);
  });

  it('does NOT count cancelled / timed_out / startup_failure as failures', () => {
    // These are infra flakes, not test regressions — intentionally excluded.
    const r = evaluateWorkflowRedStreak(
      mk(['cancelled', 'timed_out', 'startup_failure', 'success', 'success']),
      3,
    );
    expect(r.failures).toBe(0);
    expect(r.status).toBe('pass');
  });

  it('does NOT count null conclusion (in-progress) as failure', () => {
    const r = evaluateWorkflowRedStreak(mk([null, null, null, 'success', 'success']), 3);
    expect(r.failures).toBe(0);
    expect(r.status).toBe('pass');
  });

  it('handles an empty run list (no data) as pass with 0/0', () => {
    // Note: the subcommand translates a fetch error into fail-closed before
    // reaching this function, so empty-array input represents "gh returned
    // no runs" (e.g., brand-new workflow), not "we couldn't fetch".
    const r = evaluateWorkflowRedStreak([], 3);
    expect(r.status).toBe('pass');
    expect(r.failures).toBe(0);
    expect(r.totalConsidered).toBe(0);
  });

  it('threshold of 1 fails on a single failure', () => {
    const r = evaluateWorkflowRedStreak(mk(['failure', 'success', 'success']), 1);
    expect(r.status).toBe('fail');
    expect(r.failures).toBe(1);
    expect(r.failingRuns).toHaveLength(1);
  });

  it('reports threshold and totals in the message', () => {
    const r = evaluateWorkflowRedStreak(mk(['failure', 'failure', 'failure']), 3);
    expect(r.message).toContain('3/3');
    expect(r.message).toContain('threshold=3');
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
