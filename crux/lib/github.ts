/**
 * Shared GitHub API utilities.
 *
 * Used by crux maintain, crux ci, and other domains that call the GitHub API.
 */

export const REPO = 'quantified-uncertainty/longterm-wiki';

/**
 * Get the GitHub token from the environment or throw a clear error.
 */
export function getGitHubToken(): string {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      'GITHUB_TOKEN not set. Required for GitHub API calls.\n' +
      'Set it with: export GITHUB_TOKEN=<your-token>'
    );
  }
  return token;
}

/**
 * Make a GitHub API request using native fetch().
 *
 * Returns the parsed JSON body. Throws on HTTP errors with the status code
 * and response body for easy debugging.
 */
export async function githubApi<T = unknown>(
  endpoint: string,
  options: { method?: string; body?: object } = {},
): Promise<T> {
  const token = getGitHubToken();
  const url = `https://api.github.com${endpoint}`;
  const { method = 'GET', body } = options;

  const headers: Record<string, string> = {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github+json',
  };

  const fetchOptions: RequestInit = { method, headers };
  if (body) {
    headers['Content-Type'] = 'application/json';
    fetchOptions.body = JSON.stringify(body);
  }

  const resp = await fetch(url, fetchOptions);

  if (!resp.ok) {
    const text = await resp.text().catch(() => '(no body)');
    throw new Error(`GitHub API ${method} ${endpoint} returned ${resp.status}: ${text}`);
  }

  return (await resp.json()) as T;
}
