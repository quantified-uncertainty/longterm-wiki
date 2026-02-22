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
