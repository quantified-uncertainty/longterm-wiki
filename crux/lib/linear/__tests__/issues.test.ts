import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getIssue,
  getComments,
  updateIssue,
  updateIssueState,
  commentOnIssue,
  createIssue,
  searchIssues,
  scoreLinearIssue,
  isLinearIssueBlocked,
  rankReadyIssues,
  type ReadyIssue,
} from '../issues.ts';

// Helper: fake a fetch response with a JSON body.
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const ISSUE_UUID = '9382e839-d2c5-4ae2-8da5-7f4d892da2d6';

const fullIssueFixture = {
  id: ISSUE_UUID,
  identifier: 'QUA-184',
  title: 'Test issue',
  description: 'body',
  priority: 2,
  url: 'https://linear.app/quantifieduncertainty/issue/QUA-184',
  state: { id: 'state-1', name: 'Backlog', type: 'backlog' },
  team: { id: 'team-1', key: 'QUA' },
  parent: null,
  project: null,
  labels: { nodes: [] },
  children: { nodes: [] },
};

describe('issues.ts — transport helpers', () => {
  let originalFetch: typeof fetch;
  let originalKey: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalKey = process.env.LINEAR_API_KEY;
    process.env.LINEAR_API_KEY = 'lin_test_key';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = originalKey;
  });

  describe('getIssue', () => {
    it('returns a fully-shaped issue on happy path', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse({ data: { issue: fullIssueFixture } })
      ) as unknown as typeof fetch;

      const issue = await getIssue('QUA-184');
      expect(issue).not.toBeNull();
      expect(issue!.identifier).toBe('QUA-184');
      expect(issue!.title).toBe('Test issue');
      expect(issue!.state.name).toBe('Backlog');
      expect(issue!.id).toBe(ISSUE_UUID);
    });

    it('returns null when Linear reports entity not found', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse({
          errors: [{ message: 'Entity not found - Issue' }],
        })
      ) as unknown as typeof fetch;

      const issue = await getIssue('QUA-99999');
      expect(issue).toBeNull();
    });

    it('returns null when data.issue is null (graceful API response)', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse({ data: { issue: null } })
      ) as unknown as typeof fetch;

      const issue = await getIssue('QUA-1');
      expect(issue).toBeNull();
    });

    it('rethrows non-not-found errors', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse({ errors: [{ message: 'Authentication required' }] })
      ) as unknown as typeof fetch;

      await expect(getIssue('QUA-184')).rejects.toThrow(/Authentication/);
    });

    // QUA-481: children are surfaced in `view` output so agents reading a
    // parent epic see the existing breakdown instead of re-deriving it from
    // the description. Regression-guards the GraphQL shape.
    it('parses children nodes when present', async () => {
      const fixtureWithChildren = {
        ...fullIssueFixture,
        identifier: 'QUA-221',
        children: {
          nodes: [
            {
              identifier: 'QUA-222',
              title: 'Phase 0',
              priority: 1,
              url: 'https://linear.app/quantifieduncertainty/issue/QUA-222',
              state: { name: 'Done', type: 'completed' },
            },
            {
              identifier: 'QUA-223',
              title: 'Phase 1',
              priority: 2,
              url: 'https://linear.app/quantifieduncertainty/issue/QUA-223',
              state: { name: 'Done', type: 'completed' },
            },
            {
              identifier: 'QUA-224',
              title: 'Phase 2',
              priority: 3,
              url: 'https://linear.app/quantifieduncertainty/issue/QUA-224',
              state: { name: 'Backlog', type: 'backlog' },
            },
          ],
        },
      };
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse({ data: { issue: fixtureWithChildren } })
      ) as unknown as typeof fetch;

      const issue = await getIssue('QUA-221');
      expect(issue!.children.nodes).toHaveLength(3);
      expect(issue!.children.nodes[0].identifier).toBe('QUA-222');
      expect(issue!.children.nodes[0].state.type).toBe('completed');
      expect(issue!.children.nodes[2].state.name).toBe('Backlog');
    });

    it('requests children in the GraphQL query', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        jsonResponse({ data: { issue: fullIssueFixture } })
      );
      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      await getIssue('QUA-184');
      const [, init] = fetchSpy.mock.calls[0];
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.query).toMatch(/children\(first:\s*50\)/);
      expect(body.query).toMatch(/nodes\s*\{[^}]*identifier/);
    });
  });

  describe('getComments', () => {
    it('returns comment nodes from the API', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse({
          data: {
            issue: {
              comments: {
                nodes: [
                  {
                    id: 'c1',
                    body: 'first comment',
                    createdAt: '2026-04-10T12:00:00Z',
                    user: { name: 'Ozzie' },
                  },
                  {
                    id: 'c2',
                    body: 'second',
                    createdAt: '2026-04-10T13:00:00Z',
                    user: null,
                  },
                ],
              },
            },
          },
        })
      ) as unknown as typeof fetch;

      const comments = await getComments('QUA-184');
      expect(comments).toHaveLength(2);
      expect(comments[0].body).toBe('first comment');
      expect(comments[1].user).toBeNull();
    });

    it('returns empty array when issue has no comments', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse({ data: { issue: { comments: { nodes: [] } } } })
      ) as unknown as typeof fetch;

      const comments = await getComments('QUA-184');
      expect(comments).toEqual([]);
    });

    it('returns empty array when issue is missing', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse({ data: { issue: null } })
      ) as unknown as typeof fetch;

      const comments = await getComments('QUA-1');
      expect(comments).toEqual([]);
    });
  });

  describe('updateIssueState', () => {
    it('resolves state name to UUID and reports success', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        jsonResponse({
          data: {
            issueUpdate: {
              success: true,
              issue: { identifier: 'QUA-184', state: { name: 'In Progress' } },
            },
          },
        })
      );
      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      const r = await updateIssueState('QUA-184', 'In Progress');
      expect(r.identifier).toBe('QUA-184');
      expect(r.state).toBe('In Progress');

      // Confirm the mutation sent the canonical UUID, not the string name.
      const [, init] = fetchSpy.mock.calls[0];
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.variables.stateId).toBe('1cafee7f-1921-49d4-b603-df2bf517b296');
    });

    it('throws when Linear reports success=false', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse({
          data: {
            issueUpdate: {
              success: false,
              issue: { identifier: 'QUA-184', state: { name: 'Backlog' } },
            },
          },
        })
      ) as unknown as typeof fetch;

      await expect(updateIssueState('QUA-184', 'Done')).rejects.toThrow(
        /refused to update QUA-184/
      );
    });

    it('throws on an unknown state name before hitting the API', async () => {
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as unknown as typeof fetch;
      await expect(
        // @ts-expect-error — intentionally invalid
        updateIssueState('QUA-184', 'Pending')
      ).rejects.toThrow(/Unknown Linear workflow state/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('updateIssue', () => {
    it('sends projectId in the IssueUpdateInput', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        jsonResponse({
          data: {
            issueUpdate: {
              success: true,
              issue: { identifier: 'QUA-184' },
            },
          },
        })
      );
      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      await updateIssue('QUA-184', { projectId: 'proj-uuid-1' });
      const [, init] = fetchSpy.mock.calls[0];
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.variables.id).toBe('QUA-184');
      expect(body.variables.input).toEqual({ projectId: 'proj-uuid-1' });
    });

    it('passes null projectId through to clear the project', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        jsonResponse({
          data: { issueUpdate: { success: true, issue: { identifier: 'QUA-184' } } },
        })
      );
      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      await updateIssue('QUA-184', { projectId: null });
      const [, init] = fetchSpy.mock.calls[0];
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.variables.input.projectId).toBeNull();
    });

    it('supports priority + title + description in one call', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        jsonResponse({
          data: { issueUpdate: { success: true, issue: { identifier: 'QUA-184' } } },
        })
      );
      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      await updateIssue('QUA-184', {
        priority: 2,
        title: 'New title',
        description: 'New body',
      });
      const [, init] = fetchSpy.mock.calls[0];
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.variables.input).toEqual({
        priority: 2,
        title: 'New title',
        description: 'New body',
      });
    });

    it('throws when issueUpdate reports success=false', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse({
          data: {
            issueUpdate: { success: false, issue: { identifier: 'QUA-184' } },
          },
        })
      ) as unknown as typeof fetch;

      await expect(updateIssue('QUA-184', { priority: 1 })).rejects.toThrow(
        /refused to update QUA-184/
      );
    });
  });

  describe('commentOnIssue', () => {
    it('resolves the issue UUID first, then creates the comment', async () => {
      const fetchSpy = vi
        .fn()
        // getIssue
        .mockResolvedValueOnce(jsonResponse({ data: { issue: fullIssueFixture } }))
        // commentCreate
        .mockResolvedValueOnce(
          jsonResponse({ data: { commentCreate: { success: true } } })
        );
      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      await commentOnIssue('QUA-184', 'hello from a test');
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      // Second call is commentCreate; issueId should be the UUID, not the identifier.
      const [, init] = fetchSpy.mock.calls[1];
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.variables.input.issueId).toBe(ISSUE_UUID);
      expect(body.variables.input.body).toBe('hello from a test');
    });

    it('throws when the issue does not exist', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse({ data: { issue: null } })
      ) as unknown as typeof fetch;

      await expect(commentOnIssue('QUA-99999', 'x')).rejects.toThrow(
        /QUA-99999 not found/
      );
    });

    it('throws when commentCreate reports success=false', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ data: { issue: fullIssueFixture } }))
        .mockResolvedValueOnce(
          jsonResponse({ data: { commentCreate: { success: false } } })
        );
      globalThis.fetch = globalThis.fetch as unknown as typeof fetch;

      await expect(commentOnIssue('QUA-184', 'x')).rejects.toThrow(
        /refused to post comment/
      );
    });
  });

  describe('createIssue', () => {
    it('returns the new identifier and URL on success', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse({
          data: {
            issueCreate: {
              success: true,
              issue: {
                identifier: 'QUA-300',
                url: 'https://linear.app/quantifieduncertainty/issue/QUA-300',
              },
            },
          },
        })
      ) as unknown as typeof fetch;

      const r = await createIssue({
        title: 'Test',
        description: 'body',
        priority: 2,
      });
      expect(r.identifier).toBe('QUA-300');
      expect(r.url).toContain('QUA-300');
    });

    it('defaults to the QUA team when teamId is omitted', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        jsonResponse({
          data: {
            issueCreate: {
              success: true,
              issue: { identifier: 'QUA-301', url: 'u' },
            },
          },
        })
      );
      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      await createIssue({ title: 'T', description: 'D' });
      const [, init] = fetchSpy.mock.calls[0];
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.variables.input.teamId).toBe(
        '12392162-e1e0-4fce-95ad-a8a5d6800321'
      );
    });

    it('throws when issueCreate reports success=false', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse({
          data: {
            issueCreate: { success: false, issue: { identifier: '', url: '' } },
          },
        })
      ) as unknown as typeof fetch;

      await expect(
        createIssue({ title: 'Test', description: 'body' })
      ).rejects.toThrow(/refused to create/);
    });
  });

  describe('searchIssues', () => {
    it('returns the matching nodes', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse({
          data: {
            searchIssues: {
              nodes: [
                {
                  identifier: 'QUA-1',
                  title: 'First',
                  priority: 2,
                  state: { name: 'Backlog', type: 'backlog' },
                  url: 'u1',
                  createdAt: '2026-04-01T00:00:00.000Z',
                  updatedAt: '2026-04-01T00:00:00.000Z',
                },
                {
                  identifier: 'QUA-2',
                  title: 'Second',
                  priority: 3,
                  state: { name: 'Todo', type: 'unstarted' },
                  url: 'u2',
                  createdAt: '2026-04-02T00:00:00.000Z',
                  updatedAt: '2026-04-02T00:00:00.000Z',
                },
              ],
            },
          },
        })
      ) as unknown as typeof fetch;

      const results = await searchIssues('test');
      expect(results).toHaveLength(2);
      expect(results[0].identifier).toBe('QUA-1');
      expect(results[1].state.name).toBe('Todo');
    });

    it('applies the limit argument', async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        jsonResponse({ data: { searchIssues: { nodes: [] } } })
      );
      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      await searchIssues('anything', 7);
      const [, init] = fetchSpy.mock.calls[0];
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.variables.limit).toBe(7);
    });
  });
});

// ---------------------------------------------------------------------------
// Pure scoring / ranking helpers (no API mocking needed)
// ---------------------------------------------------------------------------

function makeReadyIssue(overrides: Partial<ReadyIssue> = {}): ReadyIssue {
  return {
    id: 'id-1',
    identifier: 'QUA-100',
    title: 'Test issue',
    description: null,
    priority: 3, // medium
    url: 'https://linear.app/quantifieduncertainty/issue/QUA-100',
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-01T00:00:00Z',
    state: { name: 'Todo', type: 'unstarted' },
    assignee: null,
    labels: { nodes: [] },
    parent: null,
    project: null,
    ...overrides,
  };
}

describe('scoreLinearIssue', () => {
  it('scores urgent higher than high higher than medium', () => {
    const urgent = scoreLinearIssue(makeReadyIssue({ priority: 1 }));
    const high = scoreLinearIssue(makeReadyIssue({ priority: 2 }));
    const medium = scoreLinearIssue(makeReadyIssue({ priority: 3 }));
    const low = scoreLinearIssue(makeReadyIssue({ priority: 4 }));
    const none = scoreLinearIssue(makeReadyIssue({ priority: 0 }));

    expect(urgent).toBeGreaterThan(high);
    expect(high).toBeGreaterThan(medium);
    expect(medium).toBeGreaterThan(low);
    expect(low).toBeGreaterThan(none);
  });

  it('applies bug label bonus', () => {
    const base = scoreLinearIssue(makeReadyIssue({ priority: 3 }));
    const withBug = scoreLinearIssue(
      makeReadyIssue({ priority: 3, labels: { nodes: [{ name: 'Bug' }] } }),
    );
    expect(withBug).toBe(base + 50);
  });

  it('applies agent-ready 1.5x multiplier', () => {
    const base = scoreLinearIssue(makeReadyIssue({ priority: 2 }));
    const ready = scoreLinearIssue(
      makeReadyIssue({ priority: 2, labels: { nodes: [{ name: 'claude-ready' }] } }),
    );
    // 500 base → 500 * 1.5 = 750. Age/recency bonuses identical.
    expect(ready).toBeGreaterThan(base);
    expect(ready - base).toBeGreaterThanOrEqual(Math.round(500 * 0.5) - 1); // ~250
  });

  it('gives recency bonus for recently updated issues', () => {
    const stale = scoreLinearIssue(
      makeReadyIssue({ updatedAt: '2025-01-01T00:00:00Z' }),
    );
    const recent = scoreLinearIssue(
      makeReadyIssue({ updatedAt: new Date().toISOString() }),
    );
    expect(recent).toBe(stale + 15);
  });

  it('gives age bonus capped at 10', () => {
    const fresh = scoreLinearIssue(
      makeReadyIssue({ createdAt: new Date().toISOString(), updatedAt: '2025-01-01T00:00:00Z' }),
    );
    const old = scoreLinearIssue(
      makeReadyIssue({ createdAt: '2020-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' }),
    );
    // Old issue should have +10 (capped), fresh issue +0
    expect(old - fresh).toBe(10);
  });
});

describe('isLinearIssueBlocked', () => {
  it('returns false for a clean issue', () => {
    expect(isLinearIssueBlocked(makeReadyIssue())).toBe(false);
  });

  it('returns true for blocked label', () => {
    expect(
      isLinearIssueBlocked(makeReadyIssue({ labels: { nodes: [{ name: 'blocked' }] } })),
    ).toBe(true);
  });

  it('returns true for waiting label', () => {
    expect(
      isLinearIssueBlocked(makeReadyIssue({ labels: { nodes: [{ name: 'waiting' }] } })),
    ).toBe(true);
  });

  it('returns true when description says "blocked by"', () => {
    expect(
      isLinearIssueBlocked(makeReadyIssue({ description: 'This is blocked by QUA-50' })),
    ).toBe(true);
  });

  it('returns true when description says "waiting for"', () => {
    expect(
      isLinearIssueBlocked(makeReadyIssue({ description: 'Waiting for upstream fix' })),
    ).toBe(true);
  });

  it('returns true when description says "depends on"', () => {
    expect(
      isLinearIssueBlocked(makeReadyIssue({ description: 'Depends on QUA-222 shipping first' })),
    ).toBe(true);
  });

  it('returns false for unrelated description content', () => {
    expect(
      isLinearIssueBlocked(makeReadyIssue({ description: 'This feature adds a new command' })),
    ).toBe(false);
  });
});

describe('rankReadyIssues', () => {
  it('sorts by score descending', () => {
    const issues = [
      makeReadyIssue({ identifier: 'QUA-1', priority: 4 }), // low
      makeReadyIssue({ identifier: 'QUA-2', priority: 1 }), // urgent
      makeReadyIssue({ identifier: 'QUA-3', priority: 3 }), // medium
    ];
    const ranked = rankReadyIssues(issues);
    expect(ranked[0].identifier).toBe('QUA-2'); // urgent first
    expect(ranked[1].identifier).toBe('QUA-3'); // then medium
    expect(ranked[2].identifier).toBe('QUA-1'); // then low
  });

  it('uses creation date as tiebreaker (oldest first)', () => {
    const issues = [
      makeReadyIssue({ identifier: 'QUA-NEW', priority: 3, createdAt: '2026-04-01T00:00:00Z' }),
      makeReadyIssue({ identifier: 'QUA-OLD', priority: 3, createdAt: '2026-01-01T00:00:00Z' }),
    ];
    const ranked = rankReadyIssues(issues);
    expect(ranked[0].identifier).toBe('QUA-OLD');
    expect(ranked[1].identifier).toBe('QUA-NEW');
  });

  it('marks blocked issues correctly', () => {
    const issues = [
      makeReadyIssue({ identifier: 'QUA-OK' }),
      makeReadyIssue({ identifier: 'QUA-BLOCKED', labels: { nodes: [{ name: 'blocked' }] } }),
    ];
    const ranked = rankReadyIssues(issues);
    const ok = ranked.find((r) => r.identifier === 'QUA-OK');
    const blocked = ranked.find((r) => r.identifier === 'QUA-BLOCKED');
    expect(ok!.blocked).toBe(false);
    expect(blocked!.blocked).toBe(true);
  });

  it('returns empty array for empty input', () => {
    expect(rankReadyIssues([])).toEqual([]);
  });
});
