import { describe, it, expect } from "vitest";
import {
  parseFootnotes,
  parseFootnoteSources,
  normalizeUrlForDedup,
} from "../footnote-parser";

describe("parseFootnotes", () => {
  it("extracts markdown link footnotes", () => {
    const content = `
Some text.[^1]

[^1]: [About Kalshi](https://kalshi.com/about)
`;
    const result = parseFootnotes(content);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      number: 1,
      rawText: "[About Kalshi](https://kalshi.com/about)",
      url: "https://kalshi.com/about",
      title: "About Kalshi",
    });
  });

  it("extracts bare URL footnotes", () => {
    const content = `
Text.[^1]

[^1]: https://example.com/page
`;
    const result = parseFootnotes(content);
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe("https://example.com/page");
    expect(result[0].title).toContain("example.com");
  });

  it("handles footnotes without URLs", () => {
    const content = `
Text.[^1]

[^1]: Personal communication with the author, January 2026.
`;
    const result = parseFootnotes(content);
    expect(result).toHaveLength(1);
    expect(result[0].url).toBeNull();
    expect(result[0].title).toBe(
      "Personal communication with the author, January 2026."
    );
  });

  it("handles multiple footnotes", () => {
    const content = `
First claim.[^1] Second claim.[^2] Third claim.[^3]

[^1]: [Source One](https://example.com/one)
[^2]: [Source Two](https://example.com/two)
[^3]: https://example.com/three
`;
    const result = parseFootnotes(content);
    expect(result).toHaveLength(3);
    expect(result[0].number).toBe(1);
    expect(result[1].number).toBe(2);
    expect(result[2].number).toBe(3);
  });

  it("handles multi-line footnotes", () => {
    const content = `
Text.[^1]

[^1]: [Long Title](https://example.com/page)
    Additional context about this source.
`;
    const result = parseFootnotes(content);
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe("https://example.com/page");
    expect(result[0].title).toBe("Long Title");
  });

  it("cleans trailing punctuation from URLs", () => {
    const content = `
[^1]: [Title](https://example.com/page).
`;
    const result = parseFootnotes(content);
    expect(result[0].url).toBe("https://example.com/page");
  });
});

describe("normalizeUrlForDedup", () => {
  it("strips protocol and www", () => {
    expect(normalizeUrlForDedup("https://www.example.com/page")).toBe(
      "example.com/page"
    );
    expect(normalizeUrlForDedup("http://example.com/page")).toBe(
      "example.com/page"
    );
  });

  it("strips trailing slashes", () => {
    expect(normalizeUrlForDedup("https://example.com/page/")).toBe(
      "example.com/page"
    );
  });

  it("lowercases", () => {
    expect(normalizeUrlForDedup("https://Example.COM/Page")).toBe(
      "example.com/page"
    );
  });
});

describe("parseFootnoteSources", () => {
  it("groups footnotes by unique URL", () => {
    const content = `
Claims about Kalshi.[^1] More claims.[^2] Even more.[^3]

[^1]: [Source A](https://example.com/source-a)
[^2]: [Source A again](https://example.com/source-a)
[^3]: [Source B](https://other.com/source-b)
`;
    const result = parseFootnoteSources(content);
    expect(result.totalFootnotes).toBe(3);
    expect(result.uniqueUrls).toBe(2);
    expect(result.sources).toHaveLength(2);

    const sourceA = result.sources.find((s) => s.domain === "example.com");
    expect(sourceA).toBeDefined();
    expect(sourceA!.footnoteNumbers).toEqual([1, 2]);

    const sourceB = result.sources.find((s) => s.domain === "other.com");
    expect(sourceB).toBeDefined();
    expect(sourceB!.footnoteNumbers).toEqual([3]);
  });

  it("matches URLs to resource IDs when provided", () => {
    const content = `
[^1]: [Example](https://example.com/page)
`;
    const urlToResourceId = new Map([
      ["https://example.com/page", "abc123"],
    ]);
    const result = parseFootnoteSources(content, urlToResourceId);
    expect(result.sources[0].resourceId).toBe("abc123");
  });

  it("handles footnotes without URLs", () => {
    const content = `
[^1]: Personal communication.
[^2]: [Real Source](https://example.com)
`;
    const result = parseFootnoteSources(content);
    // Footnote without URL is in footnotes but not in sources
    expect(result.totalFootnotes).toBe(2);
    expect(result.uniqueUrls).toBe(1);
    expect(result.sources).toHaveLength(1);
  });

  it("deduplicates URLs with/without trailing slashes", () => {
    const content = `
[^1]: [A](https://example.com/page/)
[^2]: [B](https://example.com/page)
`;
    const result = parseFootnoteSources(content);
    expect(result.uniqueUrls).toBe(1);
    expect(result.sources[0].footnoteNumbers).toEqual([1, 2]);
  });

  it("orders sources by first footnote number", () => {
    const content = `
[^1]: [C](https://c.com)
[^2]: [A](https://a.com)
[^3]: [B](https://b.com)
`;
    const result = parseFootnoteSources(content);
    expect(result.sources.map((s) => s.domain)).toEqual([
      "c.com",
      "a.com",
      "b.com",
    ]);
  });
});
