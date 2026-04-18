/**
 * Tests for the Linear issue-state cache used by `crux sys agents status`.
 * Verifies: (1) cache hits within the 60s TTL skip the API, (2) stale
 * entries are refetched, (3) API failures fail open without throwing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const { linearGraphQLMock } = vi.hoisted(() => ({
  linearGraphQLMock: vi.fn(),
}));

vi.mock('./client.ts', () => ({
  linearGraphQL: linearGraphQLMock,
  linearIssueUrl: (id: string) => `https://linear.app/test/issue/${id}`,
}));

// Reroute the cache file into a temporary directory for each test so that
// the developer's real `~/.cache/crux-linear/` is never touched.
let tempCacheDir: string;
let tempCacheFile: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    homedir: () => tempCacheDir,
  };
});

const originalApiKey = process.env.LINEAR_API_KEY;

describe('getIssueStates', () => {
  beforeEach(() => {
    tempCacheDir = mkdtempSync(join(tmpdir(), 'crux-linear-test-'));
    tempCacheFile = join(tempCacheDir, '.cache', 'crux-linear', 'issue-states.json');
    linearGraphQLMock.mockReset();
    process.env.LINEAR_API_KEY = 'test-key';
  });

  afterEach(() => {
    rmSync(tempCacheDir, { recursive: true, force: true });
    vi.resetModules();
    if (originalApiKey === undefined) {
      delete process.env.LINEAR_API_KEY;
    } else {
      process.env.LINEAR_API_KEY = originalApiKey;
    }
  });

  it('returns an empty map for no identifiers without hitting the API', async () => {
    const mod = await import('./issue-states-cache.ts');
    const result = await mod.getIssueStates([]);
    expect(result.size).toBe(0);
    expect(linearGraphQLMock).not.toHaveBeenCalled();
  });

  it('batch-fetches states and caches them to disk', async () => {
    linearGraphQLMock.mockResolvedValueOnce({
      i0: { identifier: 'QUA-1', state: { name: 'In Progress' } },
      i1: { identifier: 'QUA-2', state: { name: 'Done' } },
    });
    const mod = await import('./issue-states-cache.ts');
    const result = await mod.getIssueStates(['QUA-1', 'QUA-2'], 1_000_000);
    expect(result.get('QUA-1')).toBe('In Progress');
    expect(result.get('QUA-2')).toBe('Done');
    expect(linearGraphQLMock).toHaveBeenCalledTimes(1);
    const [query] = linearGraphQLMock.mock.calls[0];
    expect(query).toContain('i0: issue(id: "QUA-1")');
    expect(query).toContain('i1: issue(id: "QUA-2")');
    expect(existsSync(tempCacheFile)).toBe(true);
    const cached = JSON.parse(readFileSync(tempCacheFile, 'utf-8'));
    expect(cached['QUA-1']).toMatchObject({ state: 'In Progress', fetchedAt: 1_000_000 });
  });

  it('maps results by response identifier field (not by alias position)', async () => {
    linearGraphQLMock.mockResolvedValueOnce({
      i0: { identifier: 'QUA-2', state: { name: 'Done' } },
      i1: { identifier: 'QUA-1', state: { name: 'In Progress' } },
    });
    const mod = await import('./issue-states-cache.ts');
    const result = await mod.getIssueStates(['QUA-1', 'QUA-2'], 1_000_000);
    expect(result.get('QUA-1')).toBe('In Progress');
    expect(result.get('QUA-2')).toBe('Done');
  });

  it('serves from cache within the 60s TTL without hitting the API', async () => {
    // Seed cache file with a fresh entry.
    mkdirSync(join(tempCacheDir, '.cache', 'crux-linear'), { recursive: true });
    writeFileSync(
      tempCacheFile,
      JSON.stringify({ 'QUA-7': { state: 'Todo', fetchedAt: 1_000_000 } }),
    );
    const mod = await import('./issue-states-cache.ts');
    // 30s later — still within TTL.
    const result = await mod.getIssueStates(['QUA-7'], 1_030_000);
    expect(result.get('QUA-7')).toBe('Todo');
    expect(linearGraphQLMock).not.toHaveBeenCalled();
  });

  it('refetches stale entries past the 60s TTL', async () => {
    mkdirSync(join(tempCacheDir, '.cache', 'crux-linear'), { recursive: true });
    writeFileSync(
      tempCacheFile,
      JSON.stringify({ 'QUA-7': { state: 'Todo', fetchedAt: 1_000_000 } }),
    );
    linearGraphQLMock.mockResolvedValueOnce({
      i0: { identifier: 'QUA-7', state: { name: 'In Progress' } },
    });
    const mod = await import('./issue-states-cache.ts');
    const result = await mod.getIssueStates(['QUA-7'], 1_061_000);
    expect(result.get('QUA-7')).toBe('In Progress');
    expect(linearGraphQLMock).toHaveBeenCalledTimes(1);
  });

  it('drops entries with a malformed state field when reading cache', async () => {
    mkdirSync(join(tempCacheDir, '.cache', 'crux-linear'), { recursive: true });
    writeFileSync(
      tempCacheFile,
      JSON.stringify({ 'QUA-1': { state: { bad: 'object' }, fetchedAt: 1_000_000 } }),
    );
    linearGraphQLMock.mockResolvedValueOnce({
      i0: { identifier: 'QUA-1', state: { name: 'Done' } },
    });
    const mod = await import('./issue-states-cache.ts');
    const result = await mod.getIssueStates(['QUA-1'], 1_030_000);
    expect(result.get('QUA-1')).toBe('Done');
    expect(linearGraphQLMock).toHaveBeenCalledTimes(1);
  });

  it('fails open and returns cached values when the API throws', async () => {
    mkdirSync(join(tempCacheDir, '.cache', 'crux-linear'), { recursive: true });
    writeFileSync(
      tempCacheFile,
      JSON.stringify({ 'QUA-1': { state: 'Done', fetchedAt: 1_000_000 } }),
    );
    linearGraphQLMock.mockRejectedValueOnce(new Error('Linear unreachable'));
    const mod = await import('./issue-states-cache.ts');
    // QUA-1 is fresh (from cache), QUA-2 needs fetching (API fails).
    const result = await mod.getIssueStates(['QUA-1', 'QUA-2'], 1_030_000);
    expect(result.get('QUA-1')).toBe('Done');
    expect(result.has('QUA-2')).toBe(false);
  });

  it('deduplicates identifiers before fetching', async () => {
    linearGraphQLMock.mockResolvedValueOnce({
      i0: { identifier: 'QUA-5', state: { name: 'In Review' } },
    });
    const mod = await import('./issue-states-cache.ts');
    const result = await mod.getIssueStates(['QUA-5', 'QUA-5', 'QUA-5'], 1_000_000);
    expect(result.get('QUA-5')).toBe('In Review');
    expect(linearGraphQLMock).toHaveBeenCalledTimes(1);
    const [query] = linearGraphQLMock.mock.calls[0];
    expect((query.match(/issue\(id: "QUA-5"\)/g) ?? []).length).toBe(1);
  });

  it('records null state when Linear returns no match for an identifier', async () => {
    linearGraphQLMock.mockResolvedValueOnce({
      i0: null,
    });
    const mod = await import('./issue-states-cache.ts');
    const result = await mod.getIssueStates(['QUA-9'], 1_000_000);
    expect(result.get('QUA-9')).toBeNull();
  });

  it('skips the fetch entirely when LINEAR_API_KEY is missing', async () => {
    delete process.env.LINEAR_API_KEY;
    const mod = await import('./issue-states-cache.ts');
    const result = await mod.getIssueStates(['QUA-1'], 1_000_000);
    expect(result.has('QUA-1')).toBe(false);
    expect(linearGraphQLMock).not.toHaveBeenCalled();
  });

  it('refuses to interpolate malformed Linear IDs into the query', async () => {
    const mod = await import('./issue-states-cache.ts');
    await expect(
      mod.fetchIssueStatesBatch(['QUA-1; DROP TABLE issues'] as string[]),
    ).rejects.toThrow(/malformed Linear ID/);
  });
});
