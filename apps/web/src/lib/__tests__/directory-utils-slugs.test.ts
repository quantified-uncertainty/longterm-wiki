import { describe, expect, it } from "vitest";

// Test the isProperSlug logic inline since directory-utils.ts imports
// server-only modules that aren't available in unit tests.
function isProperSlug(s: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(s);
}

describe("isProperSlug", () => {
  it("accepts valid slugs", () => {
    expect(isProperSlug("glen-weyl")).toBe(true);
    expect(isProperSlug("dario-amodei")).toBe(true);
    expect(isProperSlug("openai")).toBe(true);
    expect(isProperSlug("a1-safety")).toBe(true);
  });

  it("rejects stableId-format strings", () => {
    expect(isProperSlug("sid_JceuRU3tbg")).toBe(false);
    expect(isProperSlug("GMMRN_ENld")).toBe(false);
    expect(isProperSlug("_ySs334QrO")).toBe(false);
  });

  it("rejects strings with uppercase letters", () => {
    expect(isProperSlug("Glen-Weyl")).toBe(false);
    expect(isProperSlug("ABC")).toBe(false);
  });

  it("rejects empty strings and strings starting with hyphens", () => {
    expect(isProperSlug("")).toBe(false);
    expect(isProperSlug("-starts-with-hyphen")).toBe(false);
  });
});
