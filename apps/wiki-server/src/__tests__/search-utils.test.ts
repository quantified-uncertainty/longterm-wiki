import { describe, it, expect } from "vitest";
import {
  buildPrefixTsquery,
  titleMatchBoostExpr,
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

describe("titleMatchBoostExpr", () => {
  it("returns valid SQL CASE expression with starts_with instead of LIKE", () => {
    const expr = titleMatchBoostExpr("title", "$1");
    expect(expr).toContain("CASE");
    expect(expr).toContain("lower(title)");
    expect(expr).toContain("lower($1)");
    expect(expr).toContain("1000");  // exact match bonus
    expect(expr).toContain("100");   // prefix match bonus
    expect(expr).toContain("starts_with");  // safe: no LIKE special chars
    expect(expr).not.toContain("LIKE");     // no LIKE = no %, _ issues
  });

  it("uses the provided column and param references", () => {
    const expr = titleMatchBoostExpr("wp.title", "$3");
    expect(expr).toContain("lower(wp.title)");
    expect(expr).toContain("lower($3)");
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
