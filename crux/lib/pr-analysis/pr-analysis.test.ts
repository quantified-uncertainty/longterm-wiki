/**
 * Tests for crux/lib/pr-analysis/ — general-purpose PR analysis library
 *
 * Tests the extracted pure functions that were previously in crux/pr-patrol/.
 * These tests import directly from the library, not from the PR Patrol re-exports.
 */

import { describe, it, expect } from 'vitest';
import {
  detectIssues,
  extractBotComments,
  checkMergeEligibility,
  findMergeCandidates,
  computeScore,
  rankPrs,
  ISSUE_SCORES,
  HUMAN_REQUIRED_CHECKS,
} from './index.ts';
import type { GqlPrNode, DetectedPr } from './types.ts';

// ── Test helpers ─────────────────────────────────────────────────────────────

function makePrNode(overrides: Partial<GqlPrNode> = {}): GqlPrNode {
  return {
    id: 'PR_test_id',
    number: 1,
    title: 'Test PR',
    headRefName: 'claude/test',
    headRefOid: 'abc123def456',
    mergeable: 'MERGEABLE',
    isDraft: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-03-05T00:00:00Z',
    body: '## Summary\n\n- [x] Task done\n\n## Test plan\n\n- [x] Tests pass\n\nCloses #1',
    author: { login: 'testuser' },
    labels: { nodes: [{ name: 'stage:approved' }] },
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              contexts: {
                nodes: [{ conclusion: 'SUCCESS' }],
              },
            },
          },
        },
      ],
    },
    reviewThreads: { nodes: [] },
    ...overrides,
  };
}

function makeDetectedPr(overrides: Partial<DetectedPr> = {}): DetectedPr {
  return {
    number: 1,
    title: 'Test PR',
    branch: 'claude/test',
    createdAt: new Date().toISOString(),
    issues: [],
    botComments: [],
    labels: [],
    ...overrides,
  };
}

// ── extractBotComments ───────────────────────────────────────────────────────

describe('extractBotComments (lib)', () => {
  it('extracts unresolved bot comments', () => {
    const pr = makePrNode({
      reviewThreads: {
        nodes: [{
          id: 'thread-1',
          isResolved: false,
          isOutdated: false,
          path: 'src/foo.ts',
          line: 10,
          startLine: null,
          comments: {
            nodes: [{ author: { login: 'coderabbitai' }, body: '🟠 Major: Fix this' }],
          },
        }],
      },
    });
    const comments = extractBotComments(pr);
    expect(comments).toHaveLength(1);
    expect(comments[0].path).toBe('src/foo.ts');
    expect(comments[0].author).toBe('coderabbitai');
  });

  it('skips resolved and outdated threads', () => {
    const pr = makePrNode({
      reviewThreads: {
        nodes: [
          {
            id: 'resolved',
            isResolved: true,
            isOutdated: false,
            path: 'a.ts',
            line: 1,
            startLine: null,
            comments: { nodes: [{ author: { login: 'coderabbitai' }, body: 'fix' }] },
          },
          {
            id: 'outdated',
            isResolved: false,
            isOutdated: true,
            path: 'b.ts',
            line: 2,
            startLine: null,
            comments: { nodes: [{ author: { login: 'coderabbitai' }, body: 'fix' }] },
          },
        ],
      },
    });
    expect(extractBotComments(pr)).toHaveLength(0);
  });
});

// ── detectIssues ─────────────────────────────────────────────────────────────

describe('detectIssues (lib)', () => {
  it('detects conflict', () => {
    const pr = makePrNode({ mergeable: 'CONFLICTING' });
    const { issues } = detectIssues(pr, 0);
    expect(issues).toContain('conflict');
  });

  it('detects ci-failure from CheckRun conclusion', () => {
    const pr = makePrNode({
      commits: {
        nodes: [{
          commit: {
            statusCheckRollup: {
              contexts: { nodes: [{ conclusion: 'FAILURE' }] },
            },
          },
        }],
      },
    });
    const { issues } = detectIssues(pr, 0);
    expect(issues).toContain('ci-failure');
  });

  it('detects missing-testplan', () => {
    const pr = makePrNode({ body: 'No test plan here\nCloses #1' });
    const { issues } = detectIssues(pr, 0);
    expect(issues).toContain('missing-testplan');
  });

  it('detects missing-issue-ref', () => {
    const pr = makePrNode({ body: '## Test plan\n- [x] done' });
    const { issues } = detectIssues(pr, 0);
    expect(issues).toContain('missing-issue-ref');
  });

  it('detects clean PR with no issues', () => {
    const pr = makePrNode();
    const { issues } = detectIssues(pr, 0);
    expect(issues).toEqual([]);
  });

  it('skips ci-failure when only human-required checks are failing', () => {
    const pr = makePrNode({
      commits: {
        nodes: [{
          commit: {
            statusCheckRollup: {
              contexts: {
                nodes: [
                  { name: 'check-protected-paths', conclusion: 'FAILURE' },
                  { name: 'build', conclusion: 'SUCCESS' },
                ],
              },
            },
          },
        }],
      },
    });
    const { issues } = detectIssues(pr, 0);
    expect(issues).not.toContain('ci-failure');
  });

  it('still reports ci-failure when human-required AND other checks fail', () => {
    const pr = makePrNode({
      commits: {
        nodes: [{
          commit: {
            statusCheckRollup: {
              contexts: {
                nodes: [
                  { name: 'check-protected-paths', conclusion: 'FAILURE' },
                  { name: 'build', conclusion: 'FAILURE' },
                ],
              },
            },
          },
        }],
      },
    });
    const { issues } = detectIssues(pr, 0);
    expect(issues).toContain('ci-failure');
  });

  it('still reports ci-failure for non-human-required failing checks', () => {
    const pr = makePrNode({
      commits: {
        nodes: [{
          commit: {
            statusCheckRollup: {
              contexts: {
                nodes: [
                  { name: 'build', conclusion: 'FAILURE' },
                ],
              },
            },
          },
        }],
      },
    });
    const { issues } = detectIssues(pr, 0);
    expect(issues).toContain('ci-failure');
  });

  it('handles StatusContext failures with human-required context name', () => {
    const pr = makePrNode({
      commits: {
        nodes: [{
          commit: {
            statusCheckRollup: {
              contexts: {
                nodes: [
                  { context: 'check-protected-paths', state: 'FAILURE' },
                ],
              },
            },
          },
        }],
      },
    });
    const { issues } = detectIssues(pr, 0);
    expect(issues).not.toContain('ci-failure');
  });

  it('reports ci-failure for checks with no name (unknown checks)', () => {
    const pr = makePrNode({
      commits: {
        nodes: [{
          commit: {
            statusCheckRollup: {
              contexts: {
                nodes: [
                  { conclusion: 'FAILURE' },  // no name or context
                ],
              },
            },
          },
        }],
      },
    });
    const { issues } = detectIssues(pr, 0);
    expect(issues).toContain('ci-failure');
  });
});

// ── HUMAN_REQUIRED_CHECKS ────────────────────────────────────────────────────

describe('HUMAN_REQUIRED_CHECKS', () => {
  it('contains check-protected-paths', () => {
    expect(HUMAN_REQUIRED_CHECKS.has('check-protected-paths')).toBe(true);
  });
});

// ── checkMergeEligibility ────────────────────────────────────────────────────

describe('checkMergeEligibility (lib)', () => {
  it('eligible when all checks pass', () => {
    const pr = makePrNode();
    const result = checkMergeEligibility(pr);
    expect(result.eligible).toBe(true);
    expect(result.blockReasons).toEqual([]);
  });

  it('blocks draft PRs', () => {
    const pr = makePrNode({ isDraft: true });
    const result = checkMergeEligibility(pr);
    expect(result.eligible).toBe(false);
    expect(result.blockReasons).toContain('is-draft');
  });

  it('blocks non-mergeable PRs', () => {
    const pr = makePrNode({ mergeable: 'CONFLICTING' });
    const result = checkMergeEligibility(pr);
    expect(result.blockReasons).toContain('not-mergeable');
  });

  it('blocks PRs with agent-working label', () => {
    const pr = makePrNode({
      labels: { nodes: [{ name: 'stage:approved' }, { name: 'agent:working' }] },
    });
    const result = checkMergeEligibility(pr);
    expect(result.blockReasons).toContain('agent-working');
  });

  it('blocks PRs with pr-patrol:working label', () => {
    const pr = makePrNode({
      labels: { nodes: [{ name: 'stage:approved' }, { name: 'pr-patrol:working' }] },
    });
    const result = checkMergeEligibility(pr);
    expect(result.blockReasons).toContain('pr-patrol-working');
  });

  it('blocks PRs with CI failures', () => {
    const pr = makePrNode({
      commits: {
        nodes: [{
          commit: {
            statusCheckRollup: {
              contexts: { nodes: [{ conclusion: 'FAILURE' }] },
            },
          },
        }],
      },
    });
    const result = checkMergeEligibility(pr);
    expect(result.blockReasons).toContain('ci-failing');
  });

  it('blocks PRs with pending CI', () => {
    const pr = makePrNode({
      commits: {
        nodes: [{
          commit: {
            statusCheckRollup: {
              contexts: { nodes: [{ conclusion: null, state: 'PENDING' }] },
            },
          },
        }],
      },
    });
    const result = checkMergeEligibility(pr);
    expect(result.blockReasons).toContain('ci-pending');
  });

  it('blocks PRs with unresolved threads', () => {
    const pr = makePrNode({
      reviewThreads: {
        nodes: [{
          id: 't1',
          isResolved: false,
          isOutdated: false,
          path: 'a.ts',
          line: 1,
          startLine: null,
          comments: { nodes: [{ author: { login: 'user' }, body: 'fix' }] },
        }],
      },
    });
    const result = checkMergeEligibility(pr);
    expect(result.blockReasons).toContain('unresolved-threads');
  });

  it('blocks PRs with unchecked items in body', () => {
    const pr = makePrNode({
      body: '## Test plan\n- [ ] Todo item\nCloses #1',
    });
    const result = checkMergeEligibility(pr);
    expect(result.blockReasons).toContain('unchecked-items');
  });

  it('blocks PRs with stage:merging label (in merge queue)', () => {
    const pr = makePrNode({
      labels: { nodes: [{ name: 'stage:approved' }, { name: 'stage:merging' }] },
    });
    const result = checkMergeEligibility(pr);
    expect(result.eligible).toBe(false);
    expect(result.blockReasons).toContain('in-merge-queue');
  });

  it('includes nodeId in MergeCandidate', () => {
    const pr = makePrNode({ id: 'PR_kwDON_test' });
    const result = checkMergeEligibility(pr);
    expect(result.nodeId).toBe('PR_kwDON_test');
  });
});

// ── findMergeCandidates ──────────────────────────────────────────────────────

describe('findMergeCandidates (lib)', () => {
  it('only includes PRs with stage:approved label', () => {
    const prs = [
      makePrNode({ number: 1, labels: { nodes: [{ name: 'stage:approved' }] } }),
      makePrNode({ number: 2, labels: { nodes: [{ name: 'other' }] } }),
    ];
    const candidates = findMergeCandidates(prs);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].number).toBe(1);
  });

  it('sorts by creation date (oldest first)', () => {
    const prs = [
      makePrNode({ number: 1, createdAt: '2026-03-05T00:00:00Z' }),
      makePrNode({ number: 2, createdAt: '2026-01-01T00:00:00Z' }),
    ];
    const candidates = findMergeCandidates(prs);
    expect(candidates[0].number).toBe(2);
    expect(candidates[1].number).toBe(1);
  });
});

// ── computeScore ─────────────────────────────────────────────────────────────

describe('computeScore (lib)', () => {
  it('returns 0 for PR with no issues and zero age', () => {
    const pr = makeDetectedPr({ createdAt: new Date().toISOString() });
    expect(computeScore(pr)).toBe(0);
  });

  it('sums issue scores correctly', () => {
    const pr = makeDetectedPr({ issues: ['conflict', 'ci-failure'] });
    const score = computeScore(pr);
    expect(score).toBeGreaterThanOrEqual(180);
  });

  it('caps age bonus at 50', () => {
    const hundredHoursAgo = new Date(Date.now() - 100 * 3600 * 1000).toISOString();
    const pr = makeDetectedPr({ createdAt: hundredHoursAgo });
    expect(computeScore(pr)).toBe(50);
  });
});

// ── rankPrs ──────────────────────────────────────────────────────────────────

describe('rankPrs (lib)', () => {
  it('sorts by score descending', () => {
    const prs = [
      makeDetectedPr({ number: 1, issues: ['missing-testplan'] }),
      makeDetectedPr({ number: 2, issues: ['conflict'] }),
      makeDetectedPr({ number: 3, issues: ['ci-failure'] }),
    ];
    const ranked = rankPrs(prs);
    expect(ranked[0].number).toBe(2);
    expect(ranked[1].number).toBe(3);
    expect(ranked[2].number).toBe(1);
  });

  it('returns empty array for empty input', () => {
    expect(rankPrs([])).toEqual([]);
  });
});

// ── ISSUE_SCORES ─────────────────────────────────────────────────────────────

describe('ISSUE_SCORES (lib)', () => {
  it('has scores for all issue types', () => {
    const expectedTypes = [
      'conflict', 'ci-failure', 'bot-review-major',
      'missing-issue-ref', 'stale', 'missing-testplan', 'bot-review-nitpick',
    ];
    for (const t of expectedTypes) {
      expect(ISSUE_SCORES[t as keyof typeof ISSUE_SCORES]).toBeGreaterThan(0);
    }
  });

  it('conflict has highest score', () => {
    expect(ISSUE_SCORES.conflict).toBe(100);
  });
});
