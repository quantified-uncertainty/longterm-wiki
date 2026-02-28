import { getAllPages, getEntityHref, type Page } from "@/data";
import { SITE_URL } from "@/lib/site-config";

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Return a valid Date or null. */
function parseDate(dateStr: string | null | undefined): Date | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d;
}

interface FeedItem {
  page: Page;
  date: Date;
  changeTitle: string | null;
}

/**
 * Build feed items from changeHistory entries.
 * Each changeHistory entry becomes a separate feed item so subscribers
 * see individual updates rather than just "page X exists."
 */
function buildFeedItems(pages: Page[]): FeedItem[] {
  const items: FeedItem[] = [];

  for (const page of pages) {
    if (page.changeHistory && page.changeHistory.length > 0) {
      for (const entry of page.changeHistory) {
        const date = parseDate(entry.date);
        if (date) {
          items.push({ page, date, changeTitle: entry.title || null });
        }
      }
    }
  }

  // Sort newest first, deduplicate by page (keep most recent entry per page)
  items.sort((a, b) => b.date.getTime() - a.date.getTime());

  const seen = new Set<string>();
  const deduped: FeedItem[] = [];
  for (const item of items) {
    if (!seen.has(item.page.id)) {
      seen.add(item.page.id);
      deduped.push(item);
    }
  }

  return deduped.slice(0, 50);
}

export function GET() {
  const pages = getAllPages().filter((p) => p.category !== "internal");
  const feedItems = buildFeedItems(pages);

  const lastBuildDate =
    feedItems.length > 0
      ? feedItems[0].date.toUTCString()
      : new Date().toUTCString();

  const items = feedItems
    .map(({ page, date, changeTitle }) => {
      const url = `${SITE_URL}${getEntityHref(page.id)}`;
      const description = page.description || page.llmSummary || page.title;
      const title = changeTitle
        ? `${page.title} — ${changeTitle}`
        : page.title;

      return `    <item>
      <title>${escapeXml(title)}</title>
      <link>${escapeXml(url)}</link>
      <guid isPermaLink="false">${escapeXml(`${page.id}:${date.toISOString().slice(0, 10)}`)}</guid>
      <pubDate>${date.toUTCString()}</pubDate>
      <description>${escapeXml(description)}</description>
      <category>${escapeXml(page.category)}</category>
    </item>`;
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Longterm Wiki — Recent Updates</title>
    <link>${SITE_URL}</link>
    <description>Recently updated pages on the Longterm Wiki, covering AI safety, existential risks, and related topics.</description>
    <language>en</language>
    <lastBuildDate>${lastBuildDate}</lastBuildDate>
    <atom:link href="${SITE_URL}/feed.xml" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "s-maxage=3600, stale-while-revalidate",
    },
  });
}
