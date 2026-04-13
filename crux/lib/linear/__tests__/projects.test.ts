import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  listProjects,
  getProject,
  updateProject,
  createProjectUpdate,
  type LinearProject,
} from '../projects.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const PROJECT_UUID = '6f9c8f44-7d33-4573-a017-a2200b8b22da';

const fixture: LinearProject = {
  id: PROJECT_UUID,
  name: 'Content Quality & Enrichment',
  description: 'Editorial workstreams.',
  content: '# Content\n\nLong-form body.',
  state: 'backlog',
  progress: 0.2,
  startDate: null,
  targetDate: '2026-05-01',
  url: 'https://linear.app/quantifieduncertainty/project/content-quality-enrichment-xyz',
  updatedAt: '2026-04-13T00:00:00Z',
  lead: null,
};

describe('projects.ts', () => {
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

  describe('listProjects', () => {
    it('returns all projects on a single page (hasNextPage=false)', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse({
          data: {
            projects: {
              nodes: [fixture, { ...fixture, id: 'other', name: 'Other' }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
      ) as unknown as typeof fetch;
      const all = await listProjects();
      expect(all).toHaveLength(2);
      expect(all[0].name).toBe('Content Quality & Enrichment');
    });

    it('exits the loop when endCursor is null even if hasNextPage is true', async () => {
      // Defensive: some GraphQL servers occasionally return hasNextPage=true
      // with a null endCursor. We treat a null cursor as the end of the stream
      // so the loop can't spin forever.
      const fetchFn = vi.fn().mockResolvedValueOnce(
        jsonResponse({
          data: {
            projects: {
              nodes: [fixture],
              pageInfo: { hasNextPage: true, endCursor: null },
            },
          },
        }),
      );
      globalThis.fetch = fetchFn as unknown as typeof fetch;
      const all = await listProjects();
      expect(all).toHaveLength(1);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('paginates across multiple pages with cursor', async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            data: {
              projects: {
                nodes: [fixture, { ...fixture, id: 'p2', name: 'Page1-B' }],
                pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
              },
            },
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            data: {
              projects: {
                nodes: [{ ...fixture, id: 'p3', name: 'Page2-A' }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
        );
      globalThis.fetch = fetchFn as unknown as typeof fetch;

      const all = await listProjects();
      expect(all).toHaveLength(3);
      expect(all.map((p) => p.name)).toEqual([
        'Content Quality & Enrichment',
        'Page1-B',
        'Page2-A',
      ]);
      expect(fetchFn).toHaveBeenCalledTimes(2);

      // First call: after=null; second call: after="cursor-1".
      const firstBody = JSON.parse(fetchFn.mock.calls[0][1].body);
      const secondBody = JSON.parse(fetchFn.mock.calls[1][1].body);
      expect(firstBody.variables.after).toBeNull();
      expect(secondBody.variables.after).toBe('cursor-1');
    });
  });

  describe('getProject', () => {
    it('fetches by UUID', async () => {
      const fetchFn = vi.fn().mockResolvedValue(
        jsonResponse({ data: { project: fixture } }),
      );
      globalThis.fetch = fetchFn as unknown as typeof fetch;
      const p = await getProject(PROJECT_UUID);
      expect(p).not.toBeNull();
      expect(p!.id).toBe(PROJECT_UUID);
      // Should have called the single-project query, not the list query
      const call = fetchFn.mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.query).toContain('project(id: $id)');
    });

    it('returns null for missing UUID', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse({ errors: [{ message: 'Entity not found' }] }),
      ) as unknown as typeof fetch;
      const p = await getProject(PROJECT_UUID);
      expect(p).toBeNull();
    });

    it('falls back to case-insensitive name lookup when ref is not a UUID', async () => {
      const fetchFn = vi.fn().mockResolvedValue(
        jsonResponse({
          data: {
            projects: {
              nodes: [fixture, { ...fixture, id: 'x', name: 'Other' }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
      );
      globalThis.fetch = fetchFn as unknown as typeof fetch;
      const p = await getProject('content quality & enrichment');
      expect(p).not.toBeNull();
      expect(p!.id).toBe(PROJECT_UUID);
      // Should have called the paginated list query, not the single-project query
      const body = JSON.parse(fetchFn.mock.calls[0][1].body);
      expect(body.query).toContain('projects(');
      expect(body.query).toContain('pageInfo');
    });

    it('returns null when name does not match exactly (no substring match)', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse({
          data: { projects: { nodes: [fixture], pageInfo: { hasNextPage: false, endCursor: null } } },
        }),
      ) as unknown as typeof fetch;
      const p = await getProject('Content Quality');  // partial — must not match
      expect(p).toBeNull();
    });

    it('rejects a malformed UUID as a name lookup (falls through to list)', async () => {
      // "not-a-uuid-but-close" should not match the UUID regex → name lookup
      const fetchFn = vi.fn().mockResolvedValue(
        jsonResponse({
          data: { projects: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
        }),
      );
      globalThis.fetch = fetchFn as unknown as typeof fetch;
      const p = await getProject('not-a-uuid-but-close');
      expect(p).toBeNull();
      const body = JSON.parse(fetchFn.mock.calls[0][1].body);
      expect(body.query).toContain('projects(');
    });

    it('resolves a name that lives on a later page via pagination', async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            data: {
              projects: {
                nodes: [{ ...fixture, id: 'a', name: 'Alpha' }],
                pageInfo: { hasNextPage: true, endCursor: 'c1' },
              },
            },
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            data: {
              projects: {
                nodes: [fixture],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
        );
      globalThis.fetch = fetchFn as unknown as typeof fetch;
      const p = await getProject('Content Quality & Enrichment');
      expect(p).not.toBeNull();
      expect(p!.id).toBe(PROJECT_UUID);
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });
  });

  describe('updateProject', () => {
    it('sends a projectUpdate mutation with the input fields', async () => {
      const fetchFn = vi.fn().mockResolvedValue(
        jsonResponse({ data: { projectUpdate: { success: true, project: { ...fixture, content: 'NEW' } } } }),
      );
      globalThis.fetch = fetchFn as unknown as typeof fetch;

      const result = await updateProject(PROJECT_UUID, { content: 'NEW' });
      expect(result.content).toBe('NEW');

      const body = JSON.parse(fetchFn.mock.calls[0][1].body);
      expect(body.query).toContain('projectUpdate(');
      expect(body.variables.id).toBe(PROJECT_UUID);
      expect(body.variables.input).toEqual({ content: 'NEW' });
    });

    it('throws when the mutation reports failure', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse({ data: { projectUpdate: { success: false, project: fixture } } }),
      ) as unknown as typeof fetch;
      await expect(updateProject(PROJECT_UUID, { name: 'x' })).rejects.toThrow(/refused to update/);
    });

    it('refuses to run with a non-UUID id', async () => {
      await expect(updateProject('content-quality', { name: 'x' })).rejects.toThrow(/expected UUID/);
    });
  });

  describe('createProjectUpdate', () => {
    it('sends a projectUpdateCreate mutation', async () => {
      const fetchFn = vi.fn().mockResolvedValue(
        jsonResponse({ data: { projectUpdateCreate: { success: true } } }),
      );
      globalThis.fetch = fetchFn as unknown as typeof fetch;

      await createProjectUpdate(PROJECT_UUID, 'Shipped phase 5');
      const body = JSON.parse(fetchFn.mock.calls[0][1].body);
      expect(body.query).toContain('projectUpdateCreate(');
      expect(body.variables.input.projectId).toBe(PROJECT_UUID);
      expect(body.variables.input.body).toBe('Shipped phase 5');
    });

    it('throws on failure', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse({ data: { projectUpdateCreate: { success: false } } }),
      ) as unknown as typeof fetch;
      await expect(createProjectUpdate(PROJECT_UUID, 'x')).rejects.toThrow(/refused to create/);
    });

    it('refuses non-UUID id', async () => {
      await expect(createProjectUpdate('content-quality', 'x')).rejects.toThrow(/expected UUID/);
    });
  });

});
