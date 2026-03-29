import { describe, it, expect, vi } from "vitest";

// Mock the logger to suppress error output in tests
vi.mock("../logger.js", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

const { urlVariants } = await import("../routes/shared/url-variants.js");

describe("urlVariants", () => {
  it("generates www and non-www variants", () => {
    const variants = urlVariants("https://example.com");
    expect(variants).toContain("https://example.com");
    expect(variants).toContain("https://www.example.com");
  });

  it("generates trailing-slash variants", () => {
    const variants = urlVariants("https://example.com");
    expect(variants).toContain("https://example.com/");
    expect(variants).toContain("https://www.example.com/");
  });

  it("strips trailing slash from base and adds it as variant", () => {
    const variants = urlVariants("https://example.com/page/");
    expect(variants).toContain("https://example.com/page");
    expect(variants).toContain("https://example.com/page/");
  });

  it("generates non-www variant when input has www", () => {
    const variants = urlVariants("https://www.example.com/path");
    expect(variants).toContain("https://example.com/path");
    expect(variants).toContain("https://www.example.com/path");
  });

  it("returns all 4 canonical variants for a simple URL", () => {
    const variants = urlVariants("https://example.com");
    // Without www, with www, each with and without trailing slash
    expect(new Set(variants).size).toBe(4);
    expect(variants).toContain("https://example.com");
    expect(variants).toContain("https://example.com/");
    expect(variants).toContain("https://www.example.com");
    expect(variants).toContain("https://www.example.com/");
  });

  it("two URLs that are www-variants of each other have overlapping variant sets", () => {
    const v1 = new Set(urlVariants("https://example.com"));
    const v2 = new Set(urlVariants("https://www.example.com"));
    // They should produce the same set of variants
    expect(v1).toEqual(v2);
  });

  it("handles invalid URLs gracefully (returns input as-is)", () => {
    const variants = urlVariants("not-a-url");
    expect(variants).toContain("not-a-url");
    expect(variants).toHaveLength(1);
  });

  it("preserves path and query parameters", () => {
    const variants = urlVariants("https://example.com/path?q=1&r=2");
    expect(variants).toContain("https://example.com/path?q=1&r=2");
    expect(variants).toContain("https://www.example.com/path?q=1&r=2");
  });

  it("handles http URLs", () => {
    const variants = urlVariants("http://example.com");
    expect(variants).toContain("http://example.com");
    expect(variants).toContain("http://www.example.com");
  });
});
