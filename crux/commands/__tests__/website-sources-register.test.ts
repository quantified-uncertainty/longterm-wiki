import { describe, it, expect } from "vitest";
import { normalizeDomain } from "../website-sources.ts";

describe("normalizeDomain", () => {
  it("extracts hostname without www", () => {
    expect(normalizeDomain("https://www.anthropic.com")).toBe("anthropic.com");
    expect(normalizeDomain("https://anthropic.com")).toBe("anthropic.com");
  });

  it("lowercases the hostname", () => {
    expect(normalizeDomain("https://Anthropic.COM")).toBe("anthropic.com");
  });

  it("strips path, query, fragment", () => {
    expect(
      normalizeDomain("https://example.com/about?ref=x#top"),
    ).toBe("example.com");
  });

  it("trims whitespace", () => {
    expect(normalizeDomain("  https://anthropic.com  ")).toBe("anthropic.com");
  });

  it("returns null on unparseable input", () => {
    expect(normalizeDomain("not a url")).toBeNull();
    expect(normalizeDomain("")).toBeNull();
  });

  it("preserves subdomains other than www", () => {
    expect(normalizeDomain("https://blog.example.com")).toBe("blog.example.com");
    expect(normalizeDomain("https://www.blog.example.com")).toBe(
      "blog.example.com",
    );
  });

  it("handles http and other schemes", () => {
    expect(normalizeDomain("http://example.com")).toBe("example.com");
  });
});
