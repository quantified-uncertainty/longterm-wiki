export const WIKI_SERVER_URL = process.env.LONGTERMWIKI_SERVER_URL ?? "";

export const WIKI_SERVER_API_KEY = process.env.LONGTERMWIKI_SERVER_API_KEY ?? "";

export const WIKI_BASE_URL =
  (process.env.WIKI_BASE_URL ?? "https://www.longtermwiki.com").replace(
    /\/$/,
    ""
  );

export const TIMEOUT_MS = 90_000;

/** Max tool calls per query to prevent runaway API usage. */
export const MAX_TOOL_CALLS = 10;

// --- /ask command (Claude Code via OAuth subscription) ---

/** OAuth token for Claude Max subscription. Enables /ask command. */
export const CLAUDE_CODE_OAUTH_TOKEN =
  process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "";

/** Path to wiki repo checkout on disk. Required for /ask command file tools. */
export const WIKI_REPO_PATH = process.env.WIKI_REPO_PATH ?? "";

/** /ask per-user cooldown in ms (2 minutes). */
export const CODE_RATE_LIMIT_MS = 120_000;

/** /ask max concurrent requests (global). */
export const CODE_MAX_CONCURRENT = 1;

/** /ask timeout in ms (3 minutes — Claude Code has startup overhead). */
export const CODE_TIMEOUT_MS = 180_000;

/** /ask max budget per query in USD. */
export const CODE_MAX_BUDGET_USD = 0.5;

/** /ask max conversation turns. */
export const CODE_MAX_TURNS = 15;
