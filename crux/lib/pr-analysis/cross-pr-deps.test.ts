/**
 * Tests for cross-PR dependency surfacing (QUA-287 Phase 3)
 */

import { describe, it, expect } from 'vitest';
import {
  extractPrRefTokens,
  validatePrRefs,
  extractCrossReferencedPrs,
  populateBlockedOnPrs,
  computeBlocksCount,
} from './cross-pr-deps.ts';
import type { DetectedPr, GqlPrNode } from './types.ts';

// ── Test helpers ─────────────────────────────────────────────────────────────

function makePrNode(overrides: Partial<GqlPrNode> = {}): GqlPrNode {
  return {
    id: 'PR_test_id',
    number: 4157,
    title: 'Test PR',
    headRefName: 'claude/test',
    headRefOid: 'abc123',
    mergeable: 'MERGEABLE',
    isDraft: false,
    createdAt: '2026-04-11T00:00:00Z',
    updatedAt: '2026-04-11T00:00:00Z',
    body: '',
    author: { login: 'testuser' },
    labels: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [] } } } }] },
    reviewThreads: { nodes: [] },
    comments: { nodes: [] },
    timelineItems: { nodes: [] },
    ...overrides,
  };
}

function makeDetected(overrides: Partial<DetectedPr> = {}): DetectedPr {
  return {
    number: 4157,
    title: 'Test PR',
    branch: 'claude/test',
    createdAt: '2026-04-11T00:00:00Z',
    issues: ['ci-failure'],
    botComments: [],
    labels: [],
    ...overrides,
  };
}

// ── extractPrRefTokens ───────────────────────────────────────────────────────

describe('extractPrRefTokens', () => {
  it('extracts #NNNN tokens from free text', () => {
    expect(extractPrRefTokens('See #4186 and #4188 for context')).toEqual([4186, 4188]);
  });

  it('returns empty for empty input', () => {
    expect(extractPrRefTokens('')).toEqual([]);
  });

  it('deduplicates repeated refs', () => {
    expect(extractPrRefTokens('#123 #123 #456 #123')).toEqual([123, 456]);
  });

  it('handles tokens at string start', () => {
    expect(extractPrRefTokens('#4186 is the baseline')).toEqual([4186]);
  });

  it('handles tokens at string end with trailing punctuation', () => {
    expect(extractPrRefTokens('depends on #4186.')).toEqual([4186]);
    expect(extractPrRefTokens('see #4186!')).toEqual([4186]);
    expect(extractPrRefTokens('ref: #4186;')).toEqual([4186]);
  });

  it('does NOT extract numbers inside identifiers (e.g. hex, code)', () => {
    // `abc#123` should not match because `#` isn't preceded by whitespace/start
    expect(extractPrRefTokens('commit abc#123')).toEqual([]);
    // Numbers without `#` don't match
    expect(extractPrRefTokens('PR 4186 is broken')).toEqual([]);
  });

  it('caps digit count at 6 to avoid false positives on hashes', () => {
    // 7+ digits should not match
    expect(extractPrRefTokens('#12345678')).toEqual([]);
    // 6 digits still matches
    expect(extractPrRefTokens('#123456')).toEqual([123456]);
  });

  it('handles multi-line text', () => {
    const text = 'Fails because of:\n- #4186 baseline\n- #4188 related';
    expect(extractPrRefTokens(text).sort()).toEqual([4186, 4188]);
  });

  it('ignores leading zero only refs (numerically 0)', () => {
    expect(extractPrRefTokens('#0')).toEqual([]);
  });
});

// ── validatePrRefs ───────────────────────────────────────────────────────────

describe('validatePrRefs', () => {
  it('filters to only open PR numbers', () => {
    const open = new Set([4186, 4188, 4200]);
    expect(validatePrRefs([4186, 4187, 4188, 9999], open, 4157)).toEqual([4186, 4188]);
  });

  it('excludes self', () => {
    const open = new Set([4157, 4186]);
    expect(validatePrRefs([4157, 4186], open, 4157)).toEqual([4186]);
  });

  it('deduplicates', () => {
    const open = new Set([4186]);
    expect(validatePrRefs([4186, 4186, 4186], open, 4157)).toEqual([4186]);
  });

  it('returns empty when no candidates match open list', () => {
    const open = new Set([100, 200]);
    expect(validatePrRefs([123, 456], open, 999)).toEqual([]);
  });

  it('preserves order from candidates', () => {
    const open = new Set([100, 200, 300]);
    expect(validatePrRefs([300, 100, 200], open, 1)).toEqual([300, 100, 200]);
  });
});

// ── extractCrossReferencedPrs ────────────────────────────────────────────────

describe('extractCrossReferencedPrs', () => {
  it('extracts PR numbers from CrossReferencedEvent timeline items', () => {
    const pr = makePrNode({
      number: 4157,
      timelineItems: {
        nodes: [
          {
            __typename: 'CrossReferencedEvent',
            source: { __typename: 'PullRequest', number: 4186, state: 'OPEN' },
          },
          {
            __typename: 'CrossReferencedEvent',
            source: { __typename: 'PullRequest', number: 4188, state: 'OPEN' },
          },
        ],
      },
    });
    expect(extractCrossReferencedPrs(pr).sort()).toEqual([4186, 4188]);
  });

  it('skips Issue sources', () => {
    const pr = makePrNode({
      timelineItems: {
        nodes: [
          {
            __typename: 'CrossReferencedEvent',
            source: { __typename: 'Issue', number: 999 },
          },
          {
            __typename: 'CrossReferencedEvent',
            source: { __typename: 'PullRequest', number: 4186, state: 'OPEN' },
          },
        ],
      },
    });
    expect(extractCrossReferencedPrs(pr)).toEqual([4186]);
  });

  it('skips closed/merged PR sources', () => {
    const pr = makePrNode({
      timelineItems: {
        nodes: [
          {
            __typename: 'CrossReferencedEvent',
            source: { __typename: 'PullRequest', number: 4100, state: 'MERGED' },
          },
          {
            __typename: 'CrossReferencedEvent',
            source: { __typename: 'PullRequest', number: 4110, state: 'CLOSED' },
          },
          {
            __typename: 'CrossReferencedEvent',
            source: { __typename: 'PullRequest', number: 4186, state: 'OPEN' },
          },
        ],
      },
    });
    expect(extractCrossReferencedPrs(pr)).toEqual([4186]);
  });

  it('excludes self-references', () => {
    const pr = makePrNode({
      number: 4157,
      timelineItems: {
        nodes: [
          {
            __typename: 'CrossReferencedEvent',
            source: { __typename: 'PullRequest', number: 4157, state: 'OPEN' },
          },
        ],
      },
    });
    expect(extractCrossReferencedPrs(pr)).toEqual([]);
  });

  it('returns empty when timelineItems missing', () => {
    const pr = makePrNode({ timelineItems: undefined });
    expect(extractCrossReferencedPrs(pr)).toEqual([]);
  });

  it('accepts events with missing state (open-list validation handles it downstream)', () => {
    const pr = makePrNode({
      timelineItems: {
        nodes: [
          {
            __typename: 'CrossReferencedEvent',
            source: { __typename: 'PullRequest', number: 4186 }, // no state
          },
        ],
      },
    });
    expect(extractCrossReferencedPrs(pr)).toEqual([4186]);
  });
});

// ── populateBlockedOnPrs — integration ───────────────────────────────────────

describe('populateBlockedOnPrs', () => {
  it('populates blockedOnPrs from cross-reference events (#4157/#4188 fixture)', () => {
    // Fixture: PR #4157 has a CrossReferencedEvent from PR #4188
    const node4157 = makePrNode({
      number: 4157,
      timelineItems: {
        nodes: [
          {
            __typename: 'CrossReferencedEvent',
            source: { __typename: 'PullRequest', number: 4188, state: 'OPEN' },
          },
        ],
      },
    });
    const node4188 = makePrNode({ number: 4188, headRefName: 'claude/feature-b' });

    const detected: DetectedPr[] = [makeDetected({ number: 4157 })];
    populateBlockedOnPrs(detected, [node4157, node4188]);

    expect(detected[0].blockedOnPrs).toEqual([
      { pr: 4188, reason: 'cross-referenced' },
    ]);
  });

  it('scans failing check names for #NNNN tokens', () => {
    const openPr = makePrNode({ number: 4186 });
    const selfNode = makePrNode({ number: 4157 });
    const detected: DetectedPr[] = [
      makeDetected({
        number: 4157,
        failingChecks: ['gate: conflicts with #4186'],
      }),
    ];
    populateBlockedOnPrs(detected, [selfNode, openPr]);
    expect(detected[0].blockedOnPrs).toEqual([
      { pr: 4186, reason: 'gate error' },
    ]);
  });

  it('scans bot-comment bodies for #NNNN tokens', () => {
    const openPr = makePrNode({ number: 4188 });
    const selfNode = makePrNode({ number: 4157 });
    const detected: DetectedPr[] = [
      makeDetected({
        number: 4157,
        botComments: [
          {
            threadId: 't1',
            path: 'x.ts',
            line: 1,
            startLine: null,
            body: 'See #4188 for the baseline changes this needs to follow.',
            author: 'coderabbitai',
          },
        ],
      }),
    ];
    populateBlockedOnPrs(detected, [selfNode, openPr]);
    expect(detected[0].blockedOnPrs).toEqual([
      { pr: 4188, reason: 'bot comment' },
    ]);
  });

  it('validates #NNNN against open-PR list (skips closed refs)', () => {
    const selfNode = makePrNode({ number: 4157 });
    const openPr = makePrNode({ number: 4186 });
    const detected: DetectedPr[] = [
      makeDetected({
        number: 4157,
        failingChecks: ['conflicts with #4186 and #9999'], // 9999 not open
      }),
    ];
    populateBlockedOnPrs(detected, [selfNode, openPr]);
    // Only #4186 survives validation
    expect(detected[0].blockedOnPrs).toEqual([{ pr: 4186, reason: 'gate error' }]);
  });

  it('cross-reference reason takes precedence over text-scrape reason', () => {
    const selfNode = makePrNode({
      number: 4157,
      timelineItems: {
        nodes: [
          {
            __typename: 'CrossReferencedEvent',
            source: { __typename: 'PullRequest', number: 4186, state: 'OPEN' },
          },
        ],
      },
    });
    const openPr = makePrNode({ number: 4186 });
    const detected: DetectedPr[] = [
      makeDetected({
        number: 4157,
        failingChecks: ['#4186 gate error'], // also mentioned in failing check
      }),
    ];
    populateBlockedOnPrs(detected, [selfNode, openPr]);
    // cross-referenced wins (first-to-populate)
    expect(detected[0].blockedOnPrs).toEqual([
      { pr: 4186, reason: 'cross-referenced' },
    ]);
  });

  it('leaves blockedOnPrs undefined when no refs found', () => {
    const detected: DetectedPr[] = [makeDetected({ number: 4157 })];
    populateBlockedOnPrs(detected, [makePrNode({ number: 4157 })]);
    expect(detected[0].blockedOnPrs).toBeUndefined();
  });

  it('sorts blockedOnPrs by PR number ascending', () => {
    const selfNode = makePrNode({ number: 4157 });
    const detected: DetectedPr[] = [
      makeDetected({
        number: 4157,
        failingChecks: ['refs #4300 #4100 #4200'],
      }),
    ];
    const opens = [4100, 4200, 4300].map((n) => makePrNode({ number: n }));
    populateBlockedOnPrs(detected, [selfNode, ...opens]);
    expect(detected[0].blockedOnPrs?.map((b) => b.pr)).toEqual([4100, 4200, 4300]);
  });
});

// ── computeBlocksCount ───────────────────────────────────────────────────────

describe('computeBlocksCount', () => {
  it('counts how many PRs each dependency blocks', () => {
    const detected: DetectedPr[] = [
      makeDetected({
        number: 1,
        blockedOnPrs: [{ pr: 100, reason: 'cross-referenced' }],
      }),
      makeDetected({
        number: 2,
        blockedOnPrs: [{ pr: 100, reason: 'gate error' }],
      }),
      makeDetected({
        number: 3,
        blockedOnPrs: [{ pr: 200, reason: 'cross-referenced' }],
      }),
    ];
    const counts = computeBlocksCount(detected);
    expect(counts.get(100)).toBe(2);
    expect(counts.get(200)).toBe(1);
    expect(counts.get(999)).toBeUndefined();
  });

  it('returns empty map when no blockedOnPrs present', () => {
    const detected: DetectedPr[] = [makeDetected({ number: 1 })];
    expect(computeBlocksCount(detected).size).toBe(0);
  });
});
