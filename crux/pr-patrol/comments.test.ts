import { describe, it, expect } from 'vitest';
import {
  STATUS_MARKER,
  buildStatusCommentBody,
  stripTimestamp,
  buildMergeComment,
  buildMergeFailedComment,
  buildFixAttemptComment,
  buildFixCompleteComment,
  buildAbandonmentComment,
  buildTimeoutComment,
  buildNoOpComment,
} from './comments.ts';
import type { GqlPrNode } from './index.ts';

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

// ── buildStatusCommentBody ───────────────────────────────────────────────────

describe('buildStatusCommentBody', () => {
  it('includes the status marker for identification', () => {
    const body = buildStatusCommentBody(makePrNode(), []);
    expect(body).toContain(STATUS_MARKER);
  });

  it('shows all checks passing when PR is clean', () => {
    const body = buildStatusCommentBody(makePrNode(), []);
    expect(body).toContain('passing');
    expect(body).toContain('clean');
    expect(body).toContain('none unresolved');
    expect(body).toContain('complete');
    expect(body).toContain('Ready to merge');
  });

  it('shows CI failing when there are failures', () => {
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
    const body = buildStatusCommentBody(pr, ['ci-failing']);
    expect(body).toContain('failing');
    expect(body).toContain('`ci-failing`');
  });

  it('shows CI pending when checks are in progress', () => {
    const pr = makePrNode({
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
    });
    const body = buildStatusCommentBody(pr, ['ci-pending']);
    expect(body).toContain('pending');
    expect(body).toContain('Waiting for CI to complete');
  });

  it('shows conflicts when PR is not mergeable', () => {
    const pr = makePrNode({ mergeable: 'CONFLICTING' });
    const body = buildStatusCommentBody(pr, ['not-mergeable']);
    expect(body).toContain('has conflicts');
    expect(body).toContain('`not-mergeable`');
  });

  it('shows unresolved review threads', () => {
    const pr = makePrNode({
      reviewThreads: {
        nodes: [
          {
            isResolved: false,
            isOutdated: false,
            path: 'src/foo.ts',
            line: 10,
            startLine: null,
            comments: {
              nodes: [{ author: { login: 'user' }, body: 'Fix this' }],
            },
          },
          {
            isResolved: false,
            isOutdated: false,
            path: 'src/bar.ts',
            line: 20,
            startLine: null,
            comments: {
              nodes: [{ author: { login: 'user' }, body: 'Fix that' }],
            },
          },
        ],
      },
    });
    const body = buildStatusCommentBody(pr, ['unresolved-threads']);
    expect(body).toContain('2 unresolved');
    expect(body).toContain('`unresolved-threads`');
  });

  it('shows unchecked items in checklist', () => {
    const pr = makePrNode({
      body: '## Test plan\n\n- [ ] Not done\n- [x] Done\n\nCloses #1',
    });
    const body = buildStatusCommentBody(pr, ['unchecked-items']);
    expect(body).toContain('1 unchecked');
  });

  it('does not include Blocks line when no block reasons', () => {
    const body = buildStatusCommentBody(makePrNode(), []);
    expect(body).not.toContain('**Blocks**');
  });

  it('includes multiple block reasons', () => {
    const pr = makePrNode({ mergeable: 'CONFLICTING' });
    const body = buildStatusCommentBody(pr, ['not-mergeable', 'ci-failing']);
    expect(body).toContain('`not-mergeable`');
    expect(body).toContain('`ci-failing`');
  });

  it('shows stage for agent-working', () => {
    const body = buildStatusCommentBody(makePrNode(), ['agent-working']);
    expect(body).toContain('Claude is working on this PR');
  });

  it('shows draft stage', () => {
    const pr = makePrNode({ isDraft: true });
    const body = buildStatusCommentBody(pr, ['is-draft']);
    expect(body).toContain('Draft PR');
  });

  it('includes a timestamp line', () => {
    const body = buildStatusCommentBody(makePrNode(), []);
    expect(body).toMatch(/<sub>Updated:.*UTC<\/sub>/);
  });

  it('shows "no checks" when statusCheckRollup is null', () => {
    const pr = makePrNode({
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: null,
            },
          },
        ],
      },
    });
    const body = buildStatusCommentBody(pr, []);
    expect(body).toContain('no checks');
  });

  it('uses first matching block reason for stage when multiple overlap', () => {
    // 'agent-working' takes precedence over 'ci-failing' because it appears first
    // in the computeStage priority chain
    const body = buildStatusCommentBody(makePrNode(), [
      'ci-failing',
      'agent-working',
    ]);
    expect(body).toContain('Claude is working on this PR');
    // Both block reasons should still appear in the Blocks line
    expect(body).toContain('`ci-failing`');
    expect(body).toContain('`agent-working`');
  });

  it('picks ci-pending stage over ci-failing when both present', () => {
    // 'agent-working' is checked first, then 'ci-pending', then 'ci-failing'
    const body = buildStatusCommentBody(makePrNode(), [
      'ci-failing',
      'ci-pending',
    ]);
    expect(body).toContain('Waiting for CI to complete');
  });

  it('falls back to generic stage when only resolution-type blocks present', () => {
    const body = buildStatusCommentBody(makePrNode(), [
      'not-mergeable',
      'unresolved-threads',
    ]);
    expect(body).toContain('Waiting for issues to be resolved');
    expect(body).toContain('`not-mergeable`');
    expect(body).toContain('`unresolved-threads`');
  });
});

// ── stripTimestamp ────────────────────────────────────────────────────────────

describe('stripTimestamp', () => {
  it('strips timestamp from status comment for comparison', () => {
    const body1 = buildStatusCommentBody(makePrNode(), []);
    // Simulate a later update with different timestamp
    const body2 = body1.replace(
      /<sub>Updated:.*<\/sub>/,
      '<sub>Updated: 2026-03-06 23:59 UTC</sub>',
    );
    expect(stripTimestamp(body1)).toBe(stripTimestamp(body2));
  });

  it('does not modify bodies without timestamps', () => {
    const body = 'No timestamp here';
    expect(stripTimestamp(body)).toBe(body);
  });
});

// ── Event comment builders ───────────────────────────────────────────────────

describe('event comment builders', () => {
  it('buildMergeComment produces expected format', () => {
    const result = buildMergeComment();
    expect(result).toContain('PR Patrol');
    expect(result).toContain('Merged to main via squash merge');
  });

  it('buildMergeFailedComment includes reason', () => {
    const result = buildMergeFailedComment('Branch protection rule violated');
    expect(result).toContain('Merge failed');
    expect(result).toContain('Branch protection rule violated');
  });

  it('buildFixAttemptComment lists issues', () => {
    const result = buildFixAttemptComment(['conflict', 'ci-failure']);
    expect(result).toContain('Attempting fix for');
    expect(result).toContain('conflict');
    expect(result).toContain('ci-failure');
  });

  it('buildFixCompleteComment includes timing and output', () => {
    const result = buildFixCompleteComment(
      45,
      12,
      'sonnet',
      ['conflict'],
      'Fixed the merge conflict in src/foo.ts',
    );
    expect(result).toContain('45s');
    expect(result).toContain('12 max turns');
    expect(result).toContain('sonnet');
    expect(result).toContain('conflict');
    expect(result).toContain('Fixed the merge conflict');
  });

  it('buildFixCompleteComment truncates long output to 300 chars', () => {
    const longOutput = 'x'.repeat(500);
    const result = buildFixCompleteComment(10, 5, 'haiku', ['ci-failure'], longOutput);
    // The function takes the last 300 chars of the output
    expect(result).toContain('x'.repeat(300));
    expect(result).not.toContain('x'.repeat(301));
  });

  it('buildAbandonmentComment includes fail count and issues', () => {
    const result = buildAbandonmentComment(2, ['conflict', 'ci-failure']);
    expect(result).toContain('2 failed fix attempts');
    expect(result).toContain('human intervention');
    expect(result).toContain('conflict');
    expect(result).toContain('ci-failure');
  });

  it('buildTimeoutComment includes timeout and attempt info', () => {
    const result = buildTimeoutComment(1, 30, ['conflict']);
    expect(result).toContain('timed out');
    expect(result).toContain('30m');
    expect(result).toContain('attempt 1');
    expect(result).toContain('conflict');
  });

  it('buildNoOpComment includes issues', () => {
    const result = buildNoOpComment(['ci-failure']);
    expect(result).toContain('human intervention');
    expect(result).toContain('ci-failure');
  });
});
