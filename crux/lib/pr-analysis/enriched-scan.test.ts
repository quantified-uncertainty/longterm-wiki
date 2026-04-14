/**
 * Tests for the enriched-scan additions to pr-analysis (QUA-285 Phase 1):
 *   - extractBlockingComments (top-level maintainer/urgency comments)
 *   - isSelfAuthored (agent-authored PR detection)
 *   - diffCheckRunsVsRollup (fresh vs stale CI data)
 *   - detectIssues emits merge-blocked / self-authored-feedback
 *   - fetchFreshCheckRuns caches + ETag conditional requests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  detectIssues,
  extractBlockingComments,
  isSelfAuthored,
  diffCheckRunsVsRollup,
  fetchFreshCheckRuns,
  _resetFreshCheckRunsCache,
} from './detection.ts';
import type { GqlPrNode, FreshCheckRun } from './types.ts';

// ── Test helpers ─────────────────────────────────────────────────────────────

function makePrNode(overrides: Partial<GqlPrNode> = {}): GqlPrNode {
  return {
    id: 'PR_test_id',
    number: 1,
    title: 'Test PR',
    headRefName: 'claude/qua-100-something',
    headRefOid: 'abc123def456',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    isDraft: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-04-11T00:00:00Z',
    body: '## Summary\n- x\n## Test plan\n- x\nCloses #1',
    author: { login: 'testuser' },
    labels: { nodes: [] },
    commits: {
      nodes: [{
        commit: {
          committedDate: '2026-04-10T00:00:00Z',
          statusCheckRollup: { contexts: { nodes: [{ conclusion: 'SUCCESS' }] } },
        },
      }],
    },
    reviewThreads: { nodes: [] },
    comments: { nodes: [] },
    timelineItems: { nodes: [] },
    ...overrides,
  };
}

// ── extractBlockingComments ──────────────────────────────────────────────────

describe('extractBlockingComments', () => {
  it('includes maintainer comment posted after last push', () => {
    const pr = makePrNode({
      commits: {
        nodes: [{
          commit: {
            committedDate: '2026-04-10T00:00:00Z',
            statusCheckRollup: { contexts: { nodes: [] } },
          },
        }],
      },
      comments: {
        nodes: [{
          author: { login: 'maintainer1', __typename: 'User' },
          authorAssociation: 'MEMBER',
          body: 'This looks wrong — please reconsider the approach.',
          createdAt: '2026-04-10T12:00:00Z',
          viewerDidAuthor: false,
        }],
      },
    });
    const blocking = extractBlockingComments(pr);
    expect(blocking).toHaveLength(1);
    expect(blocking[0].author).toBe('maintainer1');
    expect(blocking[0].authorAssociation).toBe('MEMBER');
  });

  it('excludes bot comments that lack urgency keywords and are not authoritative', () => {
    // Bot posts a helpful notice but NOT authoritative + NOT urgent — should be excluded
    const pr = makePrNode({
      comments: {
        nodes: [{
          author: { login: 'some-bot', __typename: 'Bot' },
          authorAssociation: 'NONE',
          body: 'LGTM from the automated check.',
          createdAt: '2026-04-10T12:00:00Z',
          viewerDidAuthor: false,
        }],
      },
    });
    expect(extractBlockingComments(pr)).toHaveLength(0);
  });

  it('INCLUDES non-authoritative comments when they contain urgency keywords', () => {
    const pr = makePrNode({
      comments: {
        nodes: [{
          author: { login: 'contributor1', __typename: 'User' },
          authorAssociation: 'CONTRIBUTOR',
          body: 'Warning: ⚠️ this will break production!',
          createdAt: '2026-04-10T12:00:00Z',
          viewerDidAuthor: false,
        }],
      },
    });
    const blocking = extractBlockingComments(pr);
    expect(blocking).toHaveLength(1);
    expect(blocking[0].author).toBe('contributor1');
  });

  it('excludes comments older than last push', () => {
    const pr = makePrNode({
      commits: {
        nodes: [{
          commit: {
            committedDate: '2026-04-10T12:00:00Z',
            statusCheckRollup: { contexts: { nodes: [] } },
          },
        }],
      },
      comments: {
        nodes: [{
          author: { login: 'maintainer1', __typename: 'User' },
          authorAssociation: 'MEMBER',
          body: 'Old feedback from before the fix.',
          createdAt: '2026-04-10T10:00:00Z',
          viewerDidAuthor: false,
        }],
      },
    });
    expect(extractBlockingComments(pr)).toHaveLength(0);
  });

  it('matches each urgency keyword independently', () => {
    for (const body of [
      "Please don't merge this yet.",
      'This is blocking other work.',
      'It will break the deploy.',
      '⚠️ attention',
    ]) {
      const pr = makePrNode({
        comments: {
          nodes: [{
            author: { login: 'anyone', __typename: 'User' },
            authorAssociation: 'NONE',
            body,
            createdAt: '2026-04-10T12:00:00Z',
            viewerDidAuthor: false,
          }],
        },
      });
      const blocking = extractBlockingComments(pr);
      expect(blocking, `body=${JSON.stringify(body)}`).toHaveLength(1);
    }
  });

  it('returns empty when PR has no comments', () => {
    const pr = makePrNode({ comments: { nodes: [] } });
    expect(extractBlockingComments(pr)).toEqual([]);
  });

  it('uses updatedAt as last-push fallback when committedDate is missing', () => {
    const pr = makePrNode({
      updatedAt: '2026-04-10T00:00:00Z',
      commits: {
        nodes: [{
          commit: {
            committedDate: null,
            statusCheckRollup: { contexts: { nodes: [] } },
          },
        }],
      },
      comments: {
        nodes: [{
          author: { login: 'maintainer1', __typename: 'User' },
          authorAssociation: 'OWNER',
          body: 'After-push feedback',
          createdAt: '2026-04-10T12:00:00Z',
          viewerDidAuthor: false,
        }],
      },
    });
    expect(extractBlockingComments(pr)).toHaveLength(1);
  });

  // ── QUA-472 — skip patrol's own self-authored markers ───────────────────
  //
  // Before this fix, patrol's own event comments ("🤖 **PR Patrol** —
  // Attempting fix for: ...") and status panels ("<!-- pr-patrol-status
  // -->") were authored under an OWNER token and therefore passed the
  // authority filter in Filter 2 above. On the next cycle, detectIssues()
  // saw those as blocking → self-authored-feedback → infinite loop of
  // posting "Attempting fix for: self-authored-feedback" comments.
  //
  // Regression guard: any comment starting with the patrol emoji+bold
  // prefix OR containing the hidden HTML marker must be filtered out, even
  // when posted by an OWNER/MEMBER/COLLABORATOR.
  describe('QUA-472 self-feedback loop — skips patrol-authored markers', () => {
    const MARKER_BODIES = [
      // Event comments (buildXxxComment builders in crux/pr-patrol/comments.ts)
      '\u{1F916} **PR Patrol** \u{2014} Attempting fix for: bot-review-major',
      '\u{1F916} **PR Patrol** \u{2014} Fix attempt complete (42s, 10 max turns, model: sonnet).',
      '\u{1F916} **PR Patrol** \u{2014} Added to the merge queue. GitHub will run CI and merge automatically.',
      '\u{1F916} **PR Patrol** \u{2014} Failed to add to merge queue: HTTP 500',
      '\u{1F916} **PR Patrol** \u{2014} Abandoning after 3 failed fix attempts. Escalating to coordinator (Opus).',
      '\u{1F916} **PR Patrol** \u{2014} Fix attempt timed out after 30m (attempt 2).',
      '\u{1F916} **PR Patrol** \u{2014} Agent determined this issue needs escalation to coordinator (Opus) (no code changes made).',
      '\u{1F916} **PR Patrol** \u{2014} Stuck for 5 consecutive cycles without signal change. Escalating to coordinator (Opus).',
      // Status panel body (marker is on its own first line, then the title)
      '<!-- pr-patrol-status -->\n\u{1F916} **PR Patrol Status**\n\n| Check | Status |',
    ];

    for (const body of MARKER_BODIES) {
      it(`skips OWNER-authored patrol marker: ${body.slice(0, 60).replace(/\n/g, '\\n')}...`, () => {
        const pr = makePrNode({
          comments: {
            nodes: [{
              author: { login: 'OAGr', __typename: 'User' },
              authorAssociation: 'OWNER',
              body,
              createdAt: '2026-04-10T12:00:00Z',
              viewerDidAuthor: true,
            }],
          },
        });
        expect(extractBlockingComments(pr)).toEqual([]);
      });
    }

    it('still returns real OWNER blocking comments alongside patrol markers', () => {
      // The core regression scenario: three comments from an OWNER, only
      // the human one should come back.
      const pr = makePrNode({
        comments: {
          nodes: [
            {
              author: { login: 'OAGr', __typename: 'User' },
              authorAssociation: 'OWNER',
              body: '\u{1F916} **PR Patrol** \u{2014} Attempting fix for: bot-review-major',
              createdAt: '2026-04-10T12:00:00Z',
              viewerDidAuthor: true,
            },
            {
              author: { login: 'OAGr', __typename: 'User' },
              authorAssociation: 'OWNER',
              body: '<!-- pr-patrol-status -->\n\u{1F916} **PR Patrol Status**\n\nStage: merging',
              createdAt: '2026-04-10T12:01:00Z',
              viewerDidAuthor: true,
            },
            {
              author: { login: 'OAGr', __typename: 'User' },
              authorAssociation: 'OWNER',
              body: '\u26A0\uFE0F This will break prod — please hold off',
              createdAt: '2026-04-10T12:02:00Z',
              viewerDidAuthor: true,
            },
          ],
        },
      });
      const blocking = extractBlockingComments(pr);
      expect(blocking).toHaveLength(1);
      expect(blocking[0].author).toBe('OAGr');
      expect(blocking[0].body).toContain('will break prod');
    });
  });
});

// ── isSelfAuthored ───────────────────────────────────────────────────────────

describe('isSelfAuthored', () => {
  it('returns true for claude/ branches', () => {
    expect(isSelfAuthored(makePrNode({ headRefName: 'claude/qua-285-foo' }))).toBe(true);
  });

  it('returns false for feature/ branches', () => {
    expect(isSelfAuthored(makePrNode({ headRefName: 'feature/user-facing' }))).toBe(false);
  });

  it('returns false for empty branch', () => {
    expect(isSelfAuthored(makePrNode({ headRefName: '' }))).toBe(false);
  });
});

// ── diffCheckRunsVsRollup ────────────────────────────────────────────────────

describe('diffCheckRunsVsRollup', () => {
  it('flags a check where fresh says success but rollup says failure', () => {
    const fresh: FreshCheckRun[] = [
      { name: 'build', status: 'completed', conclusion: 'success' },
    ];
    const rollup = [{ name: 'build', conclusion: 'FAILURE' }];
    const diff = diffCheckRunsVsRollup(fresh, rollup);
    expect(diff).toContain('build');
  });

  it('returns empty when checks agree regardless of case (normalizes rollup UPPERCASE)', () => {
    // GraphQL rollup returns UPPERCASE conclusions; REST check-runs return
    // lowercase. The diff function must normalize both to avoid flagging
    // every single check as disagreeing.
    const fresh: FreshCheckRun[] = [
      { name: 'build', status: 'completed', conclusion: 'success' },
    ];
    const rollupUpper = [{ name: 'build', conclusion: 'SUCCESS' }];
    expect(diffCheckRunsVsRollup(fresh, rollupUpper)).toEqual([]);
  });

  it('returns empty when both sides use lowercase and agree', () => {
    const fresh: FreshCheckRun[] = [
      { name: 'build', status: 'completed', conclusion: 'success' },
    ];
    const rollup = [{ name: 'build', conclusion: 'success' }];
    expect(diffCheckRunsVsRollup(fresh, rollup)).toEqual([]);
  });

  it('ignores checks present in rollup but not in fresh', () => {
    const fresh: FreshCheckRun[] = [];
    const rollup = [{ name: 'build', conclusion: 'failure' }];
    expect(diffCheckRunsVsRollup(fresh, rollup)).toEqual([]);
  });

  it('uses context when name is absent', () => {
    const fresh: FreshCheckRun[] = [
      { name: 'ci/circleci', status: 'completed', conclusion: 'success' },
    ];
    const rollup = [{ context: 'ci/circleci', state: 'FAILURE' }];
    const diff = diffCheckRunsVsRollup(fresh, rollup);
    expect(diff).toContain('ci/circleci');
  });

  it('treats null conclusion (check still running) differently from concluded success', () => {
    const fresh: FreshCheckRun[] = [
      { name: 'build', status: 'in_progress', conclusion: null },
    ];
    const rollup = [{ name: 'build', conclusion: 'SUCCESS' }];
    const diff = diffCheckRunsVsRollup(fresh, rollup);
    expect(diff).toContain('build');
  });
});

// ── detectIssues — merge-blocked / self-authored-feedback / fresh data ───────

describe('detectIssues — merge state status', () => {
  it('emits merge-blocked (NOT conflict) for BLOCKED state even if mergeable is MERGEABLE', () => {
    const pr = makePrNode({
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BLOCKED',
    });
    const { issues } = detectIssues(pr, 0);
    expect(issues).toContain('merge-blocked');
    expect(issues).not.toContain('conflict');
  });

  it('emits conflict (NOT merge-blocked) for CONFLICTING/DIRTY', () => {
    const prA = makePrNode({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
    expect(detectIssues(prA, 0).issues).toContain('conflict');
    expect(detectIssues(prA, 0).issues).not.toContain('merge-blocked');
  });

  it('does NOT emit conflict for BEHIND state (rebase handles it)', () => {
    const pr = makePrNode({
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BEHIND',
    });
    const { issues } = detectIssues(pr, 0);
    expect(issues).not.toContain('conflict');
    expect(issues).not.toContain('merge-blocked');
  });
});

describe('detectIssues — self-authored feedback', () => {
  it('emits self-authored-feedback when agent PR has a blocking maintainer comment', () => {
    const pr = makePrNode({
      headRefName: 'claude/qua-285-foo',
      comments: {
        nodes: [{
          author: { login: 'maintainer1', __typename: 'User' },
          authorAssociation: 'MEMBER',
          body: 'Please revert this change.',
          createdAt: '2026-04-10T12:00:00Z',
          viewerDidAuthor: false,
        }],
      },
    });
    const { issues, blockingComments } = detectIssues(pr, 0);
    expect(issues).toContain('self-authored-feedback');
    expect(blockingComments).toHaveLength(1);
  });

  it('does NOT emit self-authored-feedback for human-authored PRs with same feedback', () => {
    const pr = makePrNode({
      headRefName: 'feature/human-work',
      comments: {
        nodes: [{
          author: { login: 'maintainer1', __typename: 'User' },
          authorAssociation: 'MEMBER',
          body: 'Please revert this change.',
          createdAt: '2026-04-10T12:00:00Z',
          viewerDidAuthor: false,
        }],
      },
    });
    const { issues } = detectIssues(pr, 0);
    expect(issues).not.toContain('self-authored-feedback');
  });

  it('does NOT emit self-authored-feedback when there are no blocking comments', () => {
    const pr = makePrNode({ headRefName: 'claude/qua-285-foo' });
    const { issues } = detectIssues(pr, 0);
    expect(issues).not.toContain('self-authored-feedback');
  });
});

describe('detectIssues — fresh check-runs override stale rollup', () => {
  it('suppresses ci-failure when rollup says FAILURE but fresh check-runs all SUCCEED', () => {
    const pr = makePrNode({
      commits: {
        nodes: [{
          commit: {
            committedDate: '2026-04-10T00:00:00Z',
            statusCheckRollup: { contexts: { nodes: [{ name: 'build', conclusion: 'FAILURE' }] } },
          },
        }],
      },
    });
    const fresh: FreshCheckRun[] = [
      { name: 'build', status: 'completed', conclusion: 'success' },
    ];
    const { issues } = detectIssues(pr, 0, fresh);
    expect(issues).not.toContain('ci-failure');
  });

  it('still emits ci-failure when fresh check-runs ALSO show failure', () => {
    const pr = makePrNode({
      commits: {
        nodes: [{
          commit: {
            committedDate: '2026-04-10T00:00:00Z',
            statusCheckRollup: { contexts: { nodes: [{ name: 'build', conclusion: 'FAILURE' }] } },
          },
        }],
      },
    });
    const fresh: FreshCheckRun[] = [
      { name: 'build', status: 'completed', conclusion: 'failure' },
    ];
    const { issues } = detectIssues(pr, 0, fresh);
    expect(issues).toContain('ci-failure');
  });

  it('falls back to rollup when freshCheckRuns is empty (no fresh data available)', () => {
    const pr = makePrNode({
      commits: {
        nodes: [{
          commit: {
            committedDate: '2026-04-10T00:00:00Z',
            statusCheckRollup: { contexts: { nodes: [{ name: 'build', conclusion: 'FAILURE' }] } },
          },
        }],
      },
    });
    const { issues } = detectIssues(pr, 0, []);
    expect(issues).toContain('ci-failure');
  });

  it('does NOT suppress ci-failure when fresh misses a failing rollup check', () => {
    // Rollup reports a Vercel StatusContext failure which doesn't appear in
    // REST check-runs. We must not silently drop that failure just because
    // fresh contains an unrelated successful check.
    const pr = makePrNode({
      commits: {
        nodes: [{
          commit: {
            committedDate: '2026-04-10T00:00:00Z',
            statusCheckRollup: { contexts: { nodes: [
              { context: 'vercel', state: 'FAILURE' },
              { name: 'build', conclusion: 'SUCCESS' },
            ] } },
          },
        }],
      },
    });
    const fresh: FreshCheckRun[] = [
      { name: 'build', status: 'completed', conclusion: 'success' },
    ];
    const { issues } = detectIssues(pr, 0, fresh);
    expect(issues).toContain('ci-failure');
  });
});

// ── fetchFreshCheckRuns ──────────────────────────────────────────────────────

describe('fetchFreshCheckRuns (caching + ETag)', () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.GITHUB_TOKEN;

  beforeEach(() => {
    _resetFreshCheckRunsCache();
    process.env.GITHUB_TOKEN = 'test-token';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalToken;
  });

  it('parses successful response and returns check-runs', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          total_count: 1,
          check_runs: [{ name: 'build', status: 'completed', conclusion: 'success', html_url: 'http://x' }],
        }),
        { status: 200, headers: { etag: '"abc"' } },
      ),
    ) as typeof fetch;

    const runs = await fetchFreshCheckRuns('o', 'r', 'sha1');
    expect(runs).toEqual([
      { name: 'build', status: 'completed', conclusion: 'success', htmlUrl: 'http://x' },
    ]);
  });

  it('returns cached data on 304 Not Modified', async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(
          JSON.stringify({ total_count: 1, check_runs: [{ name: 'build', status: 'completed', conclusion: 'success' }] }),
          { status: 200, headers: { etag: '"cached-etag"' } },
        );
      }
      return new Response(null, { status: 304 });
    }) as typeof fetch;

    const first = await fetchFreshCheckRuns('o', 'r', 'sha1');
    const second = await fetchFreshCheckRuns('o', 'r', 'sha1');
    expect(first).toEqual(second);
    expect(second[0].name).toBe('build');
    expect(callCount).toBe(2);
  });

  it('sends If-None-Match header on second call when etag is cached', async () => {
    const seen: Array<Record<string, string>> = [];
    globalThis.fetch = vi.fn(async (_url, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      seen.push({ ...(headers ?? {}) });
      return new Response(
        JSON.stringify({ total_count: 0, check_runs: [] }),
        { status: 200, headers: { etag: '"etag-1"' } },
      );
    }) as typeof fetch;

    await fetchFreshCheckRuns('o', 'r', 'sha1');
    await fetchFreshCheckRuns('o', 'r', 'sha1');
    expect(seen[0]['If-None-Match']).toBeUndefined();
    expect(seen[1]['If-None-Match']).toBe('"etag-1"');
  });

  it('returns empty array on fetch error when no cache exists', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as typeof fetch;

    const runs = await fetchFreshCheckRuns('o', 'r', 'never-seen-sha');
    expect(runs).toEqual([]);
  });

  it('returns cached data on fetch error when cache exists', async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            total_count: 1,
            check_runs: [{ name: 'build', status: 'completed', conclusion: 'success' }],
          }),
          { status: 200, headers: { etag: '"e"' } },
        );
      }
      throw new Error('temporary outage');
    }) as typeof fetch;

    const first = await fetchFreshCheckRuns('o', 'r', 'sha1');
    const second = await fetchFreshCheckRuns('o', 'r', 'sha1');
    expect(first).toEqual(second);
    expect(second[0].name).toBe('build');
  });

  it('returns empty for blank sha', async () => {
    globalThis.fetch = vi.fn(async () => new Response('', { status: 500 })) as typeof fetch;
    expect(await fetchFreshCheckRuns('o', 'r', '')).toEqual([]);
  });
});
