import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../github.ts', () => ({
  githubApi: vi.fn(),
  REPO: 'test/repo',
}));

import { checkMainBranch, findRecentMerges } from './ci-status.ts';
import { githubApi } from '../github.ts';

const mockApi = vi.mocked(githubApi);

afterEach(() => vi.resetAllMocks());

describe('checkMainBranch', () => {
  it('returns not-red when latest run succeeded', async () => {
    mockApi.mockResolvedValueOnce({
      workflow_runs: [
        { id: 1, status: 'completed', conclusion: 'success', created_at: '2026-03-06T10:00:00Z', head_sha: 'abc', html_url: '' },
      ],
    });
    const result = await checkMainBranch('test/repo');
    expect(result.isRed).toBe(false);
    expect(result.lastGreenSha).toBeUndefined();
  });

  it('returns red with lastGreenSha when latest run failed', async () => {
    mockApi.mockResolvedValueOnce({
      workflow_runs: [
        { id: 2, status: 'completed', conclusion: 'failure', created_at: '2026-03-06T12:00:00Z', head_sha: 'bad', html_url: 'https://run/2' },
        { id: 1, status: 'completed', conclusion: 'success', created_at: '2026-03-06T10:00:00Z', head_sha: 'good', html_url: 'https://run/1' },
      ],
    });
    const result = await checkMainBranch('test/repo');
    expect(result.isRed).toBe(true);
    expect(result.lastGreenSha).toBe('good');
    expect(result.lastGreenAt).toBe('2026-03-06T10:00:00Z');
  });

  it('returns red without lastGreen when all runs failed', async () => {
    mockApi.mockResolvedValueOnce({
      workflow_runs: [
        { id: 2, status: 'completed', conclusion: 'failure', created_at: '2026-03-06T12:00:00Z', head_sha: 'bad2', html_url: '' },
        { id: 1, status: 'completed', conclusion: 'failure', created_at: '2026-03-06T10:00:00Z', head_sha: 'bad1', html_url: '' },
      ],
    });
    const result = await checkMainBranch('test/repo');
    expect(result.isRed).toBe(true);
    expect(result.lastGreenSha).toBeUndefined();
    expect(result.lastGreenAt).toBeUndefined();
  });

  it('returns not-red when API fails (fail-open)', async () => {
    mockApi.mockRejectedValueOnce(new Error('API error'));
    const result = await checkMainBranch('test/repo');
    expect(result.isRed).toBe(false);
  });
});

describe('findRecentMerges', () => {
  it('returns empty array when since is undefined', async () => {
    const result = await findRecentMerges('test/repo', undefined);
    expect(result).toEqual([]);
    expect(mockApi).not.toHaveBeenCalled();
  });

  it('returns PRs merged after since timestamp', async () => {
    mockApi.mockResolvedValueOnce([
      { number: 100, title: 'New feature', merged_at: '2026-03-06T11:00:00Z', merge_commit_sha: 'sha1', user: { login: 'alice' } },
      { number: 99, title: 'Old fix', merged_at: '2026-03-06T09:00:00Z', merge_commit_sha: 'sha2', user: { login: 'bob' } },
      { number: 98, title: 'Not merged', merged_at: null, merge_commit_sha: null, user: { login: 'carol' } },
    ]);
    const result = await findRecentMerges('test/repo', '2026-03-06T10:00:00Z');
    expect(result).toHaveLength(1);
    expect(result[0].prNumber).toBe(100);
    expect(result[0].mergedBy).toBe('alice');
  });

  it('returns empty when API fails (fail-open)', async () => {
    mockApi.mockRejectedValueOnce(new Error('Network error'));
    const result = await findRecentMerges('test/repo', '2026-03-06T10:00:00Z');
    expect(result).toEqual([]);
  });
});
