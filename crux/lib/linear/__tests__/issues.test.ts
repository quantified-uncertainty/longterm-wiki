import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getIssue,
  getComments,
  updateIssueState,
  commentOnIssue,
  createIssue,
  searchIssues,
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
                },
                {
                  identifier: 'QUA-2',
                  title: 'Second',
                  priority: 3,
                  state: { name: 'Todo', type: 'unstarted' },
                  url: 'u2',
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
