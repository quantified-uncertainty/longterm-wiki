/**
 * Tests for QUA-287 Phase 3 — cross-PR dependency surfacing.
 */

import { describe, it, expect } from 'vitest';
import {
  applyDependencySurfacing,
  extractPrRefsFromText,
  extractPrReferences,
} from './dependency-surfacing.ts';
import { computeScore, HUB_BOOST } from './scoring.ts';
import type { DetectedPr, GqlPrNode } from './types.ts';

function makePrNode(overrides: Partial<GqlPrNode> = {}): GqlPrNode {
  return {
    id: 'PR_n',
    number: 1,
    title: 'Test',
    headRefName: 'claude/x',
    headRefOid: 'sha',
    mergeable: 'MERGEABLE',
    isDraft: false,
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-10T00:00:00Z',
    body: '',
    author: { login: 'u' },
    labels: { nodes: [] },
    commits: {
      nodes: [{
        commit: {
          committedDate: '2026-04-10T00:00:00Z',
          statusCheckRollup: { contexts: { nodes: [] } },
        },
      }],
    },
    reviewThreads: { nodes: [] },
    comments: { nodes: [] },
    timelineItems: { nodes: [] },
    ...overrides,
  };
}

function makeDetected(overrides: Partial<DetectedPr> = {}): DetectedPr {
  return {
    number: 1,
    title: 'Test',
    branch: 'claude/x',
    createdAt: '2026-04-01T00:00:00Z',
    issues: [],
    botComments: [],
    labels: [],
    ...overrides,
  };
}

// ── extractPrRefsFromText ────────────────────────────────────────────────────

describe('extractPrRefsFromText', () => {
  it('finds isolated #NNNN tokens', () => {
    expect(extractPrRefsFromText('depends on #4186 merging first')).toEqual([4186]);
  });

  it('returns multiple unique refs in order of first appearance', () => {
    expect(extractPrRefsFromText('#10, #20, then #10 again, and #30'))
      .toEqual([10, 20, 30]);
  });

  it('ignores tokens embedded in alphanumeric context', () => {
    // v1.2#100 is a weird token, not a PR ref
    expect(extractPrRefsFromText('version v1.2#100 rollback')).toEqual([]);
  });

  it('accepts refs at start of string', () => {
    expect(extractPrRefsFromText('#42 is the answer')).toEqual([42]);
  });

  it('returns empty for null/undefined/empty', () => {
    expect(extractPrRefsFromText(null)).toEqual([]);
    expect(extractPrRefsFromText(undefined)).toEqual([]);
    expect(extractPrRefsFromText('')).toEqual([]);
  });

  it('rejects zero and negative (regex only matches non-negative digits anyway)', () => {
    expect(extractPrRefsFromText('see #0 and #-5')).toEqual([]);
  });
});

// ── extractPrReferences ──────────────────────────────────────────────────────

describe('extractPrReferences', () => {
  it('finds body refs and validates against open PRs', () => {
    const pr = makePrNode({
      number: 100,
      body: 'Blocked on #200 and #300; also see #9999',
    });
    // #9999 is not in the open set, so it should be filtered
    const refs = extractPrReferences(pr, new Set([200, 300, 100]));
    expect(refs).toEqual([
      { pr: 200, reason: 'body-reference' },
      { pr: 300, reason: 'body-reference' },
    ]);
  });

  it('finds failing-check refs and attributes them to gate-error', () => {
    const pr = makePrNode({ number: 100, body: null });
    const refs = extractPrReferences(
      pr,
      new Set([200, 100]),
      ['ci/gate: waiting for #200 to merge'],
    );
    expect(refs).toEqual([{ pr: 200, reason: 'gate-error' }]);
  });

  it('dedupes refs across body and failing checks (first reason wins)', () => {
    const pr = makePrNode({
      number: 100,
      body: 'Blocked on #200',
    });
    const refs = extractPrReferences(
      pr,
      new Set([200, 100]),
      ['ci/gate: #200 must merge'],
    );
    // body-reference seen first, gate-error skipped as dup
    expect(refs).toEqual([{ pr: 200, reason: 'body-reference' }]);
  });

  it('skips self-reference', () => {
    const pr = makePrNode({
      number: 100,
      body: 'See #100 (this PR)',
    });
    expect(extractPrReferences(pr, new Set([100]))).toEqual([]);
  });

  it('filters merged/closed PRs (not in open set)', () => {
    const pr = makePrNode({ number: 100, body: 'Fixes #50 (already merged)' });
    expect(extractPrReferences(pr, new Set([100]))).toEqual([]);
  });
});

// ── applyDependencySurfacing ─────────────────────────────────────────────────

describe('applyDependencySurfacing', () => {
  it('populates blockedOnPrs from body references', () => {
    const nodes = [
      makePrNode({ number: 100, body: 'Blocks on #200' }),
      makePrNode({ number: 200, body: '' }),
    ];
    const detected = [makeDetected({ number: 100 }), makeDetected({ number: 200 })];
    applyDependencySurfacing(detected, nodes);
    expect(detected[0].blockedOnPrs).toEqual([
      { pr: 200, reason: 'body-reference' },
    ]);
    expect(detected[1].blockedOnPrs).toBeUndefined();
  });

  it('populates blockedOnPrs from failing-check messages', () => {
    const nodes = [
      makePrNode({ number: 100 }),
      makePrNode({ number: 200 }),
    ];
    const detected = [
      makeDetected({ number: 100, failingChecks: ['ci/gate: waiting for #200'] }),
      makeDetected({ number: 200 }),
    ];
    applyDependencySurfacing(detected, nodes);
    expect(detected[0].blockedOnPrs).toEqual([
      { pr: 200, reason: 'gate-error' },
    ]);
  });

  it('inverts timelineItems: cross-ref on Y from source X → X.blockedOnPrs += Y', () => {
    // PR 200's timeline shows "PR 100 referenced me", so 100 → 200.
    const nodes = [
      makePrNode({ number: 100 }),
      makePrNode({
        number: 200,
        timelineItems: {
          nodes: [{
            __typename: 'CrossReferencedEvent',
            source: { __typename: 'PullRequest', number: 100, state: 'OPEN' },
            createdAt: '2026-04-10T00:00:00Z',
          }],
        },
      }),
    ];
    const detected = [makeDetected({ number: 100 }), makeDetected({ number: 200 })];
    applyDependencySurfacing(detected, nodes);
    expect(detected[0].blockedOnPrs).toEqual([
      { pr: 200, reason: 'timeline-reference' },
    ]);
  });

  it('ignores CrossReferencedEvent from Issue source (only PR sources surface)', () => {
    const nodes = [
      makePrNode({
        number: 100,
        timelineItems: {
          nodes: [{
            __typename: 'CrossReferencedEvent',
            source: { __typename: 'Issue', number: 500 },
            createdAt: '2026-04-10T00:00:00Z',
          }],
        },
      }),
    ];
    const detected = [makeDetected({ number: 100 })];
    applyDependencySurfacing(detected, nodes);
    expect(detected[0].blockedOnPrs).toBeUndefined();
  });

  it('gives body/gate-error reasons precedence over timeline-reference (dedup)', () => {
    // PR 100 body mentions #200 AND timeline on 200 shows source=100.
    // Expect body-reference, not timeline-reference, because body is attached first.
    const nodes = [
      makePrNode({ number: 100, body: 'Depends on #200' }),
      makePrNode({
        number: 200,
        timelineItems: {
          nodes: [{
            __typename: 'CrossReferencedEvent',
            source: { __typename: 'PullRequest', number: 100, state: 'OPEN' },
            createdAt: '2026-04-10T00:00:00Z',
          }],
        },
      }),
    ];
    const detected = [makeDetected({ number: 100 }), makeDetected({ number: 200 })];
    applyDependencySurfacing(detected, nodes);
    expect(detected[0].blockedOnPrs).toEqual([
      { pr: 200, reason: 'body-reference' },
    ]);
  });

  it('aggregates blocksOthers across all detected PRs', () => {
    // PRs 100, 101, 102 all block on 200. 200 should have blocksOthers=3.
    const nodes = [
      makePrNode({ number: 100, body: 'See #200' }),
      makePrNode({ number: 101, body: 'Waiting for #200' }),
      makePrNode({ number: 102, body: 'Blocked on #200' }),
      makePrNode({ number: 200 }),
    ];
    const detected = [
      makeDetected({ number: 100 }),
      makeDetected({ number: 101 }),
      makeDetected({ number: 102 }),
      makeDetected({ number: 200 }),
    ];
    applyDependencySurfacing(detected, nodes);
    const pr200 = detected.find((p) => p.number === 200)!;
    expect(pr200.blocksOthers).toBe(3);
    expect(detected.find((p) => p.number === 100)!.blocksOthers).toBeUndefined();
  });

  it('no-ops cleanly on empty detected list', () => {
    expect(() => applyDependencySurfacing([], [])).not.toThrow();
  });

  it('skips refs to PRs not in the open scan (filters merged/closed)', () => {
    // PR 999 is NOT in rawNodes → should be filtered despite body reference.
    const nodes = [makePrNode({ number: 100, body: 'Fixes #999' })];
    const detected = [makeDetected({ number: 100 })];
    applyDependencySurfacing(detected, nodes);
    expect(detected[0].blockedOnPrs).toBeUndefined();
  });
});

// ── Scoring integration ──────────────────────────────────────────────────────

describe('computeScore hub boost', () => {
  it('adds HUB_BOOST to stuck PRs blocking ≥2 others', () => {
    const base: DetectedPr = makeDetected({
      number: 200,
      issues: ['stuck'],
      stuckCycles: 3,
      blocksOthers: 2,
    });
    const scoreWithHub = computeScore(base);
    const scoreWithoutHub = computeScore({ ...base, blocksOthers: undefined });
    expect(scoreWithHub - scoreWithoutHub).toBe(HUB_BOOST);
  });

  it('does not boost when stuckCycles < 3', () => {
    const pr = makeDetected({
      number: 200,
      issues: ['stuck'],
      stuckCycles: 2,
      blocksOthers: 5,
    });
    const hubless = computeScore({ ...pr, blocksOthers: undefined });
    expect(computeScore(pr)).toBe(hubless);
  });

  it('does not boost when blocksOthers < 2', () => {
    const pr = makeDetected({
      number: 200,
      issues: ['stuck'],
      stuckCycles: 5,
      blocksOthers: 1,
    });
    const hubless = computeScore({ ...pr, blocksOthers: undefined });
    expect(computeScore(pr)).toBe(hubless);
  });
});
