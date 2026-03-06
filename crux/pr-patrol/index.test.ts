import { describe, it, expect } from 'vitest';
import {
  checkMergeEligibility,
  findMergeCandidates,
  detectIssues,
  type GqlPrNode,
} from './index.ts';

// ── Test helpers ─────────────────────────────────────────────────────────────

function makePrNode(overrides: Partial<GqlPrNode> = {}): GqlPrNode {
  return {
    number: 1,
    title: 'Test PR',
    headRefName: 'claude/test',
    mergeable: 'MERGEABLE',
    isDraft: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-03-05T00:00:00Z',
    body: '## Summary\n\n- [x] Task done\n\n## Test plan\n\n- [x] Tests pass\n\nCloses #1',
    labels: { nodes: [{ name: 'ready-to-merge' }] },
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

// ── checkMergeEligibility ────────────────────────────────────────────────────

describe('checkMergeEligibility', () => {
  it('returns eligible when all checks pass', () => {
    const result = checkMergeEligibility(makePrNode());
    expect(result.eligible).toBe(true);
    expect(result.blockReasons).toEqual([]);
  });

  it('blocks when mergeable is CONFLICTING', () => {
    const result = checkMergeEligibility(
      makePrNode({ mergeable: 'CONFLICTING' }),
    );
    expect(result.eligible).toBe(false);
    expect(result.blockReasons).toContain('not-mergeable');
  });

  it('blocks when mergeable is UNKNOWN', () => {
    const result = checkMergeEligibility(
      makePrNode({ mergeable: 'UNKNOWN' }),
    );
    expect(result.eligible).toBe(false);
    expect(result.blockReasons).toContain('not-mergeable');
  });

  it('blocks when CI has FAILURE conclusion', () => {
    const result = checkMergeEligibility(
      makePrNode({
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: {
                    nodes: [{ conclusion: 'FAILURE' }],
                  },
                },
              },
            },
          ],
        },
      }),
    );
    expect(result.eligible).toBe(false);
    expect(result.blockReasons).toContain('ci-failing');
  });

  it('blocks when a StatusContext has ERROR state', () => {
    const result = checkMergeEligibility(
      makePrNode({
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: {
                    nodes: [{ state: 'ERROR' }],
                  },
                },
              },
            },
          ],
        },
      }),
    );
    expect(result.eligible).toBe(false);
    expect(result.blockReasons).toContain('ci-failing');
  });

  it('blocks when CI has CANCELLED conclusion', () => {
    const result = checkMergeEligibility(
      makePrNode({
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: {
                    nodes: [{ conclusion: 'CANCELLED' }],
                  },
                },
              },
            },
          ],
        },
      }),
    );
    expect(result.eligible).toBe(false);
    expect(result.blockReasons).toContain('ci-failing');
  });

  it('blocks when CI checks have null conclusion (pending)', () => {
    const result = checkMergeEligibility(
      makePrNode({
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: {
                    nodes: [{ conclusion: null }],
                  },
                },
              },
            },
          ],
        },
      }),
    );
    expect(result.eligible).toBe(false);
    expect(result.blockReasons).toContain('ci-pending');
    expect(result.blockReasons).not.toContain('ci-failing');
  });

  it('does not block ci-pending when there are no check contexts', () => {
    const result = checkMergeEligibility(
      makePrNode({
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: { nodes: [] },
                },
              },
            },
          ],
        },
      }),
    );
    expect(result.eligible).toBe(true);
    expect(result.blockReasons).not.toContain('ci-pending');
  });

  it('blocks when there are unresolved, non-outdated review threads', () => {
    const result = checkMergeEligibility(
      makePrNode({
        reviewThreads: {
          nodes: [
            {
              isResolved: false,
              isOutdated: false,
              path: 'src/foo.ts',
              line: 10,
              startLine: null,
              comments: {
                nodes: [
                  { author: { login: 'coderabbitai' }, body: 'Fix this' },
                ],
              },
            },
          ],
        },
      }),
    );
    expect(result.eligible).toBe(false);
    expect(result.blockReasons).toContain('unresolved-threads');
  });

  it('does NOT block for outdated unresolved threads', () => {
    const result = checkMergeEligibility(
      makePrNode({
        reviewThreads: {
          nodes: [
            {
              isResolved: false,
              isOutdated: true,
              path: 'src/foo.ts',
              line: 10,
              startLine: null,
              comments: {
                nodes: [
                  { author: { login: 'coderabbitai' }, body: 'Fix this' },
                ],
              },
            },
          ],
        },
      }),
    );
    expect(result.eligible).toBe(true);
    expect(result.blockReasons).not.toContain('unresolved-threads');
  });

  it('does NOT block for resolved threads', () => {
    const result = checkMergeEligibility(
      makePrNode({
        reviewThreads: {
          nodes: [
            {
              isResolved: true,
              isOutdated: false,
              path: 'src/foo.ts',
              line: 10,
              startLine: null,
              comments: {
                nodes: [
                  { author: { login: 'coderabbitai' }, body: 'Fix this' },
                ],
              },
            },
          ],
        },
      }),
    );
    expect(result.eligible).toBe(true);
  });

  it('blocks when PR body has unchecked checkboxes', () => {
    const result = checkMergeEligibility(
      makePrNode({
        body: '## Test plan\n\n- [ ] Not done yet\n- [x] Done\n\nCloses #1',
      }),
    );
    expect(result.eligible).toBe(false);
    expect(result.blockReasons).toContain('unchecked-items');
  });

  it('does NOT block when all checkboxes are checked', () => {
    const result = checkMergeEligibility(
      makePrNode({
        body: '## Test plan\n\n- [x] Done\n- [x] Also done\n\nCloses #1',
      }),
    );
    expect(result.eligible).toBe(true);
    expect(result.blockReasons).not.toContain('unchecked-items');
  });

  it('does NOT block when body has no checkboxes', () => {
    const result = checkMergeEligibility(
      makePrNode({ body: 'Simple PR body' }),
    );
    expect(result.eligible).toBe(true);
  });

  it('blocks when claude-working label is present', () => {
    const result = checkMergeEligibility(
      makePrNode({
        labels: {
          nodes: [{ name: 'ready-to-merge' }, { name: 'claude-working' }],
        },
      }),
    );
    expect(result.eligible).toBe(false);
    expect(result.blockReasons).toContain('claude-working');
  });

  it('blocks when PR is a draft', () => {
    const result = checkMergeEligibility(
      makePrNode({ isDraft: true }),
    );
    expect(result.eligible).toBe(false);
    expect(result.blockReasons).toContain('is-draft');
  });

  it('does NOT block when PR is not a draft', () => {
    const result = checkMergeEligibility(makePrNode({ isDraft: false }));
    expect(result.eligible).toBe(true);
    expect(result.blockReasons).not.toContain('is-draft');
  });

  it('returns multiple block reasons when several checks fail', () => {
    const result = checkMergeEligibility(
      makePrNode({
        mergeable: 'CONFLICTING',
        body: '- [ ] Not done',
        labels: {
          nodes: [{ name: 'ready-to-merge' }, { name: 'claude-working' }],
        },
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: {
                    nodes: [{ conclusion: 'FAILURE' }],
                  },
                },
              },
            },
          ],
        },
      }),
    );
    expect(result.eligible).toBe(false);
    expect(result.blockReasons).toContain('claude-working');
    expect(result.blockReasons).toContain('not-mergeable');
    expect(result.blockReasons).toContain('ci-failing');
    expect(result.blockReasons).toContain('unchecked-items');
  });
});

// ── findMergeCandidates ──────────────────────────────────────────────────────

describe('findMergeCandidates', () => {
  it('returns empty when no PRs have ready-to-merge label', () => {
    const prs = [
      makePrNode({ labels: { nodes: [{ name: 'enhancement' }] } }),
    ];
    expect(findMergeCandidates(prs)).toEqual([]);
  });

  it('sorts oldest first by createdAt', () => {
    const newer = makePrNode({
      number: 2,
      createdAt: '2026-03-01T00:00:00Z',
    });
    const older = makePrNode({
      number: 1,
      createdAt: '2026-01-01T00:00:00Z',
    });
    const result = findMergeCandidates([newer, older]);
    expect(result[0].number).toBe(1);
    expect(result[1].number).toBe(2);
  });

  it('includes both eligible and blocked PRs', () => {
    const eligible = makePrNode({ number: 1 });
    const blocked = makePrNode({
      number: 2,
      mergeable: 'CONFLICTING',
    });
    const result = findMergeCandidates([eligible, blocked]);
    expect(result).toHaveLength(2);
    expect(result.find((c) => c.number === 1)?.eligible).toBe(true);
    expect(result.find((c) => c.number === 2)?.eligible).toBe(false);
  });

  it('marks draft PRs as blocked with is-draft reason', () => {
    const draftPr = makePrNode({ number: 1, isDraft: true });
    const result = findMergeCandidates([draftPr]);
    expect(result).toHaveLength(1);
    expect(result[0].eligible).toBe(false);
    expect(result[0].blockReasons).toContain('is-draft');
  });

  it('draft PR with only is-draft block is undraft-eligible', () => {
    const draftPr = makePrNode({ number: 1, isDraft: true });
    const result = findMergeCandidates([draftPr]);
    const undraftEligible = result.filter(
      (c) => !c.eligible && c.blockReasons.length === 1 && c.blockReasons[0] === 'is-draft',
    );
    expect(undraftEligible).toHaveLength(1);
  });
});

// ── detectIssues (regression test after refactor) ────────────────────────────

describe('detectIssues', () => {
  it('detects conflict on CONFLICTING mergeable status', () => {
    const pr = makePrNode({ mergeable: 'CONFLICTING' });
    const result = detectIssues(pr, Date.now());
    expect(result.issues).toContain('conflict');
  });

  it('detects ci-failure on FAILURE conclusion', () => {
    const pr = makePrNode({
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                contexts: {
                  nodes: [{ conclusion: 'FAILURE' }],
                },
              },
            },
          },
        ],
      },
    });
    const result = detectIssues(pr, Date.now());
    expect(result.issues).toContain('ci-failure');
  });

  it('detects missing-testplan when body lacks ## Test plan', () => {
    const pr = makePrNode({ body: 'No test plan here' });
    const result = detectIssues(pr, Date.now());
    expect(result.issues).toContain('missing-testplan');
  });

  it('detects missing-issue-ref when body lacks Closes/Fixes #N', () => {
    const pr = makePrNode({ body: '## Test plan\n- [x] Done' });
    const result = detectIssues(pr, Date.now());
    expect(result.issues).toContain('missing-issue-ref');
  });

  it('returns no issues for a clean PR', () => {
    const pr = makePrNode();
    // Set stale threshold to far in the past so this PR is not stale
    const result = detectIssues(pr, 0);
    expect(result.issues).toEqual([]);
  });
});
