import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// Default WIKI_ROOT to the repo root (three levels up from apps/discord-bot/src/)
export const WIKI_ROOT =
  process.env.WIKI_ROOT ?? resolve(__dirname, "../../..");

export const WIKI_CONTENT_PATH = `${WIKI_ROOT}/content/docs`;

export const WIKI_BASE_URL =
  (process.env.WIKI_BASE_URL ?? "https://www.longtermwiki.com").replace(
    /\/$/,
    ""
  );

export const TIMEOUT_MS = 60_000;
