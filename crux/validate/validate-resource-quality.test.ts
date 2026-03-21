/**
 * Tests for the resource data quality validator.
 *
 * Uses inline test resources (not the real snapshot) to validate detection
 * of corrupted titles, bad authors, type contradictions, and other
 * data quality issues.
 */

import { describe, it, expect } from "vitest";
import {
  checkResource,
  validateResourceQuality,
  extractMeaningfulWords,
  extractUrlWords,
  PLATFORM_AUTHOR_NAMES,
} from "./validate-resource-quality.ts";
import type { Resource } from "../resource-types.ts";

function makeResource(overrides: Partial<Resource>): Resource {
  return {
    id: "test-001",
    url: "https://example.com/article",
    title: "A Normal Title",
    type: "article",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// CI-blocking checks (errors)
// ---------------------------------------------------------------------------

describe("HTML in titles (blocking)", () => {
  it("detects <meta> tags in title", () => {
    const issues = checkResource(
      makeResource({ title: '<meta name="description" content="test">' })
    );
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("HTML tags");
  });

  it("detects <script> tags in title", () => {
    const issues = checkResource(
      makeResource({ title: '<script>alert("xss")</script>' })
    );
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].message).toContain("HTML tags");
  });

  it("detects <div> tags in title", () => {
    const issues = checkResource(
      makeResource({ title: "<div class='content'>Some text</div>" })
    );
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("HTML tags");
  });

  it("detects <link> tags in title", () => {
    const issues = checkResource(
      makeResource({ title: '<link rel="stylesheet" href="style.css">' })
    );
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors).toHaveLength(1);
  });

  it("detects <title> tags in title", () => {
    const issues = checkResource(
      makeResource({ title: "<title>Page Title</title>" })
    );
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors).toHaveLength(1);
  });

  it("does not flag titles that happen to contain angle brackets in non-tag context", () => {
    const issues = checkResource(
      makeResource({ title: "Performance: 5x > baseline, latency < 100ms" })
    );
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors).toHaveLength(0);
  });

  it("does not flag normal titles", () => {
    const issues = checkResource(
      makeResource({
        title: "Artificial Intelligence and Machine Learning Safety",
      })
    );
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors).toHaveLength(0);
  });
});

describe("URL-as-title detection (blocking)", () => {
  it("detects http:// URL as title", () => {
    const issues = checkResource(
      makeResource({ title: "http://example.com/some-article" })
    );
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.some((e) => e.message.includes("raw URL"))).toBe(true);
  });

  it("detects https:// URL as title", () => {
    const issues = checkResource(
      makeResource({ title: "https://arxiv.org/abs/2301.12345" })
    );
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors.some((e) => e.message.includes("raw URL"))).toBe(true);
  });

  it("detects URL with leading whitespace", () => {
    const issues = checkResource(
      makeResource({ title: "  https://example.com/page  " })
    );
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors.some((e) => e.message.includes("raw URL"))).toBe(true);
  });

  it("does not flag titles that mention URLs in text", () => {
    const issues = checkResource(
      makeResource({
        title: "How to configure https:// on your server",
      })
    );
    // "How to configure" before the URL means it's not a URL-only title
    const urlErrors = issues.filter(
      (i) => i.severity === "error" && i.message.includes("raw URL")
    );
    expect(urlErrors).toHaveLength(0);
  });
});

describe("Non-printable character detection (blocking)", () => {
  it("detects null bytes in title", () => {
    const issues = checkResource(
      makeResource({ title: "Normal\x00Title" })
    );
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors.some((e) => e.message.includes("non-printable"))).toBe(true);
  });

  it("detects control characters in title", () => {
    const issues = checkResource(
      makeResource({ title: "Title with\x01bell\x07chars" })
    );
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors.some((e) => e.message.includes("non-printable"))).toBe(true);
  });

  it("allows tabs, newlines, and carriage returns", () => {
    const issues = checkResource(
      makeResource({ title: "Title with\ttab and\nnewline" })
    );
    const nonPrintableErrors = issues.filter(
      (i) => i.severity === "error" && i.message.includes("non-printable")
    );
    expect(nonPrintableErrors).toHaveLength(0);
  });
});

describe("Title length limit (blocking)", () => {
  it("flags titles over 500 characters", () => {
    const longTitle = "A".repeat(501);
    const issues = checkResource(makeResource({ title: longTitle }));
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors.some((e) => e.message.includes("501 characters"))).toBe(
      true
    );
  });

  it("allows titles at exactly 500 characters", () => {
    const exactTitle = "A".repeat(500);
    const issues = checkResource(makeResource({ title: exactTitle }));
    const lengthErrors = issues.filter(
      (i) => i.severity === "error" && i.message.includes("characters")
    );
    expect(lengthErrors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Advisory checks (warnings)
// ---------------------------------------------------------------------------

describe("Platform name author detection (warning)", () => {
  it("detects Substack as author", () => {
    const issues = checkResource(
      makeResource({ authors: ["Substack"] })
    );
    const warnings = issues.filter((i) => i.severity === "warning");
    expect(warnings.some((w) => w.message.includes("platform name"))).toBe(
      true
    );
  });

  it("detects Medium as author (case-insensitive)", () => {
    const issues = checkResource(
      makeResource({ authors: ["medium"] })
    );
    const warnings = issues.filter((i) => i.severity === "warning");
    expect(warnings.some((w) => w.message.includes("platform name"))).toBe(
      true
    );
  });

  it("detects YouTube as author", () => {
    const issues = checkResource(
      makeResource({ authors: ["YouTube"] })
    );
    const warnings = issues.filter((i) => i.severity === "warning");
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });

  it("flags all documented platform names", () => {
    for (const platform of PLATFORM_AUTHOR_NAMES) {
      const issues = checkResource(
        makeResource({
          id: `test-${platform}`,
          authors: [platform],
        })
      );
      const warnings = issues.filter(
        (i) => i.severity === "warning" && i.message.includes("platform name")
      );
      expect(warnings).toHaveLength(1);
    }
  });

  it("does not flag real author names", () => {
    const issues = checkResource(
      makeResource({
        authors: ["John Smith", "Jane Doe", "Stuart Russell"],
      })
    );
    const platformWarnings = issues.filter(
      (i) => i.severity === "warning" && i.message.includes("platform name")
    );
    expect(platformWarnings).toHaveLength(0);
  });

  it("does not flag when authors is undefined", () => {
    const issues = checkResource(
      makeResource({ authors: undefined })
    );
    const platformWarnings = issues.filter(
      (i) => i.severity === "warning" && i.message.includes("platform name")
    );
    expect(platformWarnings).toHaveLength(0);
  });
});

describe("Type/subtype contradiction detection (warning)", () => {
  it("detects paper type with blog subtype", () => {
    const issues = checkResource(
      makeResource({
        type: "paper",
        resource_subtype: "blog_post",
      })
    );
    const warnings = issues.filter(
      (i) =>
        i.severity === "warning" &&
        i.message.includes("type=paper") &&
        i.message.includes("subtype")
    );
    expect(warnings).toHaveLength(1);
  });

  it("detects paper type with news subtype", () => {
    const issues = checkResource(
      makeResource({
        type: "paper",
        resource_subtype: "news_article",
      })
    );
    const warnings = issues.filter(
      (i) => i.severity === "warning" && i.message.includes("type=paper")
    );
    expect(warnings).toHaveLength(1);
  });

  it("detects blog type with paper subtype", () => {
    const issues = checkResource(
      makeResource({
        type: "blog",
        resource_subtype: "academic_paper",
      })
    );
    const warnings = issues.filter(
      (i) => i.severity === "warning" && i.message.includes("type=blog")
    );
    expect(warnings).toHaveLength(1);
  });

  it("does not flag matching type and subtype", () => {
    const issues = checkResource(
      makeResource({
        type: "paper",
        resource_subtype: "research_paper",
      })
    );
    const contradictions = issues.filter(
      (i) => i.severity === "warning" && i.message.includes("subtype suggests")
    );
    expect(contradictions).toHaveLength(0);
  });

  it("does not flag when subtype is missing", () => {
    const issues = checkResource(
      makeResource({
        type: "paper",
        resource_subtype: undefined,
      })
    );
    const contradictions = issues.filter(
      (i) => i.severity === "warning" && i.message.includes("subtype")
    );
    expect(contradictions).toHaveLength(0);
  });
});

describe("Domain-only title detection (warning)", () => {
  it("detects bare domain as title", () => {
    const issues = checkResource(
      makeResource({ title: "example.com" })
    );
    const warnings = issues.filter(
      (i) => i.severity === "warning" && i.message.includes("domain name only")
    );
    expect(warnings).toHaveLength(1);
  });

  it("detects www-prefixed domain as title", () => {
    const issues = checkResource(
      makeResource({ title: "www.example.com" })
    );
    const warnings = issues.filter(
      (i) => i.severity === "warning" && i.message.includes("domain name only")
    );
    expect(warnings).toHaveLength(1);
  });

  it("detects subdomain as title", () => {
    const issues = checkResource(
      makeResource({ title: "blog.example.co.uk" })
    );
    const warnings = issues.filter(
      (i) => i.severity === "warning" && i.message.includes("domain name only")
    );
    expect(warnings).toHaveLength(1);
  });

  it("does not flag normal titles", () => {
    const issues = checkResource(
      makeResource({ title: "AI Safety Research Overview" })
    );
    const domainWarnings = issues.filter(
      (i) => i.severity === "warning" && i.message.includes("domain name only")
    );
    expect(domainWarnings).toHaveLength(0);
  });
});

describe("Title-URL overlap detection (warning)", () => {
  it("warns when title has no word overlap with URL", () => {
    const issues = checkResource(
      makeResource({
        title: "Quantum Computing Advances Today",
        url: "https://example.com/safety/alignment-research",
      })
    );
    const warnings = issues.filter(
      (i) => i.severity === "warning" && i.message.includes("zero word overlap")
    );
    expect(warnings).toHaveLength(1);
  });

  it("does not warn when title overlaps with URL path", () => {
    const issues = checkResource(
      makeResource({
        title: "AI Safety Research Paper",
        url: "https://example.com/ai-safety/research",
      })
    );
    const overlapWarnings = issues.filter(
      (i) => i.severity === "warning" && i.message.includes("zero word overlap")
    );
    expect(overlapWarnings).toHaveLength(0);
  });

  it("does not warn when title overlaps with domain", () => {
    const issues = checkResource(
      makeResource({
        title: "OpenAI Research Lab",
        url: "https://openai.com/blog/post-123",
      })
    );
    const overlapWarnings = issues.filter(
      (i) => i.severity === "warning" && i.message.includes("zero word overlap")
    );
    expect(overlapWarnings).toHaveLength(0);
  });

  it("skips check for very short titles", () => {
    const issues = checkResource(
      makeResource({
        title: "AI",
        url: "https://example.com/something-unrelated",
      })
    );
    // "AI" is only 2 chars and would have <2 meaningful words, so check is skipped
    const overlapWarnings = issues.filter(
      (i) => i.severity === "warning" && i.message.includes("zero word overlap")
    );
    expect(overlapWarnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: validateResourceQuality with inline data
// ---------------------------------------------------------------------------

describe("validateResourceQuality", () => {
  it("returns errors and warnings from inline resources", () => {
    const resources: Resource[] = [
      makeResource({
        id: "r-clean",
        title: "Clean Resource Title",
        url: "https://example.com/clean-resource",
      }),
      makeResource({
        id: "r-html",
        title: '<meta charset="utf-8">Page',
        url: "https://example.com/broken",
      }),
      makeResource({
        id: "r-platform-author",
        title: "Some Blog Post",
        url: "https://example.com/blog-post",
        authors: ["Substack"],
      }),
    ];

    const result = validateResourceQuality({ resources });

    expect(result.totalResources).toBe(3);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors.some((e) => e.includes("r-html"))).toBe(true);
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    expect(result.warnings.some((w) => w.includes("r-platform-author"))).toBe(
      true
    );
  });

  it("returns empty results for clean resources", () => {
    const resources: Resource[] = [
      makeResource({
        id: "r1",
        title: "Alignment Research Overview",
        url: "https://example.com/alignment-research",
        authors: ["Stuart Russell"],
        type: "paper",
      }),
    ];

    const result = validateResourceQuality({ resources });
    expect(result.errors).toHaveLength(0);
    // May have some warnings (e.g., title/URL overlap) depending on content
  });

  it("returns empty arrays when no resources provided", () => {
    const result = validateResourceQuality({ resources: [] });
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
    expect(result.totalResources).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Utility function tests
// ---------------------------------------------------------------------------

describe("extractMeaningfulWords", () => {
  it("strips stop words", () => {
    const words = extractMeaningfulWords("The Quick Brown Fox and the Lazy Dog");
    expect(words.has("quick")).toBe(true);
    expect(words.has("brown")).toBe(true);
    expect(words.has("the")).toBe(false);
    expect(words.has("and")).toBe(false);
  });

  it("lowercases all words", () => {
    const words = extractMeaningfulWords("AI Safety Research");
    expect(words.has("safety")).toBe(true);
    expect(words.has("research")).toBe(true);
  });

  it("filters single-character words", () => {
    const words = extractMeaningfulWords("I am a researcher");
    expect(words.has("researcher")).toBe(true);
    expect(words.has("i")).toBe(false);
  });
});

describe("extractUrlWords", () => {
  it("extracts words from URL path", () => {
    const words = extractUrlWords("https://example.com/ai-safety/research");
    expect(words.has("ai")).toBe(true);
    expect(words.has("safety")).toBe(true);
    expect(words.has("research")).toBe(true);
  });

  it("extracts words from domain", () => {
    const words = extractUrlWords("https://openai.com/blog");
    expect(words.has("openai")).toBe(true);
    expect(words.has("blog")).toBe(true);
  });

  it("handles invalid URLs gracefully", () => {
    const words = extractUrlWords("not a url");
    expect(words.size).toBe(0);
  });

  it("strips www prefix", () => {
    const words = extractUrlWords("https://www.example.com/test");
    expect(words.has("www")).toBe(false);
    expect(words.has("example")).toBe(true);
  });

  it("splits camelCase in path segments", () => {
    const words = extractUrlWords(
      "https://example.com/alignmentResearch"
    );
    expect(words.has("alignment")).toBe(true);
    expect(words.has("research")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edge cases and adversarial inputs
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("handles empty title gracefully", () => {
    const issues = checkResource(makeResource({ title: "" }));
    // Empty title should not crash, and should not flag HTML or URL errors
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors).toHaveLength(0);
  });

  it("handles empty URL gracefully", () => {
    const issues = checkResource(
      makeResource({ title: "Valid Title", url: "" })
    );
    // Should not crash
    expect(issues).toBeDefined();
  });

  it("handles resource with all fields undefined", () => {
    const resource: Resource = {
      id: "bare",
      url: "",
      title: "",
      type: "",
    };
    const issues = checkResource(resource);
    expect(issues).toBeDefined();
    expect(Array.isArray(issues)).toBe(true);
  });

  it("handles multiple issues on same resource", () => {
    const issues = checkResource(
      makeResource({
        title: "<script>alert('xss')</script>",
        authors: ["YouTube"],
        type: "paper",
        resource_subtype: "blog",
      })
    );
    // Should have at least HTML error + platform author warning + type contradiction warning
    expect(issues.length).toBeGreaterThanOrEqual(3);
  });

  it("handles title with mixed valid and invalid content", () => {
    // Title starts with HTML but also has real text
    const issues = checkResource(
      makeResource({
        title: '<meta name="robots">Important AI Safety Paper',
      })
    );
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors.some((e) => e.message.includes("HTML tags"))).toBe(true);
  });
});
