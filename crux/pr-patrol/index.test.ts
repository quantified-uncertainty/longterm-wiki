import { describe, it, expect } from 'vitest';
import { LABELS } from '../lib/labels.ts';
import {
  checkMergeEligibility,
  findMergeCandidates,
  detectIssues,
  computeBudget,
  looksLikeNoOp,
  type GqlPrNode,
} from './index.ts';

// ── Test helpers ─────────────────────────────────────────────────────────────

function makePrNode(overrides: Partial<GqlPrNode> = {}): GqlPrNode {
  return {
    number: 1,
    title: 'Test PR',
    headRefName: 'claude/test',
    headRefOid: 'abc123def456',
    mergeable: 'MERGEABLE',
    isDraft: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-03-05T00:00:00Z',
    body: '## Summary\n\n- [x] Task done\n\n## Test plan\n\n- [x] Tests pass\n\nCloses #1',
    labels: { nodes: [{ name: LABELS.STAGE_APPROVED }] },
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

  it('blocks when CI has TIMED_OUT conclusion', () => {
    const result = checkMergeEligibility(
      makePrNode({
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: {
                    nodes: [{ conclusion: 'TIMED_OUT' }],
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

  it('blocks when CI has ACTION_REQUIRED conclusion', () => {
    const result = checkMergeEligibility(
      makePrNode({
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: {
                    nodes: [{ conclusion: 'ACTION_REQUIRED' }],
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

  it('blocks when CI has STARTUP_FAILURE conclusion', () => {
    const result = checkMergeEligibility(
      makePrNode({
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: {
                    nodes: [{ conclusion: 'STARTUP_FAILURE' }],
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

  it('blocks when CI has STALE conclusion', () => {
    const result = checkMergeEligibility(
      makePrNode({
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: {
                    nodes: [{ conclusion: 'STALE' }],
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
              id: 'thread-1',
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
              id: 'thread-2',
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
              id: 'thread-3',
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

  it('blocks when agent:working label is present', () => {
    const result = checkMergeEligibility(
      makePrNode({
        labels: {
          nodes: [{ name: LABELS.STAGE_APPROVED }, { name: LABELS.AGENT_WORKING }],
        },
      }),
    );
    expect(result.eligible).toBe(false);
    expect(result.blockReasons).toContain('agent-working');
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
          nodes: [{ name: LABELS.STAGE_APPROVED }, { name: LABELS.AGENT_WORKING }],
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
    expect(result.blockReasons).toContain('agent-working');
    expect(result.blockReasons).toContain('not-mergeable');
    expect(result.blockReasons).toContain('ci-failing');
    expect(result.blockReasons).toContain('unchecked-items');
  });
});

// ── findMergeCandidates ──────────────────────────────────────────────────────

describe('findMergeCandidates', () => {
  it('returns empty when no PRs have stage:approved label', () => {
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

// ── computeBudget ────────────────────────────────────────────────────────────

describe('computeBudget', () => {
  it('gives small budget for missing-issue-ref only', () => {
    const budget = computeBudget(['missing-issue-ref']);
    expect(budget.maxTurns).toBe(5);
    expect(budget.timeoutMinutes).toBe(3);
  });

  it('gives small budget for missing-testplan only', () => {
    const budget = computeBudget(['missing-testplan']);
    expect(budget.maxTurns).toBe(8);
    expect(budget.timeoutMinutes).toBe(5);
  });

  it('gives medium budget for ci-failure', () => {
    const budget = computeBudget(['ci-failure']);
    expect(budget.maxTurns).toBe(25);
    expect(budget.timeoutMinutes).toBe(15);
  });

  it('gives full budget for conflict', () => {
    const budget = computeBudget(['conflict']);
    expect(budget.maxTurns).toBe(40);
    expect(budget.timeoutMinutes).toBe(30);
  });

  it('uses highest budget when multiple issues present', () => {
    const budget = computeBudget(['missing-issue-ref', 'ci-failure']);
    expect(budget.maxTurns).toBe(25);
    expect(budget.timeoutMinutes).toBe(15);
  });

  it('conflict dominates when mixed with smaller issues', () => {
    const budget = computeBudget(['missing-testplan', 'conflict', 'missing-issue-ref']);
    expect(budget.maxTurns).toBe(40);
    expect(budget.timeoutMinutes).toBe(30);
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

// ── looksLikeNoOp ───────────────────────────────────────────────────────────

describe('looksLikeNoOp', () => {
  it('detects "no action needed" in output tail', () => {
    expect(looksLikeNoOp('Analyzed the issue. No action needed for this PR.')).toBe(true);
  });

  it('detects "requires human intervention"', () => {
    expect(looksLikeNoOp('The check-protected-paths check requires human intervention to add the label.')).toBe(true);
  });

  it('detects "pre-existing failure"', () => {
    expect(looksLikeNoOp('This is a pre-existing failure also present on main.')).toBe(true);
  });

  it('detects "also failing on main"', () => {
    expect(looksLikeNoOp('The CI check is also failing on main, so this is not introduced by this PR.')).toBe(true);
  });

  it('detects "stopping early"', () => {
    expect(looksLikeNoOp('Stopping early because the issue cannot be resolved automatically.')).toBe(true);
  });

  it('does NOT flag normal fix output', () => {
    expect(looksLikeNoOp('Fixed the TypeScript error in src/index.ts. All tests passing now.')).toBe(false);
  });

  it('does NOT flag output with "no" in unrelated context', () => {
    expect(looksLikeNoOp('Added the missing test. No regressions found after running the suite.')).toBe(false);
  });

  it('only checks last 1000 chars of output', () => {
    const longOutput = 'x'.repeat(2000) + 'No action needed.';
    expect(looksLikeNoOp(longOutput)).toBe(true);
    // Pattern in the first 1000 chars but not the last 1000
    const earlyMatch = 'No action needed.' + 'x'.repeat(2000);
    expect(looksLikeNoOp(earlyMatch)).toBe(false);
  });
});
