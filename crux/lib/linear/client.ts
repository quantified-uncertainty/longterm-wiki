/**
 * Shared Linear API utilities.
 *
 * Used by `crux linear` commands and agent-session skills that need to track
 * work on Linear issues (QUA-NNN). Mirrors the pattern in `crux/lib/github.ts`.
 *
 * Corruption detection: All writes through `linearGraphQL()` validate variable
 * strings for shell-expansion corruption (ANSI codes, dotenv output, etc.)
 * before sending — same class of bugs that `githubApi()` guards against.
 */

/**
 * Workspace slug for Linear URLs. Issues live at
 * `https://linear.app/${WORKSPACE_SLUG}/issue/QUA-NNN`.
 */
export const LINEAR_WORKSPACE_SLUG = 'quantifieduncertainty';

export function getLinearApiKey(): string {
  const key = process.env.LINEAR_API_KEY;
  if (!key) {
    throw new Error(
      'LINEAR_API_KEY not set. Required for Linear API calls.\n' +
      'It should be in .env.base at the workspace root — sync it into the slot .env or export it.'
    );
  }
  return key;
}

/**
 * Check a string for shell-expansion corruption or terminal output artifacts.
 * Duplicated from github.ts so the linear client is self-contained; the checks
 * are identical by design — if we ever extend one, extend the other.
 */
export function detectCorruption(text: string): string | null {
  if (/\x1b\[|\u25c6\[/.test(text)) {
    return 'Contains ANSI escape codes — text was likely captured from terminal output';
  }
  if (/injecting env.*from \.env/i.test(text)) {
    return 'Contains dotenv output — text was likely processed by bash with shell expansion';
  }
  if (/: command not found/.test(text)) {
    return 'Contains shell error output ("command not found") — text was likely shell-expanded';
  }
  if (/\*{4,}/.test(text)) {
    return 'Contains "****" — likely corrupted bold+code markdown (backticks shell-expanded away)';
  }
  return null;
}

function collectStrings(obj: unknown): string[] {
  if (typeof obj === 'string') return [obj];
  if (Array.isArray(obj)) return obj.flatMap(collectStrings);
  if (obj && typeof obj === 'object') return Object.values(obj).flatMap(collectStrings);
  return [];
}

export interface LinearGraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; path?: string[]; extensions?: unknown }>;
}

/**
 * Execute a Linear GraphQL query or mutation.
 *
 * Linear's API is GraphQL-only — there is no REST endpoint. Every variable
 * string is validated for corruption before sending, matching `githubApi()`.
 *
 * The Linear API uses `Authorization: <key>` (no "Bearer" or "token" prefix)
 * for personal API keys. OAuth tokens use `Authorization: Bearer <token>` —
 * we only support personal keys here since all agent use is server-side.
 *
 * @throws On HTTP errors or GraphQL-level errors
 */
export async function linearGraphQL<T = unknown>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const key = getLinearApiKey();

  for (const str of collectStrings(variables)) {
    const problem = detectCorruption(str);
    if (problem) {
      throw new Error(
        `Linear GraphQL variables failed corruption check: ${problem}\n` +
        `Offending content (first 200 chars): ${str.slice(0, 200)}`
      );
    }
  }

  // Best-effort timeout: these calls sit on agent init/close-out paths and must
  // not hang the CLI for minutes if Linear is unreachable. `fetch()` has no
  // built-in timeout — use AbortController with a 15s budget.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let resp: Response;
  try {
    resp = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        Authorization: key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
  } catch (e) {
    if ((e as { name?: string }).name === 'AbortError') {
      throw new Error('Linear GraphQL request timed out after 15s');
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '(no body)');
    throw new Error(`Linear GraphQL returned ${resp.status}: ${text}`);
  }

  // Linear occasionally returns an HTML error page (Cloudflare/edge cache
  // hiccup) with a 200 status. resp.json() then throws SyntaxError with the
  // raw HTML in the message — surface this as a recognizable error so
  // callers can fall back gracefully instead of bubbling a multi-KB blob.
  let result: LinearGraphQLResponse<T>;
  try {
    result = (await resp.json()) as LinearGraphQLResponse<T>;
  } catch (e) {
    throw new Error(
      `Linear GraphQL returned non-JSON response (likely an edge-cache HTML error page). ` +
      `Original error: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (result.errors?.length) {
    const msgs = result.errors.map((e) => e.message).join('; ');
    throw new Error(`Linear GraphQL error: ${msgs}`);
  }
  if (!result.data) {
    throw new Error('Linear GraphQL returned no data');
  }
  return result.data;
}

export function linearIssueUrl(identifier: string): string {
  return `https://linear.app/${LINEAR_WORKSPACE_SLUG}/issue/${identifier}`;
}
