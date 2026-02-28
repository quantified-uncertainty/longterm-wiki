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

function toAtomDate(dateStr: string): string | null {
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

export function GET() {
  const pages = getAllPages()
    .filter((p) => p.category !== "internal")
    .map((p) => ({
      ...p,
      // Prefer dateCreated, fall back to lastUpdated
      feedDate: p.dateCreated || p.lastUpdated || null,
    }))
    .filter((p) => p.feedDate !== null)
    .sort((a, b) => b.feedDate!.localeCompare(a.feedDate!))
    .slice(0, 50);

  const updated =
    pages.length > 0
      ? toAtomDate(pages[0].feedDate!) ?? new Date().toISOString()
      : new Date().toISOString();

  const entries = pages
    .map((page) => {
      const url = `${SITE_URL}${getEntityHref(page.id)}`;
      const published = toAtomDate(page.feedDate!);
      if (!published) return null;
      const summary = page.description || page.llmSummary || "";

      return `  <entry>
    <title>${escapeXml(page.title)}</title>
    <link href="${escapeXml(url)}" rel="alternate"/>
    <id>${escapeXml(url)}</id>
    <published>${published}</published>
    <updated>${toAtomDate(page.lastUpdated || page.feedDate!) ?? published}</updated>
    <summary>${escapeXml(summary)}</summary>
    <category term="${escapeXml(page.category)}"/>
  </entry>`;
    })
    .filter(Boolean)
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Longterm Wiki — New Pages</title>
  <link href="${SITE_URL}" rel="alternate"/>
  <link href="${SITE_URL}/feed.xml" rel="self" type="application/atom+xml"/>
  <id>${SITE_URL}/</id>
  <subtitle>New pages on the Longterm Wiki, covering AI safety, existential risks, and related topics.</subtitle>
  <updated>${updated}</updated>
${entries}
</feed>`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/atom+xml; charset=utf-8",
      "Cache-Control": "s-maxage=3600, stale-while-revalidate",
    },
  });
}
