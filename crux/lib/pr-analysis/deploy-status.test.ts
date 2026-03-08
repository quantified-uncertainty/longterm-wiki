import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../github.ts', () => ({
  githubApi: vi.fn(),
  REPO: 'test/repo',
}));

import { checkDeployHealth } from './deploy-status.ts';
import { githubApi } from '../github.ts';

const mockApi = vi.mocked(githubApi);

afterEach(() => vi.resetAllMocks());

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    status: 'completed',
    conclusion: 'success',
    created_at: '2026-03-06T10:00:00Z',
    head_sha: 'abc123',
    html_url: 'https://github.com/test/repo/actions/runs/1',
    ...overrides,
  };
}

describe('checkDeployHealth', () => {
  it('returns healthy when latest run succeeded', async () => {
    mockApi.mockResolvedValueOnce({
      workflow_runs: [makeRun()],
      total_count: 1,
    });
    const result = await checkDeployHealth('test/repo');
    expect(result.healthy).toBe(true);
    expect(result.lastDeploy?.status).toBe('success');
    expect(result.failingSince).toBeNull();
  });

  it('returns unhealthy when latest run failed', async () => {
    mockApi.mockResolvedValueOnce({
      workflow_runs: [
        makeRun({ id: 2, conclusion: 'failure', created_at: '2026-03-06T12:00:00Z', head_sha: 'def456' }),
        makeRun({ id: 1, conclusion: 'success', created_at: '2026-03-06T10:00:00Z' }),
      ],
      total_count: 2,
    });
    const result = await checkDeployHealth('test/repo');
    expect(result.healthy).toBe(false);
    expect(result.lastDeploy?.status).toBe('failure');
    expect(result.failingSince).toBe('2026-03-06T12:00:00Z');
  });

  it('returns healthy with null lastDeploy when no runs exist', async () => {
    mockApi.mockResolvedValueOnce({ workflow_runs: [], total_count: 0 });
    const result = await checkDeployHealth('test/repo');
    expect(result.healthy).toBe(true);
    expect(result.lastDeploy).toBeNull();
  });

  it('returns healthy when API call fails (fail-open)', async () => {
    mockApi.mockRejectedValueOnce(new Error('Network error'));
    const result = await checkDeployHealth('test/repo');
    expect(result.healthy).toBe(true);
    expect(result.lastDeploy).toBeNull();
  });

  it('identifies failingSince from consecutive failures', async () => {
    mockApi.mockResolvedValueOnce({
      workflow_runs: [
        makeRun({ id: 3, conclusion: 'failure', created_at: '2026-03-06T14:00:00Z', head_sha: 'ghi789' }),
        makeRun({ id: 2, conclusion: 'failure', created_at: '2026-03-06T12:00:00Z', head_sha: 'def456' }),
        makeRun({ id: 1, conclusion: 'success', created_at: '2026-03-06T10:00:00Z' }),
      ],
      total_count: 3,
    });
    const result = await checkDeployHealth('test/repo');
    expect(result.healthy).toBe(false);
    // failingSince should be the earliest consecutive failure
    expect(result.failingSince).toBe('2026-03-06T12:00:00Z');
  });
});
