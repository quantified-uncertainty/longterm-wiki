import { describe, it, expect } from 'vitest';
import { detectIssues, extractBotComments } from './detection.ts';
import type { GqlPrNode } from './types.ts';

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

// ── extractBotComments ───────────────────────────────────────────────────────

describe('extractBotComments', () => {
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

  it('skips resolved threads', () => {
    const pr = makePrNode({
      reviewThreads: {
        nodes: [{
          id: 'thread-1',
          isResolved: true,
          isOutdated: false,
          path: 'src/foo.ts',
          line: 10,
          startLine: null,
          comments: {
            nodes: [{ author: { login: 'coderabbitai' }, body: 'Fix this' }],
          },
        }],
      },
    });
    expect(extractBotComments(pr)).toHaveLength(0);
  });

  it('skips outdated threads', () => {
    const pr = makePrNode({
      reviewThreads: {
        nodes: [{
          id: 'thread-1',
          isResolved: false,
          isOutdated: true,
          path: 'src/foo.ts',
          line: 10,
          startLine: null,
          comments: {
            nodes: [{ author: { login: 'coderabbitai' }, body: 'Fix this' }],
          },
        }],
      },
    });
    expect(extractBotComments(pr)).toHaveLength(0);
  });

  it('skips non-bot authors', () => {
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
            nodes: [{ author: { login: 'humanuser' }, body: 'Fix this' }],
          },
        }],
      },
    });
    expect(extractBotComments(pr)).toHaveLength(0);
  });

  it('recognizes all known bot logins', () => {
    const bots = ['coderabbitai', 'github-actions', 'dependabot', 'renovate'];
    for (const bot of bots) {
      const pr = makePrNode({
        reviewThreads: {
          nodes: [{
            id: 'thread-1',
            isResolved: false,
            isOutdated: false,
            path: 'src/test.ts',
            line: 1,
            startLine: null,
            comments: {
              nodes: [{ author: { login: bot }, body: 'Fix' }],
            },
          }],
        },
      });
      expect(extractBotComments(pr)).toHaveLength(1);
    }
  });

  it('returns empty for PR with no review threads', () => {
    const pr = makePrNode({ reviewThreads: undefined });
    expect(extractBotComments(pr)).toEqual([]);
  });
});

// ── detectIssues ─────────────────────────────────────────────────────────────

describe('detectIssues', () => {
  it('detects bot-review-major for actionable severity', () => {
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
            nodes: [{ author: { login: 'coderabbitai' }, body: '🟠 Major: Important issue' }],
          },
        }],
      },
    });
    const result = detectIssues(pr, 0);
    expect(result.issues).toContain('bot-review-major');
    expect(result.issues).not.toContain('bot-review-nitpick');
  });

  it('detects bot-review-nitpick for non-actionable severity', () => {
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
            nodes: [{ author: { login: 'coderabbitai' }, body: '🧹 Nitpick: Minor style' }],
          },
        }],
      },
    });
    const result = detectIssues(pr, 0);
    expect(result.issues).toContain('bot-review-nitpick');
    expect(result.issues).not.toContain('bot-review-major');
  });

  it('detects stale PRs', () => {
    const pr = makePrNode({
      updatedAt: '2020-01-01T00:00:00Z',
    });
    const result = detectIssues(pr, Date.now());
    expect(result.issues).toContain('stale');
  });

  it('does not flag recent PRs as stale', () => {
    const pr = makePrNode({
      updatedAt: new Date().toISOString(),
    });
    const result = detectIssues(pr, Date.now() - 1000);
    expect(result.issues).not.toContain('stale');
  });

  it('handles null PR body gracefully', () => {
    const pr = makePrNode({ body: null });
    const result = detectIssues(pr, 0);
    expect(result.issues).toContain('missing-testplan');
    expect(result.issues).toContain('missing-issue-ref');
  });

  it('handles null statusCheckRollup', () => {
    const pr = makePrNode({
      commits: {
        nodes: [{
          commit: { statusCheckRollup: null },
        }],
      },
    });
    const result = detectIssues(pr, 0);
    expect(result.issues).not.toContain('ci-failure');
  });

  it('detects ERROR state in StatusContext nodes', () => {
    const pr = makePrNode({
      commits: {
        nodes: [{
          commit: {
            statusCheckRollup: {
              contexts: { nodes: [{ state: 'ERROR' }] },
            },
          },
        }],
      },
    });
    const result = detectIssues(pr, 0);
    expect(result.issues).toContain('ci-failure');
  });

  it('accepts Fixes and Resolves as issue refs', () => {
    for (const keyword of ['Closes #1', 'Fixes #2', 'Resolves #3']) {
      const pr = makePrNode({ body: `## Test plan\n\n${keyword}` });
      const result = detectIssues(pr, 0);
      expect(result.issues).not.toContain('missing-issue-ref');
    }
  });
});
