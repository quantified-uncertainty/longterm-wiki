import { describe, it, expect } from "vitest";
import {
  buildPrefixTsquery,
  titleMatchBoostExpr,
  isAcronymQuery,
  normalizeSearchQuery,
  TRIGRAM_SIMILARITY_THRESHOLD,
  TRIGRAM_FALLBACK_THRESHOLD,
  TS_HEADLINE_OPTIONS,
} from "../search-utils.js";

describe("buildPrefixTsquery", () => {
  it("converts single word to prefix query", () => {
    expect(buildPrefixTsquery("alignment")).toBe("alignment:*");
  });

  it("ANDs multiple words with prefix", () => {
    expect(buildPrefixTsquery("AI safety")).toBe("AI:* & safety:*");
  });

  it("returns empty string for empty input", () => {
    expect(buildPrefixTsquery("")).toBe("");
    expect(buildPrefixTsquery("   ")).toBe("");
  });

  it("strips special characters to prevent tsquery syntax errors", () => {
    expect(buildPrefixTsquery("hello!world")).toBe("hello:* & world:*");
    expect(buildPrefixTsquery("test's (query)")).toBe("test:* & s:* & query:*");
    expect(buildPrefixTsquery("$100 <html>")).toBe("100:* & html:*");
  });

  it("preserves hyphens in words", () => {
    expect(buildPrefixTsquery("x-risk")).toBe("x-risk:*");
  });

  it("handles input that is only special characters", () => {
    expect(buildPrefixTsquery("!@#$%")).toBe("");
  });

  it("collapses multiple spaces", () => {
    expect(buildPrefixTsquery("  AI   safety  ")).toBe("AI:* & safety:*");
  });

  it("handles numbers", () => {
    expect(buildPrefixTsquery("gpt 4")).toBe("gpt:* & 4:*");
  });
});

describe("isAcronymQuery", () => {
  it("detects uppercase acronyms of 2-4 chars", () => {
    expect(isAcronymQuery("ARC")).toBe(true);
    expect(isAcronymQuery("AI")).toBe(true);
    expect(isAcronymQuery("MIRI")).toBe(true);
  });

  it("rejects lowercase or mixed-case strings", () => {
    expect(isAcronymQuery("arc")).toBe(false);
    expect(isAcronymQuery("Arc")).toBe(false);
    expect(isAcronymQuery("aRC")).toBe(false);
  });

  it("rejects strings that are too short or too long", () => {
    expect(isAcronymQuery("A")).toBe(false);
    expect(isAcronymQuery("ABCDE")).toBe(false);
  });

  it("rejects strings with non-alpha characters", () => {
    expect(isAcronymQuery("A1")).toBe(false);
    expect(isAcronymQuery("AI!")).toBe(false);
    expect(isAcronymQuery("")).toBe(false);
  });

  it("trims whitespace before checking", () => {
    expect(isAcronymQuery("  ARC  ")).toBe(true);
    expect(isAcronymQuery(" AI ")).toBe(true);
  });
});

describe("titleMatchBoostExpr", () => {
  it("returns valid SQL CASE expression with starts_with instead of LIKE", () => {
    const expr = titleMatchBoostExpr("title", "$1");
    expect(expr).toContain("CASE");
    expect(expr).toContain("lower(title)");
    expect(expr).toContain("lower($1)");
    expect(expr).toContain("1000");  // exact match bonus
    expect(expr).toContain("500");   // acronym-in-parentheses bonus
    expect(expr).toContain("100");   // prefix match bonus
    expect(expr).toContain("starts_with");  // safe: no LIKE special chars
    expect(expr).not.toContain("LIKE");     // no LIKE = no %, _ issues
  });

  it("includes acronym-in-parentheses boost via position()", () => {
    const expr = titleMatchBoostExpr("title", "$1");
    // The expression should look for "(QUERY)" in the title using upper()
    expect(expr).toContain("upper($1)");
    expect(expr).toContain("500");
  });

  it("uses the provided column and param references", () => {
    const expr = titleMatchBoostExpr("wp.title", "$3");
    expect(expr).toContain("lower(wp.title)");
    expect(expr).toContain("lower($3)");
    expect(expr).toContain("upper($3)");
  });
});

describe("search constants", () => {
  it("has reasonable trigram similarity threshold", () => {
    expect(TRIGRAM_SIMILARITY_THRESHOLD).toBeGreaterThan(0);
    expect(TRIGRAM_SIMILARITY_THRESHOLD).toBeLessThan(1);
  });

  it("has reasonable fallback threshold", () => {
    expect(TRIGRAM_FALLBACK_THRESHOLD).toBeGreaterThanOrEqual(1);
    expect(TRIGRAM_FALLBACK_THRESHOLD).toBeLessThan(20);
  });

  it("ts_headline options include mark tags", () => {
    expect(TS_HEADLINE_OPTIONS).toContain("<mark>");
    expect(TS_HEADLINE_OPTIONS).toContain("</mark>");
  });
});

describe("normalizeSearchQuery", () => {
  it("inserts space between letters and digits", () => {
    expect(normalizeSearchQuery("sb1047")).toBe("sb 1047");
    expect(normalizeSearchQuery("gpt4")).toBe("gpt 4");
    expect(normalizeSearchQuery("AI2")).toBe("AI 2");
  });

  it("inserts space between digits and letters", () => {
    expect(normalizeSearchQuery("4chan")).toBe("4 chan");
    expect(normalizeSearchQuery("3Blue1Brown")).toBe("3 Blue 1 Brown");
  });

  it("leaves already-spaced queries unchanged", () => {
    expect(normalizeSearchQuery("sb 1047")).toBe("sb 1047");
    expect(normalizeSearchQuery("gpt 4")).toBe("gpt 4");
    expect(normalizeSearchQuery("Anthropic")).toBe("Anthropic");
  });

  it("leaves pure text or pure numbers unchanged", () => {
    expect(normalizeSearchQuery("alignment")).toBe("alignment");
    expect(normalizeSearchQuery("12345")).toBe("12345");
    expect(normalizeSearchQuery("")).toBe("");
  });

  it("handles multiple transitions", () => {
    expect(normalizeSearchQuery("a1b2c3")).toBe("a 1 b 2 c 3");
  });
});
