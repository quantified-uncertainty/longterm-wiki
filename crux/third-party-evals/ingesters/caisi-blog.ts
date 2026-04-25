/**
 * US AISI / CAISI ingester — scrapes the NIST CAISI blog listing.
 *
 * The US AI Safety Institute was rebranded to the Center for AI Standards
 * and Innovation (CAISI) in June 2025 / NIST in Dec 2025. Volume is low
 * (~4 published reports at QUA-692 plan time, ramping to ~20/year).
 *
 * NIST has a blog index at `/blogs/caisi-research-blog`. The structure
 * is similar to Apollo's listing page — anchor extraction is sufficient.
 */

import type { IngestResult, IngestCandidate } from "./types.ts";
import {
  parseLinksFromHtml,
  filterApolloDetailLinks as _filterPattern,
} from "./apollo-research.ts";

void _filterPattern; // re-used pattern intentional — kept symbol so editors find the parallel.

const LISTING_URL = "https://www.nist.gov/blogs/caisi-research-blog";

/**
 * Filter parsed links to NIST CAISI blog posts. Pattern:
 *   /blogs/caisi-research-blog/<slug>
 * Excludes the listing root and pagination URLs.
 *
 * Exported for tests.
 */
export function filterCaisiDetailLinks(
  links: { url: string; title: string | null }[],
  listingUrl: string,
): { url: string; title: string | null }[] {
  const listingHost = new URL(listingUrl).hostname;
  const out: { url: string; title: string | null }[] = [];
  for (const link of links) {
    let parsed: URL;
    try {
      parsed = new URL(link.url);
    } catch {
      continue;
    }
    if (parsed.hostname !== listingHost) continue;
    const path = parsed.pathname.toLowerCase();
    if (!/^\/blogs\/caisi-research-blog\/[^/]+/.test(path)) continue;
    if (/\/page\/\d+\/?$/.test(path)) continue;
    out.push(link);
  }
  return out;
}

interface IngestOptions {
  listingUrl?: string;
  fetchImpl?: (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
}

export async function ingestCaisi(options: IngestOptions = {}): Promise<IngestResult> {
  const { listingUrl = LISTING_URL, fetchImpl = fetch } = options;
  const errors: string[] = [];

  let response: { ok: boolean; status: number; text(): Promise<string> };
  try {
    response = await fetchImpl(listingUrl);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(`fetch failed: ${msg}`);
    return { evaluator: "us-aisi", candidates: [], errors };
  }
  if (!response.ok) {
    errors.push(`fetch returned HTTP ${response.status}`);
    return { evaluator: "us-aisi", candidates: [], errors };
  }

  const html = await response.text();
  const allLinks = parseLinksFromHtml(html, listingUrl);
  const detailLinks = filterCaisiDetailLinks(allLinks, listingUrl);

  const candidates: IngestCandidate[] = detailLinks.map((link) => ({
    url: link.url,
    title: link.title,
    publishedDate: null,
    sourceSystem: "html-scrape",
  }));

  return { evaluator: "us-aisi", candidates, errors };
}
