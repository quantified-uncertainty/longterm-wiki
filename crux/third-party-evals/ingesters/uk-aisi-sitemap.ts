/**
 * UK AISI ingester — parses `/sitemap.xml` and filters URLs to the
 * `/blog/` and `/research/` prefixes that contain published evaluations.
 *
 * The sitemap is the highest-ROI source for AISI: ~140 relevant URLs at
 * the time of QUA-692 plan verification, with `lastmod` timestamps that
 * make delta detection cheap.
 *
 * The HTML for individual posts is fetched separately by the LLM
 * extractor pipeline — this ingester only returns candidate URLs.
 */

import type { IngestResult, IngestCandidate } from "./types.ts";

const SITEMAP_URL = "https://www.aisi.gov.uk/sitemap.xml";

const RELEVANT_PATH_PREFIXES = ["/blog/", "/research/"];

/**
 * Paths in the sitemap that we know are NOT individual reports — listing
 * pages, taxonomy pages, etc. Match against the URL path (lowercase).
 */
const PATH_DENYLIST = new Set([
  "/",
  "/blog/",
  "/blog",
  "/research/",
  "/research",
  "/about/",
  "/contact/",
]);

interface SitemapEntry {
  loc: string;
  lastmod?: string | null;
}

/**
 * Parse a sitemap XML body into `<url><loc/><lastmod/></url>` entries.
 * Hand-rolled parser — sitemaps are simple and we'd rather not pull in
 * a full XML dependency for ~150 entries.
 *
 * Exported for tests.
 */
export function parseSitemap(xml: string): SitemapEntry[] {
  const entries: SitemapEntry[] = [];
  // Match each <url>...</url> block, then extract <loc> and optional <lastmod>.
  const urlBlockRe = /<url\b[^>]*>([\s\S]*?)<\/url>/gi;
  const locRe = /<loc>([^<]+)<\/loc>/i;
  const lastmodRe = /<lastmod>([^<]+)<\/lastmod>/i;
  let m: RegExpExecArray | null;
  while ((m = urlBlockRe.exec(xml))) {
    const block = m[1];
    const loc = block.match(locRe)?.[1]?.trim();
    if (!loc) continue;
    const lastmod = block.match(lastmodRe)?.[1]?.trim() ?? null;
    entries.push({ loc, lastmod });
  }
  return entries;
}

/**
 * Filter sitemap entries to URLs that look like individual reports under
 * `/blog/` or `/research/`. Strips listing/taxonomy URLs.
 *
 * Exported for tests.
 */
export function filterReportEntries(entries: SitemapEntry[]): SitemapEntry[] {
  const out: SitemapEntry[] = [];
  for (const entry of entries) {
    let path: string;
    try {
      path = new URL(entry.loc).pathname.toLowerCase();
    } catch {
      continue;
    }
    if (PATH_DENYLIST.has(path)) continue;
    if (!RELEVANT_PATH_PREFIXES.some((p) => path.startsWith(p))) continue;
    // Reject URLs that appear to be paginated listings (`/blog/page/2/`).
    if (/\/page\/\d+\/?$/.test(path)) continue;
    out.push(entry);
  }
  return out;
}

interface IngestOptions {
  /** Override the sitemap URL (for tests). */
  sitemapUrl?: string;
  /** Override the fetch implementation (for tests). */
  fetchImpl?: (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
  /** Skip URLs whose `lastmod` is before this ISO date. */
  sinceDate?: string;
}

/**
 * Ingest UK AISI publications from the sitemap.
 *
 * Fail-loud on transport errors so the CLI can report. Returns candidates
 * even if the LLM extractor would later reject some (URL → 404, paywall);
 * extraction is the next pipeline phase.
 */
export async function ingestUkAisi(options: IngestOptions = {}): Promise<IngestResult> {
  const { sitemapUrl = SITEMAP_URL, fetchImpl = fetch, sinceDate } = options;
  const errors: string[] = [];

  let response: { ok: boolean; status: number; text(): Promise<string> };
  try {
    response = await fetchImpl(sitemapUrl);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(`fetch failed: ${msg}`);
    return { evaluator: "uk-aisi", candidates: [], errors };
  }
  if (!response.ok) {
    errors.push(`fetch returned HTTP ${response.status}`);
    return { evaluator: "uk-aisi", candidates: [], errors };
  }

  const xml = await response.text();
  const entries = parseSitemap(xml);
  const filtered = filterReportEntries(entries);

  const since = sinceDate ? new Date(sinceDate).getTime() : null;

  const candidates: IngestCandidate[] = [];
  for (const entry of filtered) {
    if (since != null && entry.lastmod) {
      const t = new Date(entry.lastmod).getTime();
      if (Number.isFinite(t) && t < since) continue;
    }
    candidates.push({
      url: entry.loc,
      // The sitemap doesn't give us titles. Title is filled by the
      // extractor from the page itself.
      title: null,
      // `lastmod` is the modification date, not the publication date —
      // we store it as a hint and let extraction overwrite if it finds
      // an explicit publication date in the body.
      publishedDate: entry.lastmod ?? null,
      sourceSystem: "sitemap",
    });
  }

  return { evaluator: "uk-aisi", candidates, errors };
}
