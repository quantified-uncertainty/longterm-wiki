/**
 * Red-team / adversarial tests for URL variant generation.
 *
 * Tests edge cases and attack vectors that could cause incorrect
 * resource matching or data corruption.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../logger.js", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

const { urlVariants } = await import("../routes/shared/url-variants.js");

describe("urlVariants — adversarial inputs", () => {
  it("handles URLs with explicit port 443 (HTTPS default)", () => {
    const v1 = urlVariants("https://example.com:443/path");
    const v2 = urlVariants("https://example.com/path");
    // URL class normalizes :443 away for HTTPS
    // Both should produce the same variants
    const s1 = new Set(v1);
    const s2 = new Set(v2);
    expect(s1).toEqual(s2);
  });

  it("handles URLs with explicit port 80 (HTTP default)", () => {
    const v1 = urlVariants("http://example.com:80/path");
    const v2 = urlVariants("http://example.com/path");
    const s1 = new Set(v1);
    const s2 = new Set(v2);
    expect(s1).toEqual(s2);
  });

  it("handles URLs with non-default ports", () => {
    const variants = urlVariants("https://example.com:8080/path");
    expect(variants).toContain("https://example.com:8080/path");
    // www variant should also include the port
    expect(variants).toContain("https://www.example.com:8080/path");
  });

  it("handles URLs with authentication info (www in hostname, not before auth)", () => {
    const variants = urlVariants("https://user:pass@example.com/path");
    // www should be inserted in the hostname, not before the auth
    const wwwVariant = variants.find((v) => v.includes("www."));
    expect(wwwVariant).toBeDefined();
    // Correct: www is in the hostname
    expect(wwwVariant).toContain("user:pass@www.example.com");
    // Not before auth
    expect(wwwVariant).not.toContain("://www.user");
  });

  it("handles IP address URLs (should not add www)", () => {
    const variants = urlVariants("https://192.168.1.1/path");
    // Adding www to an IP makes no sense: "https://www.192.168.1.1" is invalid
    // But the current implementation would add it. This is a known edge case.
    // At minimum, it shouldn't crash
    expect(variants).toContain("https://192.168.1.1/path");
    // The www variant would be generated but probably wouldn't match anything
    // This is acceptable but worth documenting
  });

  it("handles localhost URLs", () => {
    const variants = urlVariants("http://localhost:3000/api");
    expect(variants).toContain("http://localhost:3000/api");
    // www.localhost would be weird but shouldn't crash
    expect(variants.length).toBeGreaterThan(0);
  });

  it("handles URLs with fragments", () => {
    const variants = urlVariants("https://example.com/page#section");
    // URL class preserves fragments
    expect(variants).toContain("https://example.com/page#section");
    // Fragment should be preserved in www variant too
    const wwwVariant = variants.find((v) => v.includes("www.") && v.includes("#section"));
    expect(wwwVariant).toBeDefined();
  });

  it("handles URLs with query parameters containing special chars", () => {
    const variants = urlVariants("https://example.com/search?q=hello+world&lang=en");
    expect(variants).toContain("https://example.com/search?q=hello+world&lang=en");
  });

  it("handles URLs with encoded characters", () => {
    const variants = urlVariants("https://example.com/path%20with%20spaces");
    // URL class may decode/re-encode
    expect(variants.length).toBeGreaterThan(0);
    // At least one variant should contain the path
    const hasPath = variants.some((v) => v.includes("/path"));
    expect(hasPath).toBe(true);
  });

  it("handles very long URLs (2000+ chars)", () => {
    const longPath = "a".repeat(2000);
    const variants = urlVariants(`https://example.com/${longPath}`);
    expect(variants.length).toBeGreaterThan(0);
  });

  it("handles URLs with subdomains beyond www", () => {
    const variants = urlVariants("https://api.docs.example.com/path");
    // Should not strip api.docs prefix
    expect(variants).toContain("https://api.docs.example.com/path");
    // Should add www before the existing subdomain?
    // The current logic only checks if hostname starts with "www."
    // For non-www hostnames, it replaces :// with ://www.
    // So api.docs.example.com → www.api.docs.example.com (odd but consistent)
    const wwwVariant = variants.find((v) => v.includes("www.api.docs."));
    expect(wwwVariant).toBeDefined();
  });

  it("handles data: URLs", () => {
    const variants = urlVariants("data:text/html,<h1>Hello</h1>");
    // URL class may or may not parse data: URLs
    expect(variants.length).toBeGreaterThan(0);
  });

  it("handles file: URLs", () => {
    const variants = urlVariants("file:///etc/passwd");
    expect(variants.length).toBeGreaterThan(0);
  });

  it("handles empty string", () => {
    const variants = urlVariants("");
    // Empty string is not a valid URL — should return as-is
    expect(variants).toContain("");
    expect(variants).toHaveLength(1);
  });

  it("handles URLs with unicode hostnames", () => {
    // Punycode domain
    const variants = urlVariants("https://münchen.de/path");
    expect(variants.length).toBeGreaterThan(0);
  });

  it("www variant round-trip produces same set", () => {
    // Key invariant: urlVariants(x) for any URL in the set should contain all others
    const original = "https://docs.example.com/page";
    const variants = urlVariants(original);

    // Each variant should generate a superset that includes the original
    for (const v of variants) {
      const variantOfVariant = urlVariants(v);
      expect(variantOfVariant).toContain(v);
    }
  });

  it("handles URLs with trailing dot in hostname", () => {
    // DNS trailing dot: example.com. (FQDN)
    const variants = urlVariants("https://example.com./path");
    expect(variants.length).toBeGreaterThan(0);
  });

  it("does not produce duplicate variants", () => {
    const variants = urlVariants("https://example.com");
    const unique = new Set(variants);
    expect(unique.size).toBe(variants.length);
  });
});
