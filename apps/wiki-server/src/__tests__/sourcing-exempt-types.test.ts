import { describe, it, expect } from "vitest";
import {
  SOURCING_EXEMPT_TYPES,
  VALID_RECORD_TYPES,
  isSourcingExempt,
} from "../api-types.js";

describe("SOURCING_EXEMPT_TYPES", () => {
  it("contains only types that are also in VALID_RECORD_TYPES or are known non-VALID types", () => {
    // Every exempt type should either be a valid record type (subset of existing types)
    // or a known type that exists in the system but isn't in VALID_RECORD_TYPES.
    // This prevents typos in the exempt list from silently passing.
    const knownTypes = new Set([
      ...VALID_RECORD_TYPES,
      // Types that exist in the system but aren't in VALID_RECORD_TYPES:
      "prediction-market-questions",
      "platform-accounts",
      "bluesky",
      "website-sources",
      "data-sources",
    ]);

    for (const exemptType of SOURCING_EXEMPT_TYPES) {
      expect(
        knownTypes.has(exemptType),
        `Exempt type "${exemptType}" is not a known record type — possible typo`,
      ).toBe(true);
    }
  });

  it("does not contain all VALID_RECORD_TYPES (some must remain non-exempt)", () => {
    // Sanity check: at least some record types should require verification
    const nonExemptCount = VALID_RECORD_TYPES.filter(
      (t) => !isSourcingExempt(t),
    ).length;
    expect(nonExemptCount).toBeGreaterThan(0);
    // At minimum, personnel and grants should always require verification
    expect(isSourcingExempt("personnel")).toBe(false);
    expect(isSourcingExempt("grant")).toBe(false);
  });

  it("has no duplicates", () => {
    const unique = new Set(SOURCING_EXEMPT_TYPES);
    expect(unique.size).toBe(SOURCING_EXEMPT_TYPES.length);
  });
});

describe("isSourcingExempt", () => {
  it("returns true for exempt types", () => {
    for (const t of SOURCING_EXEMPT_TYPES) {
      expect(isSourcingExempt(t)).toBe(true);
    }
  });

  it("returns false for non-exempt record types", () => {
    expect(isSourcingExempt("personnel")).toBe(false);
    expect(isSourcingExempt("grant")).toBe(false);
    expect(isSourcingExempt("division")).toBe(false);
    expect(isSourcingExempt("investment")).toBe(false);
    expect(isSourcingExempt("funding-round")).toBe(false);
  });

  it("returns false for unknown/empty strings", () => {
    expect(isSourcingExempt("")).toBe(false);
    expect(isSourcingExempt("nonexistent-type")).toBe(false);
    expect(isSourcingExempt("BENCHMARK-RESULT")).toBe(false); // case-sensitive
  });

  it("currently exempts the expected types", () => {
    // This test documents the current exempt list.
    // Update this when adding/removing exempt types.
    expect(isSourcingExempt("benchmark-result")).toBe(true);
    expect(isSourcingExempt("citation")).toBe(true);
    expect(isSourcingExempt("entity-assessment")).toBe(true);
    expect(isSourcingExempt("secondary-market-price")).toBe(true);
  });

  it("does not exempt core verification-required types", () => {
    const mustVerify = [
      "personnel",
      "grant",
      "division",
      "funding-program",
      "funding-round",
      "investment",
      "equity-position",
      "policy-stakeholder",
      "entity-event",
    ];
    for (const t of mustVerify) {
      expect(
        isSourcingExempt(t),
        `"${t}" should NOT be exempt — it requires sourcing verification`,
      ).toBe(false);
    }
  });
});
