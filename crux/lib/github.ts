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
 * Check a string for signs of shell-expansion corruption or ANSI escape codes
 * before it gets posted to GitHub.
 *
 * Returns a human-readable error message if corruption is detected, or null if clean.
 *
 * Common corruption sources:
 *   - ANSI codes from tool output captured via backtick substitution
 *   - dotenv tip lines injected when bash expanded a heredoc
 *   - Shell error markers from failed command substitutions
 *   - `****` patterns from backtick-in-bold getting shell-expanded away
 */
export function detectCorruption(text: string): string | null {
  // ANSI escape sequences (ESC[ or the ◆[ variant from some terminals)
  if (/\x1b\[|\u25c6\[/.test(text)) {
    return 'Contains ANSI escape codes — text was likely captured from terminal output';
  }
  // dotenv verbose output injected via shell expansion
  if (/injecting env.*from \.env/i.test(text)) {
    return 'Contains dotenv output — text was likely processed by bash with shell expansion';
  }
  // Shell "command not found" errors from backtick substitution
  if (/: command not found/.test(text)) {
    return 'Contains shell error output ("command not found") — text was likely shell-expanded';
  }
  // `****` is the fingerprint of backtick-in-bold being shell-expanded then stripped
  if (/\*{4,}/.test(text)) {
    return 'Contains "****" — likely corrupted bold+code markdown (backticks shell-expanded away)';
  }
  return null;
}

/**
 * Recursively collect all string values from a plain object.
 * Used to validate request bodies before sending to GitHub.
 */
function collectStrings(obj: unknown): string[] {
  if (typeof obj === 'string') return [obj];
  if (Array.isArray(obj)) return obj.flatMap(collectStrings);
  if (obj && typeof obj === 'object') return Object.values(obj).flatMap(collectStrings);
  return [];
}

/**
 * Make a GitHub API request using native fetch().
 *
 * Returns the parsed JSON body, or undefined for 204 No Content responses
 * (e.g. DELETE /labels/{name}). Throws on HTTP errors with the status code
 * and response body for easy debugging.
 *
 * Automatically validates string fields in the request body for shell-expansion
 * corruption (ANSI codes, dotenv output, etc.) before sending.
 */
export async function githubApi<T = unknown>(
  endpoint: string,
  options: { method?: string; body?: object } = {},
): Promise<T> {
  const token = getGitHubToken();
  const url = `https://api.github.com${endpoint}`;
  const { method = 'GET', body } = options;

  // Validate body strings for corruption before sending
  if (body) {
    for (const str of collectStrings(body)) {
      const problem = detectCorruption(str);
      if (problem) {
        throw new Error(
          `GitHub API body failed corruption check: ${problem}\n` +
          `Offending content (first 200 chars): ${str.slice(0, 200)}`
        );
      }
    }
  }

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

  // 204 No Content — no body to parse (e.g. DELETE /labels/{name})
  if (resp.status === 204) {
    return undefined as T;
  }

  return (await resp.json()) as T;
}
