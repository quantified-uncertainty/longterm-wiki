import { describe, it, expect, vi } from "vitest";

// Mock heavy data-layer imports pulled in transitively by resources.ts so the
// module can load in the test environment without a built database.
vi.mock("@/data", () => ({
  getTypedEntities: () => [],
  getTypedEntityByStableId: () => undefined,
  isOrganization: () => false,
  isPerson: () => false,
  resolveResource: () => undefined,
  getResourceCredibility: () => undefined,
  getResourcePublication: () => undefined,
  getPagesForResource: () => [],
  getEntityResourceLinks: () => undefined,
}));
vi.mock("@/data/factbase", () => ({
  getKBEntities: () => [],
  getKBEntitySlug: () => undefined,
}));
vi.mock("@/lib/resource-types", () => ({
  extractDomain: () => null,
  extractDateFromUrl: () => null,
}));

import { decodeHtmlEntities } from "./resources";

describe("decodeHtmlEntities (&amp; decoded last)", () => {
  it("decodes &amp;lt; to the literal &lt; (not <)", () => {
    expect(decodeHtmlEntities("&amp;lt;")).toBe("&lt;");
  });

  it("decodes &amp;gt; to the literal &gt; (not >)", () => {
    expect(decodeHtmlEntities("&amp;gt;")).toBe("&gt;");
  });

  it("decodes &amp;amp; to the literal &amp;", () => {
    expect(decodeHtmlEntities("&amp;amp;")).toBe("&amp;");
  });

  it("decodes a normal &amp; to &", () => {
    expect(decodeHtmlEntities("AT&amp;T")).toBe("AT&T");
  });

  it("decodes a normal &lt; to <", () => {
    expect(decodeHtmlEntities("a &lt; b")).toBe("a < b");
  });

  it("decodes a normal &gt; to >", () => {
    expect(decodeHtmlEntities("a &gt; b")).toBe("a > b");
  });

  it("decodes other entities alongside &amp;", () => {
    expect(decodeHtmlEntities("Tom&#x27;s &amp; Jerry&#39;s")).toBe(
      "Tom's & Jerry's",
    );
  });

  it("decodes numeric entities above 0xFFFF without truncation (code-point safe)", () => {
    // 😀 is U+1F600 (128512) — fromCharCode would mis-decode this.
    expect(decodeHtmlEntities("&#128512;")).toBe("\u{1F600}");
  });
});
