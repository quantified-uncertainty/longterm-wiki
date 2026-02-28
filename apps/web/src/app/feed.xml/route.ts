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

export function GET() {
  const pages = getAllPages();

  // Sort by dateCreated descending, falling back to lastUpdated
  const sorted = pages
    .filter((p) => p.dateCreated || p.lastUpdated)
    .sort((a, b) => {
      const dateA = a.dateCreated || a.lastUpdated || "";
      const dateB = b.dateCreated || b.lastUpdated || "";
      return dateB.localeCompare(dateA);
    })
    .slice(0, 50);

  const lastBuildDate = sorted[0]
    ? new Date(sorted[0].dateCreated || sorted[0].lastUpdated || "").toUTCString()
    : new Date().toUTCString();

  const items = sorted
    .map((page) => {
      const url = `${SITE_URL}${getEntityHref(page.id)}`;
      const pubDate = new Date(
        page.dateCreated || page.lastUpdated || "",
      ).toUTCString();
      const description = page.description || page.llmSummary || "";

      return `    <item>
      <title>${escapeXml(page.title)}</title>
      <link>${escapeXml(url)}</link>
      <guid>${escapeXml(url)}</guid>
      <pubDate>${pubDate}</pubDate>
      <description>${escapeXml(description)}</description>
      <category>${escapeXml(page.category)}</category>
    </item>`;
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Longterm Wiki — New Pages</title>
    <link>${SITE_URL}</link>
    <description>New and recently created pages on the Longterm Wiki, covering AI safety, existential risks, and related topics.</description>
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
