/**
 * Shared HTML helpers for scorecard extractors.
 *
 *   `fetchToCache()` — download a URL to disk once, then read from disk on
 *   subsequent calls. Lets us re-run extraction without re-fetching or
 *   accidentally re-snapshotting a moved page.
 *
 *   `stripHtmlForLlm()` — best-effort regex strip of script/style/comments
 *   and most attributes so the LLM sees structural skeleton + text only.
 *   Typically shrinks scorecard pages by ~10×. Not a sanitizer; see
 *   `stripHtmlForLlm` docstring below.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "fs";
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
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!opts.force && existsSync(dest)) {
    // Cap cached reads too — protects against re-reading a stale huge
    // file that bypassed an earlier limit (or was written with a larger
    // maxBytes than the current call allows).
    const cachedSize = statSync(dest).size;
    if (cachedSize > maxBytes) {
      throw new Error(
        `cache refused for ${dest}: cached file size ${cachedSize} exceeds limit ${maxBytes}`,
      );
    }
    return readFileSync(dest);
  }
  const fetchFn = opts.fetchImpl ?? fetch;
  const ua =
    opts.userAgent ??
    "Mozilla/5.0 (compatible; LongtermWikiBot/1.0; +https://www.longtermwiki.com)";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const response = await fetchFn(url, {
    headers: { "User-Agent": ua },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(
      `fetch failed for ${url}: HTTP ${response.status} ${response.statusText}`,
    );
  }
  // Pre-flight via Content-Length when honest — fast reject for declared-huge bodies.
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) {
    throw new Error(
      `fetch refused for ${url}: declared content-length ${declared} exceeds limit ${maxBytes}`,
    );
  }
  // Stream-and-cap: a hostile server can omit Content-Length and stream
  // a multi-GB body. Accumulate chunks and bail past the cap so we never
  // hold more than maxBytes + one chunk in memory.
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error(`fetch failed for ${url}: empty response body`);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(
          `fetch refused for ${url}: body length ${total} exceeds limit ${maxBytes}`,
        );
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock?.();
  }
  const buf = Buffer.concat(chunks, total);
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
// Compiled once and reused per call — avoids re-parsing 8 regex literals
// every invocation. The strip helper sees one ~840KB FLI page per
// extraction, so this is not hot, but the cost is also free.
// Closing tags tolerate trailing whitespace (`</script >`) so a crafted page
// can't slip a block past the filter with `</script\n>`.
const RE_DROP_BLOCKS: ReadonlyArray<RegExp> = [
  /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,
  /<style\b[^>]*>[\s\S]*?<\/style\s*>/gi,
  /<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi,
  /<svg\b[^>]*>[\s\S]*?<\/svg\s*>/gi,   // logos: lots of bytes, no signal
  /<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, // favicon/meta/links
  /<!--[\s\S]*?-->/g,
];
const RE_OPEN_TAG = /<([a-zA-Z][a-zA-Z0-9]*)\s+([^>]*?)(\/?)>/g;
const RE_ATTR = /([a-zA-Z\-][a-zA-Z0-9\-_:]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
const RE_WHITESPACE = /\s+/g;
const RE_BLOCK_CLOSE = /<\/(div|p|li|tr|td|th|h\d|section|article|main|header|footer|nav|table|tbody|thead)>/gi;
const KEEP_ATTRS = new Set(["class", "data-company", "data-title", "data-id", "alt", "title"]);

export function stripHtmlForLlm(html: string): string {
  let out = html;
  for (const re of RE_DROP_BLOCKS) out = out.replace(re, "");
  // Whitelist attributes per element; drop everything else. Self-closing OK.
  out = out.replace(RE_OPEN_TAG, (_m, tag, attrs, slash) => {
    const kept: string[] = [];
    RE_ATTR.lastIndex = 0;
    let am: RegExpExecArray | null;
    while ((am = RE_ATTR.exec(attrs)) !== null) {
      const name = am[1].toLowerCase();
      if (KEEP_ATTRS.has(name)) {
        const val = am[3] ?? am[4] ?? am[5] ?? "";
        kept.push(`${name}="${val}"`);
      }
    }
    return kept.length ? `<${tag} ${kept.join(" ")}${slash}>` : `<${tag}${slash}>`;
  });
  out = out.replace(RE_WHITESPACE, " ");
  out = out.replace(RE_BLOCK_CLOSE, "</$1>\n");
  return out.trim();
}
