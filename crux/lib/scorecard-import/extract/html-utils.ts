/**
 * Shared HTML helpers for scorecard extractors (QUA-749/750/751).
 *
 * Two responsibilities:
 *   1. `fetchToCache()` — download a URL to `<cacheDir>/<filename>` once,
 *      then read from disk on subsequent calls. Re-extraction never re-pays
 *      bandwidth or accidentally re-snapshots a moved page.
 *   2. `stripHtmlForLlm()` — drop <script>, <style>, <noscript>, comments,
 *      and most attributes so the LLM extractor sees just structure + text.
 *      Cuts the FLI index page from ~840KB to ~70KB without losing data.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { dirname } from "path";

/** Default 30s wall-clock timeout for the network fetch. */
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
/** Default 32 MB byte cap — same as Anthropic's PDF size limit, which is
 *  the largest payload we expect to send downstream. */
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

export interface FetchOptions {
  /** Override the User-Agent. Defaults to the longterm-wiki importer. */
  userAgent?: string;
  /** If true, re-download even when cached. Defaults to false. */
  force?: boolean;
  /** Optional fetch implementation override (testing). */
  fetchImpl?: typeof fetch;
  /** Wall-clock timeout in ms. Defaults to 30s. */
  timeoutMs?: number;
  /** Maximum response size in bytes. Defaults to 32 MB. */
  maxBytes?: number;
}

/**
 * Download `url` to `dest` if missing (or `force=true`), then return the
 * file contents. Throws on non-2xx HTTP, on response size > `maxBytes`,
 * or if the fetch exceeds `timeoutMs`. The caller is responsible for
 * passing a binary-safe `dest` path for non-HTML payloads (e.g., PDFs).
 */
export async function fetchToCache(
  url: string,
  dest: string,
  opts: FetchOptions = {},
): Promise<Buffer> {
  if (!opts.force && existsSync(dest)) {
    return readFileSync(dest);
  }
  const fetchFn = opts.fetchImpl ?? fetch;
  const ua =
    opts.userAgent ??
    "Mozilla/5.0 (compatible; LongtermWikiBot/1.0; +https://www.longtermwiki.com)";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const response = await fetchFn(url, {
    headers: { "User-Agent": ua },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(
      `fetch failed for ${url}: HTTP ${response.status} ${response.statusText}`,
    );
  }
  // Pre-flight check via Content-Length when present — saves us from
  // streaming a multi-GB body just to reject it.
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) {
    throw new Error(
      `fetch refused for ${url}: declared content-length ${declared} exceeds limit ${maxBytes}`,
    );
  }
  const buf = Buffer.from(await response.arrayBuffer());
  if (buf.length > maxBytes) {
    throw new Error(
      `fetch refused for ${url}: body length ${buf.length} exceeds limit ${maxBytes}`,
    );
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
  return buf;
}

/**
 * Aggressively strip an HTML document for LLM consumption: remove
 * <script>, <style>, <noscript>, HTML comments, and almost all attributes.
 * Keeps `class` (signals layout/section) and `data-company` / `data-title`
 * (some scorecards encode the company name in attributes, e.g., SaferAI).
 *
 * The output is NOT rendered HTML — it's a token-cheap structural skeleton
 * for the extractor LLM. Newlines around block elements are normalized so
 * Claude sees natural paragraph boundaries instead of one giant line.
 *
 * **Best-effort, regex-based.** Mishandles attribute values containing `>`
 * inside quoted strings, unquoted attribute values containing `/`, and
 * `<script>` content where the closing tag appears within a JS string
 * literal. Acceptable for our use case (LLM input from trusted-but-noisy
 * scorecard pages) but do NOT use this for security-sensitive HTML
 * sanitization — reach for a real parser (cheerio/parse5) instead.
 */
export function stripHtmlForLlm(html: string): string {
  let out = html;
  // Drop script/style/noscript blocks (and their content).
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  out = out.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  out = out.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "");
  // Drop SVGs (logos blow up token count without adding info).
  out = out.replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, "");
  // Drop <head> entirely — we don't need favicon/meta/links.
  out = out.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, "");
  // Drop comments.
  out = out.replace(/<!--[\s\S]*?-->/g, "");
  // Whitelist attributes per element. Keep `class`, `data-company`,
  // `data-title`, `data-id` — drop everything else. Self-closing OK.
  out = out.replace(/<([a-zA-Z][a-zA-Z0-9]*)\s+([^>]*?)(\/?)>/g, (_m, tag, attrs, slash) => {
    const kept: string[] = [];
    const re = /([a-zA-Z\-][a-zA-Z0-9\-_:]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
    let am: RegExpExecArray | null;
    while ((am = re.exec(attrs)) !== null) {
      const name = am[1].toLowerCase();
      const val = am[3] ?? am[4] ?? am[5] ?? "";
      if (
        name === "class" ||
        name === "data-company" ||
        name === "data-title" ||
        name === "data-id" ||
        name === "alt" ||
        name === "title"
      ) {
        kept.push(`${name}="${val}"`);
      }
    }
    return kept.length ? `<${tag} ${kept.join(" ")}${slash}>` : `<${tag}${slash}>`;
  });
  // Normalize whitespace across block boundaries.
  out = out.replace(/\s+/g, " ");
  // Insert newlines after closing structural tags so the LLM sees layout.
  out = out.replace(
    /<\/(div|p|li|tr|td|th|h\d|section|article|main|header|footer|nav|table|tbody|thead)>/gi,
    "</$1>\n",
  );
  return out.trim();
}
