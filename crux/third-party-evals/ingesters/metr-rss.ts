/**
 * METR ingester — consumes the RSS feed at `metr.org/feed.xml`.
 *
 * RSS gives us title + pubDate + description for free, so the extractor
 * has a head-start. The full HTML is still fetched + LLM-extracted to
 * surface risk_domain / pre_deployment / models_named.
 */

import type { IngestResult, IngestCandidate } from "./types.ts";

const FEED_URL = "https://metr.org/feed.xml";

interface RssItem {
  link: string;
  title?: string | null;
  pubDate?: string | null;
}

/**
 * Parse RSS 2.0 `<item>...</item>` blocks. Hand-rolled parser to avoid an
 * XML dependency. Handles whatever METR ships today; if the feed format
 * changes substantially, the test will catch it.
 *
 * Exported for tests.
 */
export function parseRss(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  const linkRe = /<link>([^<]+)<\/link>/i;
  const titleRe = /<title>(?:<!\[CDATA\[)?([^<\]]+?)(?:\]\]>)?<\/title>/i;
  const pubDateRe = /<pubDate>([^<]+)<\/pubDate>/i;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml))) {
    const block = m[1];
    const link = block.match(linkRe)?.[1]?.trim();
    if (!link) continue;
    const title = block.match(titleRe)?.[1]?.trim() ?? null;
    const pubDate = block.match(pubDateRe)?.[1]?.trim() ?? null;
    items.push({ link, title, pubDate });
  }
  return items;
}

/** Convert an RFC 822 / ISO date string to YYYY-MM-DD or null. */
export function rssDateToIso(s: string | null | undefined): string | null {
  if (!s) return null;
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

interface IngestOptions {
  feedUrl?: string;
  fetchImpl?: (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
  /**
   * Filter regex applied to titles. METR posts a mix of evaluation reports
   * and methodology / commentary; the LLM extractor reads the body and
   * decides pre_deployment, but we can pre-filter titles to skip obvious
   * non-eval content. Default: include everything.
   */
  titleFilter?: RegExp;
}

export async function ingestMetr(options: IngestOptions = {}): Promise<IngestResult> {
  const { feedUrl = FEED_URL, fetchImpl = fetch, titleFilter } = options;
  const errors: string[] = [];

  let response: { ok: boolean; status: number; text(): Promise<string> };
  try {
    response = await fetchImpl(feedUrl);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(`fetch failed: ${msg}`);
    return { evaluator: "metr", candidates: [], errors };
  }
  if (!response.ok) {
    errors.push(`fetch returned HTTP ${response.status}`);
    return { evaluator: "metr", candidates: [], errors };
  }

  const xml = await response.text();
  const items = parseRss(xml);

  const candidates: IngestCandidate[] = [];
  for (const item of items) {
    if (titleFilter && item.title && !titleFilter.test(item.title)) continue;
    candidates.push({
      url: item.link,
      title: item.title,
      publishedDate: rssDateToIso(item.pubDate),
      sourceSystem: "rss",
    });
  }

  return { evaluator: "metr", candidates, errors };
}
