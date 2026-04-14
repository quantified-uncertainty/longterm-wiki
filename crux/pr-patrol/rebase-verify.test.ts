import { describe, it, expect } from 'vitest';

import {
  verifyRebaseCleared,
  DEFAULT_MAX_ATTEMPTS,
  type VerifyRebaseDeps,
} from './rebase-verify.ts';
import type { GqlPrNode } from '../lib/pr-analysis/types.ts';

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

  it('returns cleared=true for BEHIND / BLOCKED / UNSTABLE (non-conflict gates)', async () => {
    // BEHIND / BLOCKED / UNSTABLE are not conflicts — they're other gates
    // (branch protection, required reviews, failing checks) and should not
    // make us re-trigger a conflict fix loop.
    for (const state of ['BEHIND', 'BLOCKED', 'UNSTABLE', 'HAS_HOOKS']) {
      const deps = makeDeps([makePr({ mergeable: 'MERGEABLE', mergeStateStatus: state })]);
      const result = await verifyRebaseCleared(4287, 'foo/bar', deps);
      expect(result.cleared).toBe(true);
      expect(result.reason).toContain(state);
    }
  });

  it('polls past UNKNOWN and accepts the first definitive state', async () => {
    const deps = makeDeps([
      makePr({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }),
      makePr({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }),
      makePr({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }),
    ]);

    const result = await verifyRebaseCleared(4287, 'foo/bar', deps);
    expect(result.cleared).toBe(true);
    expect(result.attempts).toBe(3);
    expect(deps.sleepCalls).toHaveLength(3); // one before each fetch
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
