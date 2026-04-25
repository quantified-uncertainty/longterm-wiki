import { describe, it, expect } from "vitest";
import {
  parseSitemap,
  filterReportEntries,
  ingestUkAisi,
} from "./uk-aisi-sitemap.ts";
import {
  parseRss,
  rssDateToIso,
  ingestMetr,
} from "./metr-rss.ts";
import {
  parseLinksFromHtml,
  filterApolloDetailLinks,
  ingestApollo,
} from "./apollo-research.ts";
import { filterCaisiDetailLinks, ingestCaisi } from "./caisi-blog.ts";

// ---------------------------------------------------------------------------
// UK AISI sitemap
// ---------------------------------------------------------------------------

const AISI_SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://www.aisi.gov.uk/</loc>
    <lastmod>2026-04-23</lastmod>
  </url>
  <url>
    <loc>https://www.aisi.gov.uk/blog/</loc>
    <lastmod>2026-04-22</lastmod>
  </url>
  <url>
    <loc>https://www.aisi.gov.uk/blog/pre-deployment-evaluation-of-claude-3-5-sonnet</loc>
    <lastmod>2026-01-15</lastmod>
  </url>
  <url>
    <loc>https://www.aisi.gov.uk/research/uplift-on-biological-tasks</loc>
    <lastmod>2026-02-10</lastmod>
  </url>
  <url>
    <loc>https://www.aisi.gov.uk/about/</loc>
  </url>
  <url>
    <loc>https://www.aisi.gov.uk/blog/page/2/</loc>
    <lastmod>2026-04-22</lastmod>
  </url>
</urlset>`;

describe("parseSitemap", () => {
  it("extracts all url+lastmod entries", () => {
    const entries = parseSitemap(AISI_SITEMAP);
    expect(entries).toHaveLength(6);
    expect(entries[2].loc).toBe(
      "https://www.aisi.gov.uk/blog/pre-deployment-evaluation-of-claude-3-5-sonnet",
    );
    expect(entries[2].lastmod).toBe("2026-01-15");
    expect(entries[4].lastmod).toBeNull();
  });

  it("returns empty array on malformed XML", () => {
    expect(parseSitemap("not xml")).toEqual([]);
    expect(parseSitemap("")).toEqual([]);
  });
});

describe("filterReportEntries", () => {
  it("keeps only blog/research detail URLs", () => {
    const entries = parseSitemap(AISI_SITEMAP);
    const filtered = filterReportEntries(entries);
    expect(filtered).toHaveLength(2);
    expect(filtered.map((e) => e.loc)).toEqual([
      "https://www.aisi.gov.uk/blog/pre-deployment-evaluation-of-claude-3-5-sonnet",
      "https://www.aisi.gov.uk/research/uplift-on-biological-tasks",
    ]);
  });

  it("excludes pagination URLs", () => {
    const entries = parseSitemap(AISI_SITEMAP);
    const filtered = filterReportEntries(entries);
    expect(filtered.map((e) => e.loc)).not.toContain(
      "https://www.aisi.gov.uk/blog/page/2/",
    );
  });
});

describe("ingestUkAisi", () => {
  function fakeFetch(xml: string) {
    return async () => ({
      ok: true,
      status: 200,
      text: async () => xml,
    });
  }

  it("returns candidates for filtered entries", async () => {
    const result = await ingestUkAisi({ fetchImpl: fakeFetch(AISI_SITEMAP) });
    expect(result.evaluator).toBe("uk-aisi");
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0].sourceSystem).toBe("sitemap");
    expect(result.errors).toEqual([]);
  });

  it("respects sinceDate filter", async () => {
    const result = await ingestUkAisi({
      fetchImpl: fakeFetch(AISI_SITEMAP),
      sinceDate: "2026-02-01",
    });
    // Only the 2026-02-10 research entry survives.
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].url).toContain("uplift-on-biological");
  });

  it("returns error when fetch fails", async () => {
    const result = await ingestUkAisi({
      fetchImpl: async () => ({ ok: false, status: 503, text: async () => "" }),
    });
    expect(result.candidates).toEqual([]);
    expect(result.errors).toEqual(["fetch returned HTTP 503"]);
  });

  it("returns error when fetch throws", async () => {
    const result = await ingestUkAisi({
      fetchImpl: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(result.candidates).toEqual([]);
    expect(result.errors[0]).toContain("ENOTFOUND");
  });
});

// ---------------------------------------------------------------------------
// METR RSS
// ---------------------------------------------------------------------------

const METR_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>METR</title>
    <item>
      <title>Claude Opus 4.6 Sabotage Risk Report</title>
      <link>https://metr.org/blog/2026-01-claude-opus-4-6-sabotage-risk</link>
      <pubDate>Wed, 15 Jan 2026 10:00:00 GMT</pubDate>
    </item>
    <item>
      <title><![CDATA[Methodology: Long-horizon agentic evaluations]]></title>
      <link>https://metr.org/blog/2026-02-methodology-update</link>
      <pubDate>Mon, 10 Feb 2026 12:00:00 GMT</pubDate>
    </item>
    <item>
      <title>GPT-5 Pre-Deployment Review</title>
      <link>https://metr.org/blog/2026-03-gpt-5-pre-deployment</link>
      <pubDate>2026-03-15T08:00:00Z</pubDate>
    </item>
  </channel>
</rss>`;

describe("parseRss", () => {
  it("extracts items with link/title/pubDate", () => {
    const items = parseRss(METR_RSS);
    expect(items).toHaveLength(3);
    expect(items[0].link).toBe(
      "https://metr.org/blog/2026-01-claude-opus-4-6-sabotage-risk",
    );
    expect(items[0].title).toBe("Claude Opus 4.6 Sabotage Risk Report");
    expect(items[2].pubDate).toBe("2026-03-15T08:00:00Z");
  });

  it("handles CDATA in title", () => {
    const items = parseRss(METR_RSS);
    expect(items[1].title).toBe("Methodology: Long-horizon agentic evaluations");
  });
});

describe("rssDateToIso", () => {
  it("converts RFC 822 to YYYY-MM-DD", () => {
    expect(rssDateToIso("Wed, 15 Jan 2026 10:00:00 GMT")).toBe("2026-01-15");
  });

  it("converts ISO timestamp to YYYY-MM-DD", () => {
    expect(rssDateToIso("2026-03-15T08:00:00Z")).toBe("2026-03-15");
  });

  it("returns null for invalid date", () => {
    expect(rssDateToIso("not a date")).toBeNull();
    expect(rssDateToIso(null)).toBeNull();
    expect(rssDateToIso(undefined)).toBeNull();
  });
});

describe("ingestMetr", () => {
  function fakeFetch(xml: string) {
    return async () => ({ ok: true, status: 200, text: async () => xml });
  }

  it("returns one candidate per RSS item", async () => {
    const result = await ingestMetr({ fetchImpl: fakeFetch(METR_RSS) });
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates[0].sourceSystem).toBe("rss");
    expect(result.candidates[0].publishedDate).toBe("2026-01-15");
  });

  it("respects titleFilter regex", async () => {
    const result = await ingestMetr({
      fetchImpl: fakeFetch(METR_RSS),
      titleFilter: /pre-deployment|sabotage/i,
    });
    expect(result.candidates).toHaveLength(2);
    // Methodology post should be filtered out.
    expect(
      result.candidates.find((c) => c.url.includes("methodology-update")),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Apollo HTML scrape
// ---------------------------------------------------------------------------

const APOLLO_HTML = `<html><body>
  <nav><a href="/about">About</a></nav>
  <main>
    <a href="/research/scheming-evaluations-in-frontier-models">Scheming Evaluations</a>
    <a href="/research/sandbagging-detection">Sandbagging Detection</a>
    <a href="https://arxiv.org/abs/2401.12345">arxiv preprint</a>
    <a href="/research/page/2/">Older posts</a>
    <a href="/research">Back to research</a>
  </main>
  <footer><a href="/contact">Contact</a></footer>
</body></html>`;

describe("parseLinksFromHtml", () => {
  it("extracts unique anchor href+label pairs", () => {
    const links = parseLinksFromHtml(APOLLO_HTML, "https://www.apolloresearch.ai/research");
    // 7 anchors, all unique URLs after resolution.
    expect(links.length).toBeGreaterThanOrEqual(6);
    expect(links.find((l) => l.url.includes("scheming-evaluations"))?.title).toBe(
      "Scheming Evaluations",
    );
  });

  it("resolves relative URLs against base", () => {
    const links = parseLinksFromHtml(
      `<a href="/research/foo">Foo</a>`,
      "https://www.apolloresearch.ai/research",
    );
    expect(links[0].url).toBe("https://www.apolloresearch.ai/research/foo");
  });

  it("dedups identical URLs", () => {
    const html = `<a href="/research/foo">A</a><a href="/research/foo">B</a>`;
    const links = parseLinksFromHtml(html, "https://www.apolloresearch.ai/research");
    expect(links).toHaveLength(1);
  });
});

describe("filterApolloDetailLinks", () => {
  it("keeps /research/<slug> only and drops external + listing", () => {
    const links = parseLinksFromHtml(APOLLO_HTML, "https://www.apolloresearch.ai/research");
    const filtered = filterApolloDetailLinks(links, "https://www.apolloresearch.ai/research");
    expect(filtered.map((l) => l.url)).toEqual([
      "https://www.apolloresearch.ai/research/scheming-evaluations-in-frontier-models",
      "https://www.apolloresearch.ai/research/sandbagging-detection",
    ]);
  });
});

describe("ingestApollo", () => {
  it("returns candidates for detail links only", async () => {
    const result = await ingestApollo({
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => APOLLO_HTML }),
    });
    expect(result.evaluator).toBe("apollo-research");
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0].sourceSystem).toBe("html-scrape");
  });

  it("returns errors when listing fetch fails", async () => {
    const result = await ingestApollo({
      fetchImpl: async () => ({ ok: false, status: 404, text: async () => "" }),
    });
    expect(result.candidates).toEqual([]);
    expect(result.errors).toEqual(["fetch returned HTTP 404"]);
  });
});

// ---------------------------------------------------------------------------
// CAISI blog
// ---------------------------------------------------------------------------

const CAISI_HTML = `<html><body>
  <main>
    <a href="/blogs/caisi-research-blog/red-teaming-frontier-models">Red Teaming Frontier Models</a>
    <a href="/blogs/caisi-research-blog/measurement-frameworks">Measurement Frameworks</a>
    <a href="/blogs/">Back</a>
    <a href="https://nist.gov/news-events/events">Events</a>
  </main>
</body></html>`;

describe("filterCaisiDetailLinks", () => {
  it("keeps /blogs/caisi-research-blog/<slug> only", () => {
    const links = parseLinksFromHtml(CAISI_HTML, "https://www.nist.gov/blogs/caisi-research-blog");
    const filtered = filterCaisiDetailLinks(links, "https://www.nist.gov/blogs/caisi-research-blog");
    expect(filtered).toHaveLength(2);
    expect(filtered[0].url).toContain("red-teaming-frontier-models");
  });
});

describe("ingestCaisi", () => {
  it("returns candidates with us-aisi evaluator", async () => {
    const result = await ingestCaisi({
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => CAISI_HTML }),
    });
    expect(result.evaluator).toBe("us-aisi");
    expect(result.candidates).toHaveLength(2);
  });
});
