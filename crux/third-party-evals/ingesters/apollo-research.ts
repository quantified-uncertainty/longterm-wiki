/**
 * Apollo Research ingester — scrapes the `/research` listing page.
 *
 * Apollo has no confirmed RSS feed (verified 2026-04-24 in QUA-692 plan).
 * The listing page is small (~25 entries at time of writing) so a
 * single-page scrape is sufficient. Each listed item links to a
 * detail page, which we surface as a candidate URL.
 *
 * Hand-rolled HTML link extractor — small enough that pulling in a DOM
 * parser is overkill, and we want zero new dependencies.
 */

import type { IngestResult, IngestCandidate } from "./types.ts";

const LISTING_URL = "https://www.apolloresearch.ai/research";

interface ParsedLink {
  url: string;
  title: string | null;
}

/**
 * Extract all `<a href="...">label</a>` pairs from raw HTML, resolved to
 * absolute URLs against `baseUrl`. Returns deduplicated entries.
 *
 * Exported for tests.
 */
export function parseLinksFromHtml(html: string, baseUrl: string): ParsedLink[] {
  const out = new Map<string, ParsedLink>();
  const anchorRe = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html))) {
    const href = m[1].trim();
    if (!href) continue;
    let resolved: string;
    try {
      resolved = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }
    // Strip HTML tags from the label and collapse whitespace.
    const rawLabel = m[2]
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    const title = rawLabel.length > 0 ? rawLabel : null;
    if (!out.has(resolved)) out.set(resolved, { url: resolved, title });
  }
  return [...out.values()];
}

/**
 * Filter parsed links to ones that look like Apollo research/eval detail
 * pages. The listing page contains nav/footer links + arxiv outlinks;
 * we want only `/research/...` paths under the apollo domain.
 *
 * Exported for tests.
 */
export function filterApolloDetailLinks(
  links: ParsedLink[],
  listingUrl: string,
): ParsedLink[] {
  const listingHost = new URL(listingUrl).hostname;
  const out: ParsedLink[] = [];
  for (const link of links) {
    let parsed: URL;
    try {
      parsed = new URL(link.url);
    } catch {
      continue;
    }
    if (parsed.hostname !== listingHost) continue;
    const path = parsed.pathname.toLowerCase();
    // Only keep `/research/<slug>` paths — exclude listing root + `/research/page/N`.
    if (!/^\/(research|science)\/[^/]+/.test(path)) continue;
    if (/\/page\/\d+\/?$/.test(path)) continue;
    out.push(link);
  }
  return out;
}

interface IngestOptions {
  listingUrl?: string;
  fetchImpl?: (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
}

export async function ingestApollo(options: IngestOptions = {}): Promise<IngestResult> {
  const { listingUrl = LISTING_URL, fetchImpl = fetch } = options;
  const errors: string[] = [];

  let response: { ok: boolean; status: number; text(): Promise<string> };
  try {
    response = await fetchImpl(listingUrl);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(`fetch failed: ${msg}`);
    return { evaluator: "apollo-research", candidates: [], errors };
  }
  if (!response.ok) {
    errors.push(`fetch returned HTTP ${response.status}`);
    return { evaluator: "apollo-research", candidates: [], errors };
  }

  const html = await response.text();
  const allLinks = parseLinksFromHtml(html, listingUrl);
  const detailLinks = filterApolloDetailLinks(allLinks, listingUrl);

  const candidates: IngestCandidate[] = detailLinks.map((link) => ({
    url: link.url,
    title: link.title,
    publishedDate: null, // Apollo listing has no date in anchor; LLM extracts from page.
    sourceSystem: "html-scrape",
  }));

  return { evaluator: "apollo-research", candidates, errors };
}
