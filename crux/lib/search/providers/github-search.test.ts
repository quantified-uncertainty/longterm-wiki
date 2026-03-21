import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createGitHubProvider } from './github-search.ts';

// Mock the github module
vi.mock('../../github.ts', () => ({
  getGitHubToken: vi.fn(() => 'test-token'),
  githubApi: vi.fn(),
}));

import { githubApi, getGitHubToken } from '../../github.ts';
const mockGithubApi = vi.mocked(githubApi);
const mockGetGitHubToken = vi.mocked(getGitHubToken);

describe('github-search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGitHubToken.mockReturnValue('test-token');
  });

  describe('isAvailable', () => {
    it('returns true when GITHUB_TOKEN is available', () => {
      const provider = createGitHubProvider();
      expect(provider.isAvailable()).toBe(true);
    });

    it('returns false when getGitHubToken throws', () => {
      mockGetGitHubToken.mockImplementation(() => {
        throw new Error('GITHUB_TOKEN not set');
      });
      const provider = createGitHubProvider();
      expect(provider.isAvailable()).toBe(false);
    });
  });

  describe('search', () => {
    it('searches repos for ai-model entity type', async () => {
      mockGithubApi.mockResolvedValueOnce({
        total_count: 1,
        items: [{
          full_name: 'openai/gpt-4',
          html_url: 'https://github.com/openai/gpt-4',
          description: 'GPT-4 resources',
          stargazers_count: 5000,
          language: 'Python',
          updated_at: '2024-01-01T00:00:00Z',
          topics: ['ai', 'gpt'],
        }],
      });

      const provider = createGitHubProvider();
      const results = await provider.search('GPT-4', 5, 'ai-model');

      expect(results).toHaveLength(1);
      expect(results[0].url).toBe('https://github.com/openai/gpt-4');
      expect(results[0].title).toBe('openai/gpt-4');
      expect(results[0].provider).toBe('github');
      expect(results[0].snippet).toContain('5,000 stars');
    });

    it('fetches org profile + repos for organization entity type', async () => {
      // First call: fetchOrgProfile
      mockGithubApi.mockResolvedValueOnce({
        login: 'anthropic',
        html_url: 'https://github.com/anthropic',
        description: 'AI safety company',
        public_repos: 25,
        blog: 'https://anthropic.com',
        name: 'Anthropic',
      });

      // Second call: searchOrgRepos
      mockGithubApi.mockResolvedValueOnce({
        total_count: 2,
        items: [{
          full_name: 'anthropic/claude-code',
          html_url: 'https://github.com/anthropic/claude-code',
          description: 'Claude Code CLI',
          stargazers_count: 10000,
          language: 'TypeScript',
          updated_at: '2024-01-01T00:00:00Z',
        }],
      });

      // Third call: fallback searchRepos (since we have 2 hits but maxResults=5)
      mockGithubApi.mockResolvedValueOnce({
        total_count: 1,
        items: [{
          full_name: 'anthropic/anthropic-sdk-python',
          html_url: 'https://github.com/anthropic/anthropic-sdk-python',
          description: 'Python SDK',
          stargazers_count: 5000,
          language: 'Python',
          updated_at: '2024-01-01T00:00:00Z',
        }],
      });

      const provider = createGitHubProvider();
      const results = await provider.search('Anthropic', 5, 'organization');

      expect(results.length).toBeGreaterThanOrEqual(2);
      // Org profile should be first
      expect(results[0].title).toBe('Anthropic');
      expect(results[0].url).toBe('https://github.com/anthropic');
    });

    it('detects owner/repo format for project entity type', async () => {
      // Direct repo fetch
      mockGithubApi.mockResolvedValueOnce({
        full_name: 'vercel/next.js',
        html_url: 'https://github.com/vercel/next.js',
        description: 'The React Framework',
        stargazers_count: 120000,
        language: 'JavaScript',
        updated_at: '2024-01-01T00:00:00Z',
      });

      // Repo search (supplementary)
      mockGithubApi.mockResolvedValueOnce({
        total_count: 0,
        items: [],
      });

      const provider = createGitHubProvider();
      const results = await provider.search('vercel/next.js', 5, 'project');

      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('vercel/next.js');
    });

    it('handles API error gracefully for org fetch', async () => {
      // fetchOrgProfile fails
      mockGithubApi.mockRejectedValueOnce(new Error('Not Found'));

      // searchOrgRepos fails
      mockGithubApi.mockRejectedValueOnce(new Error('Not Found'));

      // Falls back to general search
      mockGithubApi.mockResolvedValueOnce({
        total_count: 1,
        items: [{
          full_name: 'some/repo',
          html_url: 'https://github.com/some/repo',
          description: 'A repo',
          stargazers_count: 100,
          language: 'Go',
          updated_at: '2024-01-01T00:00:00Z',
        }],
      });

      const provider = createGitHubProvider();
      const results = await provider.search('NonexistentOrg', 5, 'organization');

      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('returns empty array when search returns no results', async () => {
      mockGithubApi.mockResolvedValueOnce({
        total_count: 0,
        items: [],
      });

      const provider = createGitHubProvider();
      const results = await provider.search('completely-nonexistent-project-xyz', 5, 'benchmark');

      expect(results).toEqual([]);
    });

    it('respects maxResults limit', async () => {
      mockGithubApi.mockResolvedValueOnce({
        total_count: 10,
        items: Array.from({ length: 10 }, (_, i) => ({
          full_name: `owner/repo-${i}`,
          html_url: `https://github.com/owner/repo-${i}`,
          description: `Repo ${i}`,
          stargazers_count: 100 - i,
          language: 'TypeScript',
          updated_at: '2024-01-01T00:00:00Z',
        })),
      });

      const provider = createGitHubProvider();
      const results = await provider.search('test', 3, 'ai-model');

      expect(results).toHaveLength(3);
    });
  });
});
