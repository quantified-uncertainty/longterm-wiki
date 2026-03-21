/**
 * GitHub Search Provider — discovers repositories and organization data.
 *
 * Uses the GitHub REST API via shared `githubApi()` (auth, corruption detection).
 * Activated for organization, project, ai-model, and benchmark entity types.
 *
 * Rate limit: GitHub Search API allows 30 requests/minute for authenticated users.
 * We use a simple per-minute counter to avoid hitting the limit.
 */

import { githubApi, getGitHubToken } from '../../github.ts';
import type { SearchProvider, SearchHit } from './types.ts';

// ---------------------------------------------------------------------------
// GitHub API response types
// ---------------------------------------------------------------------------

interface GitHubRepo {
  full_name: string;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  language: string | null;
  updated_at: string;
  topics?: string[];
}

interface GitHubSearchReposResponse {
  total_count: number;
  items: GitHubRepo[];
}

interface GitHubOrg {
  login: string;
  html_url: string;
  description: string | null;
  public_repos: number;
  blog: string | null;
  name: string | null;
}

interface GitHubUser {
  login: string;
  html_url: string;
  bio: string | null;
  public_repos: number;
  name: string | null;
  type: string;
}

interface GitHubSearchUsersResponse {
  total_count: number;
  items: GitHubUser[];
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

let requestTimestamps: number[] = [];
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_MINUTE = 25; // Leave headroom below the 30/min limit

function checkRateLimit(): boolean {
  const now = Date.now();
  requestTimestamps = requestTimestamps.filter(ts => now - ts < RATE_LIMIT_WINDOW_MS);
  return requestTimestamps.length < MAX_REQUESTS_PER_MINUTE;
}

function recordRequest(): void {
  requestTimestamps.push(Date.now());
}

// ---------------------------------------------------------------------------
// Search strategies by entity type
// ---------------------------------------------------------------------------

async function searchRepos(query: string, maxResults: number): Promise<SearchHit[]> {
  if (!checkRateLimit()) {
    console.warn('[github-search] Rate limit approaching, skipping search');
    return [];
  }
  recordRequest();

  const encodedQuery = encodeURIComponent(query);
  const data = await githubApi<GitHubSearchReposResponse>(
    `/search/repositories?q=${encodedQuery}&sort=stars&order=desc&per_page=${maxResults}`,
  );

  return data.items.map(repo => ({
    url: repo.html_url,
    title: repo.full_name,
    snippet: [
      repo.description,
      repo.language ? `Language: ${repo.language}` : null,
      `${repo.stargazers_count.toLocaleString()} stars`,
      repo.topics?.length ? `Topics: ${repo.topics.slice(0, 5).join(', ')}` : null,
    ].filter(Boolean).join(' | '),
    provider: 'github',
  }));
}

async function fetchOrgProfile(orgName: string): Promise<SearchHit | null> {
  if (!checkRateLimit()) return null;
  recordRequest();

  try {
    const org = await githubApi<GitHubOrg>(`/orgs/${encodeURIComponent(orgName)}`);
    return {
      url: org.html_url,
      title: org.name ?? org.login,
      snippet: [
        org.description,
        `${org.public_repos} public repos`,
        org.blog ? `Website: ${org.blog}` : null,
      ].filter(Boolean).join(' | '),
      provider: 'github',
    };
  } catch {
    // Org not found — not an error, just means the name doesn't match a GitHub org
    return null;
  }
}

async function searchOrgRepos(orgName: string, maxResults: number): Promise<SearchHit[]> {
  if (!checkRateLimit()) return [];
  recordRequest();

  const encodedQuery = encodeURIComponent(`org:${orgName}`);
  try {
    const data = await githubApi<GitHubSearchReposResponse>(
      `/search/repositories?q=${encodedQuery}&sort=stars&order=desc&per_page=${maxResults}`,
    );

    return data.items.map(repo => ({
      url: repo.html_url,
      title: repo.full_name,
      snippet: [
        repo.description,
        repo.language ? `Language: ${repo.language}` : null,
        `${repo.stargazers_count.toLocaleString()} stars`,
      ].filter(Boolean).join(' | '),
      provider: 'github',
    }));
  } catch {
    // org: qualifier might fail for non-org accounts; fall back to text search
    return [];
  }
}

async function fetchDirectRepo(ownerRepo: string): Promise<SearchHit | null> {
  if (!checkRateLimit()) return null;
  recordRequest();

  try {
    const repo = await githubApi<GitHubRepo>(`/repos/${ownerRepo}`);
    return {
      url: repo.html_url,
      title: repo.full_name,
      snippet: [
        repo.description,
        repo.language ? `Language: ${repo.language}` : null,
        `${repo.stargazers_count.toLocaleString()} stars`,
      ].filter(Boolean).join(' | '),
      provider: 'github',
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public provider
// ---------------------------------------------------------------------------

/**
 * Create a GitHub search provider.
 *
 * Strategy varies by entity type:
 * - organization: fetch org profile + search org repos
 * - project: detect owner/repo format for direct fetch, otherwise search repos
 * - ai-model / benchmark: search repos by name
 */
export function createGitHubProvider(): SearchProvider {
  return {
    name: 'github',

    isAvailable(): boolean {
      try {
        getGitHubToken();
        return true;
      } catch {
        return false;
      }
    },

    async search(query: string, maxResults: number, entityType?: string): Promise<SearchHit[]> {
      const hits: SearchHit[] = [];

      if (entityType === 'organization') {
        // Try to fetch org profile directly using the first word as org name
        const orgName = query.split(/\s+/)[0].replace(/[^a-zA-Z0-9_-]/g, '');
        if (orgName) {
          const orgHit = await fetchOrgProfile(orgName);
          if (orgHit) hits.push(orgHit);

          // Also search repos under this org
          const orgRepos = await searchOrgRepos(orgName, Math.min(maxResults - 1, 5));
          hits.push(...orgRepos);
        }

        // If we didn't find enough, fall back to general repo search
        if (hits.length < maxResults) {
          const moreRepos = await searchRepos(query, maxResults - hits.length);
          // Dedup by URL
          const existingUrls = new Set(hits.map(h => h.url));
          for (const repo of moreRepos) {
            if (!existingUrls.has(repo.url)) {
              hits.push(repo);
            }
          }
        }
      } else if (entityType === 'project') {
        // Check if query looks like owner/repo
        const repoMatch = query.match(/^([a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+)/);
        if (repoMatch) {
          const directHit = await fetchDirectRepo(repoMatch[1]);
          if (directHit) hits.push(directHit);
        }

        // Search repos
        const repos = await searchRepos(query, maxResults - hits.length);
        const existingUrls = new Set(hits.map(h => h.url));
        for (const repo of repos) {
          if (!existingUrls.has(repo.url)) {
            hits.push(repo);
          }
        }
      } else {
        // ai-model, benchmark, or fallback: general repo search
        const repos = await searchRepos(query, maxResults);
        hits.push(...repos);
      }

      return hits.slice(0, maxResults);
    },
  };
}
