import { describe, it, expect } from 'vitest';

import {
  verifyRebaseCleared,
  tryRebaseAndVerify,
  DEFAULT_MAX_ATTEMPTS,
  type VerifyRebaseDeps,
  type RebaseVerifyResult,
} from './rebase-verify.ts';
import type {
  AutoRebaseResult,
  GqlPrNode,
  PrIssueType,
} from '../lib/pr-analysis/types.ts';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makePr(overrides: Partial<GqlPrNode> = {}): GqlPrNode {
  return {
    id: 'PR_x',
    number: 4287,
    title: 'test',
    headRefName: 'claude/test',
    headRefOid: 'f21ed7a',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    isDraft: false,
    createdAt: '2026-04-13T17:00:00Z',
    updatedAt: '2026-04-13T17:10:00Z',
    body: null,
    author: { login: 'ozziegooen' },
    labels: { nodes: [] },
    commits: { nodes: [] },
    ...overrides,
  };
}

/**
 * Build a deps object with a scripted fetchPr that returns the given sequence
 * of results in order. Also records sleep calls.
 */
function makeDeps(
  results: Array<GqlPrNode | null | Error>,
  overrides: Partial<VerifyRebaseDeps> = {},
): VerifyRebaseDeps & { fetchCalls: number; sleepCalls: number[] } {
  let fetchCalls = 0;
  const sleepCalls: number[] = [];
  return {
    fetchPr: async () => {
      const result = results[fetchCalls];
      fetchCalls++;
      if (result instanceof Error) throw result;
      return result ?? null;
    },
    sleep: async (ms: number) => {
      sleepCalls.push(ms);
    },
    delayMs: 100, // tiny delay so tests stay fast
    ...overrides,
    get fetchCalls() {
      return fetchCalls;
    },
    sleepCalls,
  };
}

// ── Cleared path ─────────────────────────────────────────────────────────────

describe('verifyRebaseCleared — cleared', () => {
  it('returns cleared=true when the first poll shows MERGEABLE', async () => {
    const deps = makeDeps([makePr({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' })]);
    const result = await verifyRebaseCleared(4287, 'foo/bar', deps);

    expect(result.cleared).toBe(true);
    expect(result.mergeable).toBe('MERGEABLE');
    expect(result.mergeStateStatus).toBe('CLEAN');
    expect(result.attempts).toBe(1);
  });

  // BEHIND / BLOCKED / UNSTABLE / HAS_HOOKS are not conflicts — they're
  // other gates (branch protection, required reviews, failing checks) and
  // should not re-trigger a conflict fix loop.
  it.each(['BEHIND', 'BLOCKED', 'UNSTABLE', 'HAS_HOOKS'])(
    'treats mergeStateStatus=%s as cleared',
    async (state) => {
      const deps = makeDeps([makePr({ mergeable: 'MERGEABLE', mergeStateStatus: state })]);
      const result = await verifyRebaseCleared(4287, 'foo/bar', deps);
      expect(result.cleared).toBe(true);
      expect(result.reason).toContain(state);
    },
  );

  it('polls past UNKNOWN and accepts the first definitive state', async () => {
    const deps = makeDeps([
      makePr({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }),
      makePr({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }),
      makePr({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }),
    ]);

    const result = await verifyRebaseCleared(4287, 'foo/bar', deps);
    expect(result.cleared).toBe(true);
    expect(result.attempts).toBe(3);
    // Only 2 sleeps — one before each retry, none before the first fetch.
    expect(deps.sleepCalls).toHaveLength(2);
  });

  it('does NOT sleep before the first fetch (happy-path latency)', async () => {
    // Regression: a fresh CLEAN PR shouldn't pay 3s of latency just to
    // discover it's already cleared. The loop only sleeps between retries.
    const deps = makeDeps([makePr({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' })]);
    await verifyRebaseCleared(4287, 'foo/bar', deps);
    expect(deps.sleepCalls).toHaveLength(0);
  });
});

// ── Not cleared ──────────────────────────────────────────────────────────────

describe('verifyRebaseCleared — still conflicting', () => {
  it('returns cleared=false when mergeable=CONFLICTING (QUA-400 regression)', async () => {
    // This is the core QUA-400 scenario: PR #4287 cycle 45 saw
    // mergeable=CONFLICTING with a new head_sha after cycle 44's rebase.
    const deps = makeDeps([
      makePr({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', headRefOid: 'f21ed7a' }),
    ]);
    const result = await verifyRebaseCleared(4287, 'foo/bar', deps);

    expect(result.cleared).toBe(false);
    expect(result.reason).toContain('still conflicting');
    expect(result.mergeable).toBe('CONFLICTING');
    expect(result.mergeStateStatus).toBe('DIRTY');
    // CONFLICTING is definitive — we stop polling immediately
    expect(result.attempts).toBe(1);
  });

  it('returns cleared=false when mergeStateStatus=DIRTY even if mergeable is not CONFLICTING', async () => {
    // Belt-and-suspenders: some GraphQL responses report these fields out
    // of sync. Treat either CONFLICTING or DIRTY as conflict.
    const deps = makeDeps([makePr({ mergeable: 'UNKNOWN', mergeStateStatus: 'DIRTY' })]);
    const result = await verifyRebaseCleared(4287, 'foo/bar', deps);
    expect(result.cleared).toBe(false);
    expect(result.reason).toContain('still conflicting');
  });

  it('gives up after max attempts when mergeable stays UNKNOWN', async () => {
    const deps = makeDeps(
      Array.from({ length: DEFAULT_MAX_ATTEMPTS }, () =>
        makePr({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }),
      ),
    );

    const result = await verifyRebaseCleared(4287, 'foo/bar', deps);
    expect(result.cleared).toBe(false);
    expect(result.reason).toContain('UNKNOWN');
    expect(result.attempts).toBe(DEFAULT_MAX_ATTEMPTS);
  });

  it('returns cleared=false when fetchPr returns null on every attempt', async () => {
    const deps = makeDeps([null, null, null, null]);
    const result = await verifyRebaseCleared(4287, 'foo/bar', deps);
    expect(result.cleared).toBe(false);
    expect(result.reason).toContain('null');
    expect(result.attempts).toBe(DEFAULT_MAX_ATTEMPTS);
  });

  it('recovers when the first fetch fails but a later one succeeds', async () => {
    const deps = makeDeps([
      new Error('API 500'),
      makePr({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }),
    ]);
    const result = await verifyRebaseCleared(4287, 'foo/bar', deps);
    expect(result.cleared).toBe(true);
    expect(result.attempts).toBe(2);
  });
});

// ── Tuning knobs ─────────────────────────────────────────────────────────────

describe('verifyRebaseCleared — config', () => {
  it('respects a custom maxAttempts=1', async () => {
    const deps = makeDeps(
      [makePr({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })],
      { maxAttempts: 1 },
    );
    const result = await verifyRebaseCleared(4287, 'foo/bar', deps);
    expect(result.cleared).toBe(false);
    expect(result.attempts).toBe(1);
  });

  it('stops polling early when a definitive state is observed', async () => {
    // If first poll says CONFLICTING, we shouldn't burn the rest of the budget.
    const deps = makeDeps([
      makePr({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }),
      makePr({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }), // should never be reached
    ]);
    const result = await verifyRebaseCleared(4287, 'foo/bar', deps);
    expect(result.cleared).toBe(false);
    expect(deps.fetchCalls).toBe(1); // definitive CONFLICTING ends the loop
  });
});

// ── tryRebaseAndVerify (orchestration) ───────────────────────────────────────

function okRebase(status: AutoRebaseResult['status'] = 'rebased'): () => AutoRebaseResult {
  return () => ({ success: true, status });
}
function failRebase(status: AutoRebaseResult['status'] = 'conflict'): () => AutoRebaseResult {
  return () => ({ success: false, status });
}
function okVerify(): () => Promise<RebaseVerifyResult> {
  return async () => ({
    cleared: true,
    reason: 'mergeable=MERGEABLE, mergeStateStatus=CLEAN',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    attempts: 1,
  });
}
function failVerify(): () => Promise<RebaseVerifyResult> {
  return async () => ({
    cleared: false,
    reason: 'PR still conflicting after rebase (mergeable=CONFLICTING, mergeStateStatus=DIRTY)',
    mergeable: 'CONFLICTING',
    mergeStateStatus: 'DIRTY',
    attempts: 1,
  });
}

describe('tryRebaseAndVerify', () => {
  it('returns rebase-failed when git rebase exits non-zero', async () => {
    const outcome = await tryRebaseAndVerify(
      'claude/test', 4287, ['conflict'], '/tmp/wt', 'foo/bar',
      { rebase: failRebase('conflict'), verify: okVerify() },
    );
    expect(outcome.kind).toBe('rebase-failed');
    if (outcome.kind === 'rebase-failed') expect(outcome.status).toBe('conflict');
  });

  it('returns verify-failed when rebase succeeds but GitHub still shows conflict (QUA-400 regression)', async () => {
    const outcome = await tryRebaseAndVerify(
      'claude/test', 4287, ['conflict'], '/tmp/wt', 'foo/bar',
      { rebase: okRebase(), verify: failVerify() },
    );
    expect(outcome.kind).toBe('verify-failed');
    if (outcome.kind === 'verify-failed') {
      expect(outcome.rebaseStatus).toBe('rebased');
      expect(outcome.verify.cleared).toBe(false);
      expect(outcome.verify.mergeable).toBe('CONFLICTING');
    }
  });

  it('returns fully-resolved when only stale/conflict issues and verify clears', async () => {
    const outcome = await tryRebaseAndVerify(
      'claude/test', 4287, ['conflict', 'stale'], '/tmp/wt', 'foo/bar',
      { rebase: okRebase(), verify: okVerify() },
    );
    expect(outcome.kind).toBe('fully-resolved');
  });

  it('returns partially-resolved when rebase clears conflict but other issues remain', async () => {
    const outcome = await tryRebaseAndVerify(
      'claude/test', 4287,
      ['conflict', 'ci-failure', 'bot-review-major'] as PrIssueType[],
      '/tmp/wt', 'foo/bar',
      { rebase: okRebase(), verify: okVerify() },
    );
    expect(outcome.kind).toBe('partially-resolved');
    if (outcome.kind === 'partially-resolved') {
      expect(outcome.remainingIssues).toEqual(['ci-failure', 'bot-review-major']);
    }
  });

  it('skips the GitHub verify call for stale-only rebases (no conflict)', async () => {
    // Stale-only rebases shouldn't pay the ~12s GitHub polling budget.
    let verifyCalls = 0;
    const outcome = await tryRebaseAndVerify(
      'claude/test', 4287, ['stale'], '/tmp/wt', 'foo/bar',
      {
        rebase: okRebase(),
        verify: async () => {
          verifyCalls++;
          return { cleared: true, reason: '', mergeable: null, mergeStateStatus: null, attempts: 0 };
        },
      },
    );
    expect(verifyCalls).toBe(0);
    expect(outcome.kind).toBe('fully-resolved');
  });

  it('short-circuits on rebase failure without calling verify', async () => {
    let verifyCalls = 0;
    await tryRebaseAndVerify(
      'claude/test', 4287, ['conflict'], '/tmp/wt', 'foo/bar',
      {
        rebase: failRebase('push-failed'),
        verify: async () => {
          verifyCalls++;
          return { cleared: true, reason: '', mergeable: null, mergeStateStatus: null, attempts: 0 };
        },
      },
    );
    expect(verifyCalls).toBe(0);
  });
});
