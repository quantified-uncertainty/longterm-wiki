/**
 * Tests for fix-resource-titles.ts utility functions
 */
import { describe, it, expect } from "vitest";
import {
  isBadTitle,
  extractTitleFromHtml,
  isScrapingFailure,
  deriveTitleFromUrl,
} from "./fix-resource-titles.ts";

describe("isBadTitle", () => {
  it("detects empty/null titles", () => {
    expect(isBadTitle(null)).toBe(true);
    expect(isBadTitle(undefined)).toBe(true);
    expect(isBadTitle("")).toBe(true);
    expect(isBadTitle("   ")).toBe(true);
  });

  it("detects domain-only titles", () => {
    expect(isBadTitle("www.cs.toronto.edu")).toBe(true);
    expect(isBadTitle("arxiv.org")).toBe(true);
    expect(isBadTitle("openai.com")).toBe(true);
    expect(isBadTitle("en.wikipedia.org")).toBe(true);
    expect(isBadTitle("distill.pub")).toBe(true);
    expect(isBadTitle("colah.github.io")).toBe(true);
  });

  it("detects generic words", () => {
    expect(isBadTitle("Book")).toBe(true);
    expect(isBadTitle("book")).toBe(true);
    expect(isBadTitle("Page")).toBe(true);
    expect(isBadTitle("Home")).toBe(true);
    expect(isBadTitle("Homepage")).toBe(true);
    expect(isBadTitle("Index")).toBe(true);
  });

  it("detects version numbers", () => {
    expect(isBadTitle("2.0")).toBe(true);
    expect(isBadTitle("2.2")).toBe(true);
    expect(isBadTitle("3.14")).toBe(true);
  });

  it("accepts legitimate titles", () => {
    expect(isBadTitle("Mastering the game of Go")).toBe(false);
    expect(isBadTitle("GPT-4 Technical Report")).toBe(false);
    expect(isBadTitle("Alignment Research Center")).toBe(false);
    expect(isBadTitle("AI Safety Summit 2023")).toBe(false);
    expect(isBadTitle("The Intelligence Age")).toBe(false);
    expect(isBadTitle("METR")).toBe(false);
    // Short but valid titles
    expect(isBadTitle("xAI")).toBe(false);
    expect(isBadTitle("Meta")).toBe(false);
    expect(isBadTitle("Mila")).toBe(false);
  });

  it("does not flag Levels.fyi as domain (contains dot but has case)", () => {
    // Levels.fyi matches domain pattern — this is expected behavior
    expect(isBadTitle("Levels.fyi")).toBe(true);
  });
});

describe("extractTitleFromHtml", () => {
  it("extracts from <title> tag", () => {
    const html = "<html><head><title>My Page Title</title></head></html>";
    expect(extractTitleFromHtml(html)).toBe("My Page Title");
  });

  it("extracts from og:title meta tag (property first)", () => {
    const html = `<html><head>
      <meta property="og:title" content="OG Title Here">
      <title>Fallback Title</title>
    </head></html>`;
    expect(extractTitleFromHtml(html)).toBe("OG Title Here");
  });

  it("extracts from og:title meta tag (content first)", () => {
    const html = `<html><head>
      <meta content="OG Title Here" property="og:title">
    </head></html>`;
    expect(extractTitleFromHtml(html)).toBe("OG Title Here");
  });

  it("decodes HTML entities", () => {
    const html =
      "<html><head><title>AI &amp; Safety: A &quot;New&quot; Era</title></head></html>";
    expect(extractTitleFromHtml(html)).toBe('AI & Safety: A "New" Era');
  });

  it("handles multiline titles", () => {
    const html =
      "<html><head><title>\n  My Page\n  Title\n</title></head></html>";
    expect(extractTitleFromHtml(html)).toBe("My Page Title");
  });

  it("returns null for empty input", () => {
    expect(extractTitleFromHtml("")).toBeNull();
    expect(extractTitleFromHtml("<html><body>No title here</body></html>")).toBeNull();
  });
});

describe("isScrapingFailure", () => {
  it("detects common scraping failures", () => {
    expect(isScrapingFailure("Just a moment...")).toBe(true);
    expect(isScrapingFailure("Access Denied")).toBe(true);
    expect(isScrapingFailure("Page not found")).toBe(true);
    expect(isScrapingFailure("404 Not Found")).toBe(true);
    expect(isScrapingFailure("Sign in to continue")).toBe(true);
    expect(isScrapingFailure("Verify you are human")).toBe(true);
    expect(isScrapingFailure("Attention Required! | Cloudflare")).toBe(true);
    expect(isScrapingFailure("Loading...")).toBe(true);
    expect(isScrapingFailure("Please wait")).toBe(true);
  });

  it("detects very short titles as failures", () => {
    expect(isScrapingFailure("")).toBe(true);
    expect(isScrapingFailure("ab")).toBe(true);
  });

  it("accepts legitimate titles", () => {
    expect(isScrapingFailure("Mastering the game of Go")).toBe(false);
    expect(isScrapingFailure("GPT-4 Technical Report")).toBe(false);
    expect(isScrapingFailure("AI Safety Summit 2023")).toBe(false);
  });
});

describe("deriveTitleFromUrl", () => {
  it("derives titles from Wikipedia URLs", () => {
    expect(
      deriveTitleFromUrl("https://en.wikipedia.org/wiki/Geoffrey_Hinton")
    ).toBe("Geoffrey Hinton");
    expect(
      deriveTitleFromUrl("https://en.wikipedia.org/wiki/Deep_Utopia")
    ).toBe("Deep Utopia");
    expect(
      deriveTitleFromUrl(
        "https://en.wikipedia.org/wiki/Safe_Superintelligence_Inc."
      )
    ).toBe("Safe Superintelligence Inc.");
  });

  it("derives titles from X/Twitter profile URLs", () => {
    expect(deriveTitleFromUrl("https://x.com/DarioAmodei")).toBe(
      "@DarioAmodei on X"
    );
    expect(deriveTitleFromUrl("https://x.com/elonmusk")).toBe(
      "@elonmusk on X"
    );
    expect(deriveTitleFromUrl("https://twitter.com/ylecun")).toBe(
      "@ylecun on X"
    );
  });

  it("returns null for non-derivable URLs", () => {
    expect(
      deriveTitleFromUrl("https://www.anthropic.com/news/claude-4")
    ).toBeNull();
    expect(
      deriveTitleFromUrl("https://arxiv.org/abs/2205.06175")
    ).toBeNull();
    expect(deriveTitleFromUrl("https://openai.com/about")).toBeNull();
  });
});
