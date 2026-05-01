import { describe, it, expect } from 'vitest';
import { detectIssues, extractBotComments, detectAllPrIssuesFromNodes } from './detection.ts';
import { detectCodeRabbitRateLimited } from '../lib/pr-analysis/detection.ts';
import type { GqlPrNode, PatrolConfig } from './types.ts';

function makePrNode(overrides: Partial<GqlPrNode> = {}): GqlPrNode {
  return {
    id: 'PR_test_id',
    number: 1,
    title: 'Test PR',
    headRefName: 'claude/test',
    baseRefName: 'main',
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

  it('returns names of failing checks', () => {
    const pr = makePrNode({
      commits: {
        nodes: [{
          commit: {
            statusCheckRollup: {
              contexts: { nodes: [
                { name: 'build', conclusion: 'SUCCESS' },
                { name: 'validate', conclusion: 'FAILURE' },
              ] },
            },
          },
        }],
      },
    });
    const result = detectIssues(pr, 0);
    expect(result.failingChecks).toEqual(['validate']);
  });

  it('returns empty failingChecks when all checks pass', () => {
    const pr = makePrNode();
    const result = detectIssues(pr, 0);
    expect(result.failingChecks).toEqual([]);
  });

  it('accepts Fixes and Resolves as issue refs', () => {
    for (const keyword of ['Closes #1', 'Fixes #2', 'Resolves #3']) {
      const pr = makePrNode({ body: `## Test plan\n\n${keyword}` });
      const result = detectIssues(pr, 0);
      expect(result.issues).not.toContain('missing-issue-ref');
    }
  });

  it('accepts lowercase closing keywords (case-insensitive)', () => {
    for (const keyword of ['closes #1', 'fixes #2', 'resolves #3', 'CLOSES #4']) {
      const pr = makePrNode({ body: `## Test plan\n\n${keyword}` });
      const result = detectIssues(pr, 0);
      expect(result.issues).not.toContain('missing-issue-ref');
    }
  });

  it('accepts Linear refs (Closes QUA-NNN) as issue refs (QUA-884)', () => {
    for (const keyword of ['Closes QUA-815', 'Fixes QUA-876', 'Resolves QUA-1', 'closes qua-42']) {
      const pr = makePrNode({ body: `## Test plan\n\n${keyword}` });
      const result = detectIssues(pr, 0);
      expect(result.issues).not.toContain('missing-issue-ref');
    }
  });

  it('still rejects bare QUA-NNN without a closing keyword', () => {
    const pr = makePrNode({ body: `## Test plan\n\nThis relates to QUA-815 but doesn't close it.` });
    const result = detectIssues(pr, 0);
    expect(result.issues).toContain('missing-issue-ref');
  });
});

// ── detectAllPrIssuesFromNodes — bot/release PR skipping ──────────────────

const defaultConfig: PatrolConfig = {
  repo: 'test/repo',
  intervalSeconds: 60,
  maxTurns: 10,
  cooldownSeconds: 300,
  staleHours: 72,
  model: 'sonnet',
  skipPerms: false,
  once: false,
  dryRun: false,
  verbose: false,
  reflectionInterval: 5,
  timeoutMinutes: 30,
};

describe('detectAllPrIssuesFromNodes — bot/release PR skipping', () => {
  it('skips Dependabot-authored PRs', () => {
    const pr = makePrNode({
      number: 10,
      author: { login: 'dependabot[bot]' },
      // Body lacks issue ref — would normally trigger missing-issue-ref
      body: 'Bumps lodash from 4.0 to 4.1',
    });
    const result = detectAllPrIssuesFromNodes([pr], defaultConfig);
    expect(result.find((r) => r.number === 10)).toBeUndefined();
  });

  it('skips Renovate-authored PRs', () => {
    const pr = makePrNode({
      number: 11,
      author: { login: 'renovate[bot]' },
      body: 'Update dependency typescript to v5.4',
    });
    const result = detectAllPrIssuesFromNodes([pr], defaultConfig);
    expect(result.find((r) => r.number === 11)).toBeUndefined();
  });

  it('skips github-actions[bot]-authored PRs', () => {
    const pr = makePrNode({
      number: 12,
      author: { login: 'github-actions[bot]' },
      body: 'Automated release',
    });
    const result = detectAllPrIssuesFromNodes([pr], defaultConfig);
    expect(result.find((r) => r.number === 12)).toBeUndefined();
  });

  it('skips PRs from dependabot/ branch prefix', () => {
    const pr = makePrNode({
      number: 20,
      headRefName: 'dependabot/npm_and_yarn/lodash-4.17.21',
      author: { login: 'someuser' },
      body: 'Bump lodash',
    });
    const result = detectAllPrIssuesFromNodes([pr], defaultConfig);
    expect(result.find((r) => r.number === 20)).toBeUndefined();
  });

  it('skips PRs from renovate/ branch prefix', () => {
    const pr = makePrNode({
      number: 21,
      headRefName: 'renovate/typescript-5.x',
      author: { login: 'someuser' },
      body: 'Update typescript',
    });
    const result = detectAllPrIssuesFromNodes([pr], defaultConfig);
    expect(result.find((r) => r.number === 21)).toBeUndefined();
  });

  it('skips PRs from release/ branch prefix', () => {
    const pr = makePrNode({
      number: 22,
      headRefName: 'release/v2.0.0',
      author: { login: 'someuser' },
      body: 'Release v2.0.0',
    });
    const result = detectAllPrIssuesFromNodes([pr], defaultConfig);
    expect(result.find((r) => r.number === 22)).toBeUndefined();
  });

  // QUA-971: release PRs use head=main, base=production. Patrol's worktree of
  // main collides with coord's checkout, and release PRs belong to the
  // releases role anyway. Skip by baseRefName.
  it('skips release PRs (main → production) by baseRefName', () => {
    const pr = makePrNode({
      number: 23,
      headRefName: 'main',
      baseRefName: 'production',
      title: 'release: 2026-05-01',
      author: { login: 'someuser' },
      body: 'Release rollup',
    });
    const result = detectAllPrIssuesFromNodes([pr], defaultConfig);
    expect(result.find((r) => r.number === 23)).toBeUndefined();
  });

  it('does NOT skip normal human-authored PRs', () => {
    const pr = makePrNode({
      number: 30,
      author: { login: 'humandev' },
      headRefName: 'claude/fix-bug',
      // Body lacks issue ref — triggers missing-issue-ref
      body: 'Fixed the bug',
    });
    const result = detectAllPrIssuesFromNodes([pr], defaultConfig);
    expect(result.find((r) => r.number === 30)).toBeDefined();
  });

  it('does NOT skip PRs with null author', () => {
    const pr = makePrNode({
      number: 31,
      author: null,
      headRefName: 'feature/something',
      body: 'Some changes',
    });
    const result = detectAllPrIssuesFromNodes([pr], defaultConfig);
    expect(result.find((r) => r.number === 31)).toBeDefined();
  });

  it('logs skipped bot PRs in verbose mode', () => {
    const verboseConfig = { ...defaultConfig, verbose: true };
    const pr = makePrNode({
      number: 40,
      author: { login: 'dependabot[bot]' },
      body: 'Bump package',
    });
    // Should not throw; just verifying the code path runs without error
    const result = detectAllPrIssuesFromNodes([pr], verboseConfig);
    expect(result.find((r) => r.number === 40)).toBeUndefined();
  });

  it('logs skipped branch PRs in verbose mode', () => {
    const verboseConfig = { ...defaultConfig, verbose: true };
    const pr = makePrNode({
      number: 41,
      headRefName: 'release/v1.0',
      body: 'Release',
    });
    const result = detectAllPrIssuesFromNodes([pr], verboseConfig);
    expect(result.find((r) => r.number === 41)).toBeUndefined();
  });
});

// ── detectCodeRabbitRateLimited ──────────────────────────────────────────────

describe('detectCodeRabbitRateLimited', () => {
  it('returns true when CodeRabbit StatusContext is PENDING', () => {
    const pr = makePrNode({
      commits: {
        nodes: [{
          commit: {
            statusCheckRollup: {
              contexts: {
                nodes: [{ context: 'CodeRabbit', state: 'PENDING' }],
              },
            },
          },
        }],
      },
    });
    expect(detectCodeRabbitRateLimited(pr)).toBe(true);
  });

  it('returns true when CodeRabbit StatusContext is ERROR', () => {
    const pr = makePrNode({
      commits: {
        nodes: [{
          commit: {
            statusCheckRollup: {
              contexts: {
                nodes: [{ context: 'CodeRabbit', state: 'ERROR' }],
              },
            },
          },
        }],
      },
    });
    expect(detectCodeRabbitRateLimited(pr)).toBe(true);
  });

  it('returns true when CodeRabbit StatusContext is FAILURE', () => {
    const pr = makePrNode({
      commits: {
        nodes: [{
          commit: {
            statusCheckRollup: {
              contexts: {
                nodes: [{ context: 'CodeRabbit', state: 'FAILURE' }],
              },
            },
          },
        }],
      },
    });
    expect(detectCodeRabbitRateLimited(pr)).toBe(true);
  });

  it('returns false when CodeRabbit StatusContext is SUCCESS', () => {
    const pr = makePrNode({
      commits: {
        nodes: [{
          commit: {
            statusCheckRollup: {
              contexts: {
                nodes: [{ context: 'CodeRabbit', state: 'SUCCESS' }],
              },
            },
          },
        }],
      },
    });
    expect(detectCodeRabbitRateLimited(pr)).toBe(false);
  });

  it('returns false when no CodeRabbit context exists', () => {
    const pr = makePrNode({
      commits: {
        nodes: [{
          commit: {
            statusCheckRollup: {
              contexts: {
                nodes: [{ name: 'build', conclusion: 'SUCCESS' }],
              },
            },
          },
        }],
      },
    });
    expect(detectCodeRabbitRateLimited(pr)).toBe(false);
  });

  it('returns true when coderabbitai comment mentions "rate limit"', () => {
    const pr = makePrNode({
      reviewThreads: {
        nodes: [{
          id: 'thread-rl',
          isResolved: false,
          isOutdated: false,
          path: 'src/foo.ts',
          line: 1,
          startLine: null,
          comments: {
            nodes: [{ author: { login: 'coderabbitai' }, body: 'Rate limit exceeded. Please wait 30 minutes.' }],
          },
        }],
      },
    });
    expect(detectCodeRabbitRateLimited(pr)).toBe(true);
  });

  it('returns true when coderabbitai comment mentions "Review skipped"', () => {
    const pr = makePrNode({
      reviewThreads: {
        nodes: [{
          id: 'thread-rs',
          isResolved: false,
          isOutdated: false,
          path: 'src/bar.ts',
          line: 5,
          startLine: null,
          comments: {
            nodes: [{ author: { login: 'coderabbitai' }, body: 'Review skipped due to rate limiting.' }],
          },
        }],
      },
    });
    expect(detectCodeRabbitRateLimited(pr)).toBe(true);
  });

  it('ignores resolved rate-limit threads', () => {
    const pr = makePrNode({
      reviewThreads: {
        nodes: [{
          id: 'thread-resolved',
          isResolved: true,
          isOutdated: false,
          path: 'src/foo.ts',
          line: 1,
          startLine: null,
          comments: {
            nodes: [{ author: { login: 'coderabbitai' }, body: 'Rate limit exceeded.' }],
          },
        }],
      },
    });
    expect(detectCodeRabbitRateLimited(pr)).toBe(false);
  });

  it('ignores rate-limit comments from non-coderabbit authors', () => {
    const pr = makePrNode({
      reviewThreads: {
        nodes: [{
          id: 'thread-human',
          isResolved: false,
          isOutdated: false,
          path: 'src/foo.ts',
          line: 1,
          startLine: null,
          comments: {
            nodes: [{ author: { login: 'humanuser' }, body: 'Rate limit exceeded on my local.' }],
          },
        }],
      },
    });
    expect(detectCodeRabbitRateLimited(pr)).toBe(false);
  });

  it('returns false for a clean PR with no rate-limit signals', () => {
    const pr = makePrNode();
    expect(detectCodeRabbitRateLimited(pr)).toBe(false);
  });

  it('is case-insensitive for CodeRabbit context name', () => {
    const pr = makePrNode({
      commits: {
        nodes: [{
          commit: {
            statusCheckRollup: {
              contexts: {
                nodes: [{ context: 'coderabbit', state: 'PENDING' }],
              },
            },
          },
        }],
      },
    });
    expect(detectCodeRabbitRateLimited(pr)).toBe(true);
  });
});

// ── detectAllPrIssuesFromNodes — blockedOnPrs (QUA-287 Phase 3) ─────────────

describe('detectAllPrIssuesFromNodes — blockedOnPrs cross-PR deps', () => {
  it('populates blockedOnPrs for the #4157/#4188 fixture', () => {
    // PR #4157 has a failing CI check + a cross-reference to PR #4188
    const pr4157 = makePrNode({
      number: 4157,
      headRefName: 'claude/feature-a',
      author: { login: 'humanuser' },
      body: '## Test plan\nstuff\nCloses #100',
      commits: {
        nodes: [{
          commit: {
            statusCheckRollup: {
              contexts: { nodes: [{ name: 'build', conclusion: 'FAILURE' }] },
            },
          },
        }],
      },
      timelineItems: {
        nodes: [
          {
            __typename: 'CrossReferencedEvent',
            source: { __typename: 'PullRequest', number: 4188, state: 'OPEN' },
          },
        ],
      },
    });
    const pr4188 = makePrNode({
      number: 4188,
      headRefName: 'claude/feature-b',
      author: { login: 'humanuser' },
      body: '## Test plan\nstuff\nCloses #200',
    });

    const result = detectAllPrIssuesFromNodes([pr4157, pr4188], defaultConfig);
    const detected4157 = result.find((r) => r.number === 4157);
    expect(detected4157).toBeDefined();
    expect(detected4157!.blockedOnPrs).toEqual([
      { pr: 4188, reason: 'cross-referenced' },
    ]);
  });

  it('leaves blockedOnPrs undefined when no cross-PR refs found', () => {
    const pr = makePrNode({
      number: 4157,
      author: { login: 'humanuser' },
      body: '## Test plan\nx\nCloses #1',
      commits: {
        nodes: [{
          commit: {
            statusCheckRollup: {
              contexts: { nodes: [{ name: 'build', conclusion: 'FAILURE' }] },
            },
          },
        }],
      },
    });
    const result = detectAllPrIssuesFromNodes([pr], defaultConfig);
    const detected = result.find((r) => r.number === 4157);
    expect(detected).toBeDefined();
    expect(detected!.blockedOnPrs).toBeUndefined();
  });

  it('drops #NNNN tokens that do not correspond to open PRs', () => {
    // PR references #99999 (not open) and #4188 (open) in failing check output
    const pr4157 = makePrNode({
      number: 4157,
      author: { login: 'humanuser' },
      body: '## Test plan\nx\nCloses #1',
      commits: {
        nodes: [{
          commit: {
            statusCheckRollup: {
              contexts: {
                nodes: [
                  { name: 'gate: conflicts with #99999 and #4188', conclusion: 'FAILURE' },
                ],
              },
            },
          },
        }],
      },
    });
    const pr4188 = makePrNode({ number: 4188, author: { login: 'humanuser' } });

    const result = detectAllPrIssuesFromNodes([pr4157, pr4188], defaultConfig);
    const detected = result.find((r) => r.number === 4157);
    expect(detected).toBeDefined();
    // Only #4188 survives validation — #99999 is not in the open-PR list
    expect(detected!.blockedOnPrs).toEqual([{ pr: 4188, reason: 'gate error' }]);
  });
});
