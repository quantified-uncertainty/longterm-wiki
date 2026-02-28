import { getAllPages, getEntityHref } from "@/data";
import { SITE_URL } from "@/lib/site-config";

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function toRssDate(dateStr: string): string | null {
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d.toUTCString();
}

export function GET() {
  const pages = getAllPages()
    .filter((p) => p.category !== "internal" && p.lastUpdated)
    .sort((a, b) => b.lastUpdated!.localeCompare(a.lastUpdated!))
    .slice(0, 50);

  const lastBuildDate =
    pages.length > 0
      ? toRssDate(pages[0].lastUpdated!) ?? new Date().toUTCString()
      : new Date().toUTCString();

  const items = pages
    .map((page) => {
      const url = `${SITE_URL}${getEntityHref(page.id)}`;
      const pubDate = toRssDate(page.lastUpdated!);
      if (!pubDate) return null;
      const description = page.description || page.llmSummary || "";

      return `    <item>
      <title>${escapeXml(page.title)}</title>
      <link>${escapeXml(url)}</link>
      <guid isPermaLink="false">${escapeXml(page.id)}</guid>
      <pubDate>${pubDate}</pubDate>
      <description>${escapeXml(description)}</description>
      <category>${escapeXml(page.category)}</category>
    </item>`;
    })
    .filter(Boolean)
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
