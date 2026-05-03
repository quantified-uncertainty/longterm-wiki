/**
 * Shared GitHub API utilities.
 *
 * Used by crux maintain, crux ci, and other domains that call the GitHub API.
 *
 * Corruption detection: All writes through `githubApi()` are validated for
 * shell-expansion corruption (ANSI codes, dotenv output, etc.) before sending.
 * This catches a class of bugs where bash variable expansion or command
 * substitution injects terminal garbage into GitHub API payloads.
 *
 * MCP exemption: The GitHub MCP server (configured in `.mcp.json`) bypasses
 * this validation because MCP tools don't go through bash — they communicate
 * via JSON-RPC, so shell-expansion corruption cannot occur. MCP is safe for
 * ad-hoc reads; prefer `githubApi()` (via crux commands) for workflow writes
 * where corruption detection adds an important safety layer.
 */

export const REPO = 'quantified-uncertainty/longterm-wiki';

/**
 * Per-request timeout for GitHub API and GraphQL fetches. Without this, a hung
 * TCP connection or stalled TLS handshake blocks the caller indefinitely —
 * which in the patrol loop manifested as "fetch failed" persisting for hours
 * with no specifics about what was being attempted (QUA-823).
 *
 * 30s is generous: GitHub's documented p99 is well under 5s, and our largest
 * payloads (PR creation with long bodies) finish in single-digit seconds.
 */
export const GITHUB_API_TIMEOUT_MS = 30_000;

/**
 * Wrap a `fetch` rejection (TypeError "fetch failed", AbortError on timeout,
 * etc.) with the URL/method context so the patrol log shows what was being
 * attempted. Plain `fetch` errors do not include the URL — see QUA-823 where
 * 37+ consecutive "fetch failed" log lines gave no hint at the failing
 * endpoint. Re-throws as a normal `Error` so existing `instanceof
 * GitHubApiError` / `isMissingTokenError` checks remain unaffected.
 */
function wrapFetchError(method: string, endpoint: string, err: unknown): Error {
  const isAbort =
    err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
  const cause = err instanceof Error ? err.message : String(err);
  // Surface the underlying cause too — Node wraps DNS/connection errors as
  // `error.cause` on the outer TypeError; without this the log loses "ENOTFOUND"
  // / "ECONNREFUSED" specifics.
  const inner =
    err instanceof Error && (err as { cause?: unknown }).cause instanceof Error
      ? `: ${(err as { cause: Error }).cause.message}`
      : '';
  if (isAbort) {
    return new Error(
      `GitHub API ${method} ${endpoint} timed out after ${GITHUB_API_TIMEOUT_MS}ms`,
    );
  }
  return new Error(`GitHub API ${method} ${endpoint} fetch failed: ${cause}${inner}`);
}

/**
 * Short one-liner for display summaries ("GITHUB_TOKEN not set"). Kept in one
 * place so the ~7 display call sites (health-check / pr-quality / ci-main-health
 * summaries, wellness-report warning, github-lookup error, pr-patrol index
 * errors, pr-patrol parallel error log) don't drift from each other.
 */
export const MISSING_TOKEN_SUMMARY = 'GITHUB_TOKEN not set';

/**
 * Canonical help message for every code path that wants to tell the user
 * how to set `GITHUB_TOKEN`. Derived from `MISSING_TOKEN_SUMMARY` so the short
 * and long forms cannot drift.
 */
export const MISSING_TOKEN_HELP_MESSAGE =
  `${MISSING_TOKEN_SUMMARY}. Required for GitHub API calls.\n` +
  'Set it with: export GITHUB_TOKEN=<your-token>';

/**
 * Thrown by `getGitHubToken()` when the `GITHUB_TOKEN` environment variable is
 * missing or empty. Callers that need to distinguish "permanent config fault"
 * from "transient GitHub hiccup" should use `isMissingTokenError()` rather
 * than grepping error messages — see QUA-482 for why string-matching the
 * signal is brittle.
 *
 * The constructor deliberately takes no arguments. Allowing a custom message
 * would let a caller `throw new MissingTokenError('unrelated condition')` and
 * trip the patrol's permanent-halt classifier on something that isn't
 * actually a missing token. The class exists as a stable classifier signal,
 * not a general-purpose error wrapper.
 */
export class MissingTokenError extends Error {
  constructor() {
    super(MISSING_TOKEN_HELP_MESSAGE);
    this.name = 'MissingTokenError';
  }
}

/**
 * Type guard for `MissingTokenError`. Prefer this over `msg.includes(...)` so
 * the error signal can evolve without silently breaking classifiers.
 *
 * Also matches serialized errors where only `.name === 'MissingTokenError'`
 * survives the boundary (JSON logs, subprocess stderr → parent catch). To
 * reduce the duck-typing attack surface, the serialized branch additionally
 * requires a string `.message` field — a bare `{ name: 'MissingTokenError' }`
 * object is rejected. Real `Error.toJSON()` / structured-clone output always
 * includes a message, so this narrows away arbitrary attacker-crafted
 * objects without rejecting any legitimate serialized error.
 *
 * NOTE: If you ever subclass `MissingTokenError` and set a different `.name`
 * on the subclass, `instanceof` still matches (correct), but serialized
 * subclass instances will NOT be classified here. Update this guard if that
 * case becomes real.
 */
export function isMissingTokenError(err: unknown): err is MissingTokenError {
  if (err instanceof MissingTokenError) return true;
  if (typeof err !== 'object' || err === null) return false;
  const obj = err as { name?: unknown; message?: unknown };
  return obj.name === 'MissingTokenError' && typeof obj.message === 'string';
}

/**
 * Error thrown by {@link githubApi} on HTTP failures.
 *
 * Carries the HTTP `status` code as a structured property so callers can
 * discriminate between error classes without resorting to substring matching
 * on the `message` string (which is error-prone — a 500 response whose body
 * happens to contain the text "404" would match a naive `msg.includes('404')`
 * check).
 *
 * The `message` format is preserved (`"GitHub API ${method} ${endpoint}
 * returned ${status}: ${body}"`) for backwards compatibility with code that
 * pre-dates this class and still substring-matches the message.
 */
export class GitHubApiError extends Error {
  /** HTTP status code from the failing response (e.g. 404, 422, 500). */
  readonly status: number;
  /** HTTP method of the failing request. */
  readonly method: string;
  /** API endpoint path (without the `https://api.github.com` prefix). */
  readonly endpoint: string;
  /** Response body text (best-effort; may be `"(no body)"`). */
  readonly responseBody: string;

  constructor(
    method: string,
    endpoint: string,
    status: number,
    responseBody: string,
  ) {
    super(`GitHub API ${method} ${endpoint} returned ${status}: ${responseBody}`);
    this.name = 'GitHubApiError';
    this.status = status;
    this.method = method;
    this.endpoint = endpoint;
    this.responseBody = responseBody;
  }
}

/**
 * Type guard: is this error a {@link GitHubApiError} with the given status?
 *
 * Prefer this over `err.message.includes('404')` — the substring-match
 * approach was flagged as a Major finding in PR #4362 because it swallows
 * any error whose message happens to contain "404" (e.g. a PR number).
 */
export function isGitHubApiErrorWithStatus(
  err: unknown,
  status: number,
): err is GitHubApiError {
  return err instanceof GitHubApiError && err.status === status;
}

/**
 * Return the whitespace-stripped `GITHUB_TOKEN` env var, or throw a
 * `MissingTokenError` when it is absent, empty, or whitespace-only.
 *
 * The return value is always `.trim()`-ed. Callers that need the raw env
 * var (verbatim passthrough) should read `process.env.GITHUB_TOKEN`
 * directly. Without the trim, a stray-whitespace value (e.g. from
 * `GITHUB_TOKEN=$(cat token.txt)` where the file has a trailing newline)
 * would pass the truthy check and be sent verbatim to the GitHub API,
 * causing a transient-looking 401 instead of the immediate permanent-fault
 * classification that `MissingTokenError` signals.
 */
export function getGitHubToken(): string {
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) {
    throw new MissingTokenError();
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

  const fetchOptions: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
  };
  if (body) {
    headers['Content-Type'] = 'application/json';
    fetchOptions.body = JSON.stringify(body);
  }

  let resp: Response;
  try {
    resp = await fetch(url, fetchOptions);
  } catch (e) {
    throw wrapFetchError(method, endpoint, e);
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '(no body)');
    // Throw a structured error so callers can key off `.status` instead of
    // substring-matching the message. The message format is preserved for
    // backwards compatibility with existing callers that still do that.
    throw new GitHubApiError(method, endpoint, resp.status, text);
  }

  // 204 No Content — no body to parse (e.g. DELETE /labels/{name})
  if (resp.status === 204) {
    return undefined as T;
  }

  return (await resp.json()) as T;
}

/**
 * Paginate a GitHub API list endpoint.
 *
 * Fetches all pages (up to maxPages) of a list endpoint that returns arrays.
 * Uses the page query parameter since the GitHub REST API supports it on all
 * list endpoints.
 *
 * @param endpoint - API path with query params (e.g. `/repos/.../issues?state=open&per_page=100`)
 * @param maxPages - Safety limit to prevent runaway pagination (default: 5)
 */
export async function githubApiPaginated<T>(
  endpoint: string,
  maxPages = 5,
): Promise<T[]> {
  const allItems: T[] = [];
  const separator = endpoint.includes('?') ? '&' : '?';

  for (let page = 1; page <= maxPages; page++) {
    const items = await githubApi<T[]>(`${endpoint}${separator}page=${page}`);
    if (!Array.isArray(items) || items.length === 0) break;
    allItems.push(...items);
    // If we got fewer than the per_page limit, we're on the last page
    if (items.length < 100) break;
  }

  return allItems;
}

// ---------------------------------------------------------------------------
// GraphQL API (for GitHub Discussions — no REST equivalent)
// ---------------------------------------------------------------------------

export interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; type?: string; path?: string[] }>;
}

/**
 * Execute a GitHub GraphQL query or mutation.
 *
 * Unlike REST, the Discussions API is only available via GraphQL. This function
 * wraps the GitHub GraphQL endpoint with the same corruption detection and auth
 * handling as `githubApi()`.
 *
 * @param query - GraphQL query or mutation string
 * @param variables - Variables to pass to the query
 * @returns The `data` field from the response
 * @throws On HTTP errors or GraphQL-level errors
 */
export async function githubGraphQL<T = unknown>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const token = getGitHubToken();

  // Validate all variable strings for corruption
  for (const str of collectStrings(variables)) {
    const problem = detectCorruption(str);
    if (problem) {
      throw new Error(
        `GitHub GraphQL variables failed corruption check: ${problem}\n` +
        `Offending content (first 200 chars): ${str.slice(0, 200)}`
      );
    }
  }

  let resp: Response;
  try {
    resp = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        Authorization: `bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
    });
  } catch (e) {
    throw wrapFetchError('POST', '/graphql', e);
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '(no body)');
    throw new Error(`GitHub GraphQL returned ${resp.status}: ${text}`);
  }

  const result = (await resp.json()) as GraphQLResponse<T>;

  if (result.errors?.length) {
    const msgs = result.errors.map((e) => e.message).join('; ');
    throw new Error(`GitHub GraphQL error: ${msgs}`);
  }

  if (!result.data) {
    throw new Error('GitHub GraphQL returned no data');
  }

  return result.data;
}

// ---------------------------------------------------------------------------
// Issue helpers — typed wrappers around common GitHub Issues API operations
// ---------------------------------------------------------------------------

/** Minimal issue shape returned by the GitHub Issues API. */
export interface GitHubIssue {
  number: number;
  state: string;
  title: string;
  labels: Array<{ name: string }>;
}

/** List open issues filtered by a single label. */
export async function listIssuesByLabel(label: string, limit = 5): Promise<GitHubIssue[]> {
  return githubApi<GitHubIssue[]>(
    `/repos/${REPO}/issues?labels=${encodeURIComponent(label)}&state=open&per_page=${limit}`,
  );
}

/** List recent open issues sorted by creation date (newest first). */
export async function listRecentOpenIssues(limit = 30): Promise<GitHubIssue[]> {
  return githubApi<GitHubIssue[]>(
    `/repos/${REPO}/issues?state=open&per_page=${limit}&sort=created&direction=desc`,
  );
}

/**
 * Look up the open PR URL for a branch. Returns null when no open PR
 * exists. Throws on auth / network error — callers decide whether to
 * swallow. (Existing `pulls?head=...` callsites in `crux/commands/pr.ts`
 * still hand-roll the URL and want the full `GitHubPR` shape; this
 * helper is the URL-only fast path used by session close.)
 */
export async function getOpenPrUrlByBranch(branch: string): Promise<string | null> {
  if (!branch) return null;
  const prs = await githubApi<Array<{ html_url: string }>>(
    `/repos/${REPO}/pulls?head=quantified-uncertainty:${encodeURIComponent(branch)}&state=open`,
  );
  return prs[0]?.html_url ?? null;
}

/** Create a comment on an issue. */
export async function createIssueComment(issueNumber: number, body: string): Promise<void> {
  await githubApi(`/repos/${REPO}/issues/${issueNumber}/comments`, {
    method: 'POST',
    body: { body },
  });
}

/** Close an issue via PATCH. */
export async function closeIssue(issueNumber: number): Promise<void> {
  await githubApi(`/repos/${REPO}/issues/${issueNumber}`, {
    method: 'PATCH',
    body: { state: 'closed' },
  });
}

/** Create a new issue. Returns the created issue with its number. */
export async function createIssue(options: {
  title: string;
  body: string;
  labels: string[];
}): Promise<{ number: number }> {
  return githubApi<{ number: number }>(`/repos/${REPO}/issues`, {
    method: 'POST',
    body: options,
  });
}

/**
 * Ensure a label exists on the repo. No-ops if it already exists (422).
 */
export async function ensureLabel(
  name: string,
  color: string,
  description: string,
): Promise<void> {
  try {
    await githubApi(`/repos/${REPO}/labels`, {
      method: 'POST',
      body: { name, color, description },
    });
  } catch (err) {
    // 422 = already exists — fine
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('422') && !msg.includes('already_exists')) {
      console.warn(`Warning: could not ensure label "${name}": ${msg}`);
    }
  }
}

// ---------------------------------------------------------------------------
// GraphQL API (for GitHub Discussions — no REST equivalent)
// ---------------------------------------------------------------------------

/**
 * Get the GraphQL node ID for the repository.
 * Required for mutations like createDiscussion that take repositoryId.
 */
export async function getRepoNodeId(): Promise<string> {
  const [owner, name] = REPO.split('/');
  const data = await githubGraphQL<{
    repository: { id: string };
  }>(
    `query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) { id }
    }`,
    { owner, name },
  );
  return data.repository.id;
}
