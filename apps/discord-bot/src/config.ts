export const WIKI_SERVER_URL = process.env.LONGTERMWIKI_SERVER_URL ?? "";

export const WIKI_SERVER_API_KEY = process.env.LONGTERMWIKI_SERVER_API_KEY ?? "";

export const WIKI_BASE_URL =
  (process.env.WIKI_BASE_URL ?? "https://www.longtermwiki.com").replace(
    /\/$/,
    ""
  );

export const TIMEOUT_MS = 60_000;
