import { describe, expect, it } from "vitest";
import {
  parseNumericOrRange,
  numericValue,
  formatStake,
  formatAmount,
} from "../[slug]/org-data";

describe("parseNumericOrRange", () => {
  it("returns a single number as-is", () => {
    expect(parseNumericOrRange(42)).toBe(42);
    expect(parseNumericOrRange(0)).toBe(0);
    expect(parseNumericOrRange(-5.5)).toBe(-5.5);
  });

  it("returns a 2-element numeric array as a tuple", () => {
    const result = parseNumericOrRange([10, 20]);
    expect(result).toEqual([10, 20]);
  });

  it("returns null for non-numeric values", () => {
    expect(parseNumericOrRange("hello")).toBeNull();
    expect(parseNumericOrRange(null)).toBeNull();
    expect(parseNumericOrRange(undefined)).toBeNull();
    expect(parseNumericOrRange(true)).toBeNull();
  });

  it("returns null for arrays that are not 2-element numeric", () => {
    expect(parseNumericOrRange([1])).toBeNull();
    expect(parseNumericOrRange([1, 2, 3])).toBeNull();
    expect(parseNumericOrRange(["a", "b"])).toBeNull();
    expect(parseNumericOrRange([1, "b"])).toBeNull();
    expect(parseNumericOrRange([])).toBeNull();
  });
});

describe("numericValue", () => {
  it("returns 0 for null", () => {
    expect(numericValue(null)).toBe(0);
  });

  it("returns the number for a scalar", () => {
    expect(numericValue(42)).toBe(42);
    expect(numericValue(0)).toBe(0);
  });

  it("returns the midpoint for a range", () => {
    expect(numericValue([10, 20])).toBe(15);
    expect(numericValue([0, 100])).toBe(50);
    expect(numericValue([5, 5])).toBe(5);
  });
});

describe("formatStake", () => {
  it("formats a single number as a percentage", () => {
    expect(formatStake(0.15)).toBe("15%");
    expect(formatStake(0.051)).toBe("5.1%");
    expect(formatStake(1)).toBe("100%");
  });

  it("formats a range as min%\u2013max%", () => {
    expect(formatStake([0.1, 0.2])).toBe("10%\u201320%");
    expect(formatStake([0.051, 0.149])).toBe("5.1%\u201314.9%");
  });
});

describe("formatAmount", () => {
  it("returns null for null/undefined", () => {
    expect(formatAmount(null)).toBeNull();
    expect(formatAmount(undefined)).toBeNull();
  });

  it("formats a single number", () => {
    const result = formatAmount(1_000_000);
    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
  });

  it("formats a range as min\u2013max", () => {
    const result = formatAmount([500_000, 1_000_000]);
    expect(result).toBeTruthy();
    expect(result).toContain("\u2013");
  });

  it("returns the string representation for non-numeric strings", () => {
    expect(formatAmount("unknown")).toBe("unknown");
  });
});
