import { describe, it, expect } from "vitest";
import { formatDomainFallback } from "@/app/legislation/source-display-names";

describe("formatDomainFallback", () => {
  it("strips common TLDs and capitalizes", () => {
    expect(formatDomainFallback("example.com")).toBe("Example");
    expect(formatDomainFallback("example.org")).toBe("Example");
    expect(formatDomainFallback("example.net")).toBe("Example");
  });

  it("strips country-code TLDs", () => {
    expect(formatDomainFallback("example.ca")).toBe("Example");
    expect(formatDomainFallback("example.uk")).toBe("Example");
    expect(formatDomainFallback("example.au")).toBe("Example");
    expect(formatDomainFallback("example.eu")).toBe("Example");
  });

  it("strips .ai and .press TLDs", () => {
    expect(formatDomainFallback("securiti.ai")).toBe("Securiti");
    expect(formatDomainFallback("techpolicy.press")).toBe("Techpolicy");
  });

  it("strips common non-informative subdomains", () => {
    expect(formatDomainFallback("about.example.com")).toBe("Example");
    expect(formatDomainFallback("blog.example.com")).toBe("Example");
    expect(formatDomainFallback("blogs.example.com")).toBe("Example");
    expect(formatDomainFallback("news.example.com")).toBe("Example");
    expect(formatDomainFallback("advocacy.example.com")).toBe("Example");
    expect(formatDomainFallback("support.example.com")).toBe("Example");
  });

  it("handles hyphenated domains", () => {
    expect(formatDomainFallback("ised-isde.canada.ca")).toBe("Ised Isde Canada");
  });

  it("handles subdomains that are informative", () => {
    expect(formatDomainFallback("digichina.stanford.edu")).toBe("Digichina Stanford");
    expect(formatDomainFallback("hai.stanford.edu")).toBe("Hai Stanford");
  });

  it("handles compound TLDs", () => {
    expect(formatDomainFallback("example.co.uk")).toBe("Example");
  });

  it("inserts spaces at camelCase boundaries", () => {
    expect(formatDomainFallback("techPolicy.com")).toBe("Tech Policy");
  });

  it("returns non-empty string for single-word domains", () => {
    expect(formatDomainFallback("example.com")).toBe("Example");
  });

  it("handles empty or edge-case input gracefully", () => {
    expect(formatDomainFallback("")).toBe("");
    expect(formatDomainFallback(".com")).toBe("");
  });

  it("handles .gov domains (best-effort without lookup table)", () => {
    // .gov domains with subdomains produce reasonable but imperfect names.
    // Specific domains like gov.ca.gov and sd11.senate.ca.gov are handled by
    // the DOMAIN_DISPLAY_NAMES lookup table, so the fallback only needs to
    // produce something minimally readable.
    expect(formatDomainFallback("pelosi.house.gov")).toBe("Pelosi House");
    expect(formatDomainFallback("klobuchar.senate.gov")).toBe("Klobuchar Senate");
    expect(formatDomainFallback("nist.gov")).toBe("Nist");
  });

  it("handles domains with multiple dots after TLD stripping", () => {
    // After stripping .gov, sd11.senate.ca remains — "ca" is a state subdomain,
    // not a TLD in this context. The lookup table handles this specific case.
    expect(formatDomainFallback("sd11.senate.ca.gov")).toBe("Sd11 Senate Ca");
    expect(formatDomainFallback("gov.ca.gov")).toBe("Gov Ca");
  });

  it("previously ugly names are now improved with subdomain stripping", () => {
    // "about.fb.com" was producing "About Fb" - now strips "about" subdomain
    expect(formatDomainFallback("about.fb.com")).toBe("Fb");
    // "advocacy.calchamber.com" was producing "Advocacy Calchamber"
    expect(formatDomainFallback("advocacy.calchamber.com")).toBe("Calchamber");
    // "blog.google" should strip "blog" and ".google" TLD issue
    expect(formatDomainFallback("blogs.microsoft.com")).toBe("Microsoft");
  });
});
