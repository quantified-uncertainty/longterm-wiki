import { describe, it, expect } from "vitest";
import { isFactExpired } from "../factbase";
import type { Fact } from "@longterm-wiki/factbase";

/** Create a minimal fact stub for testing isFactExpired. */
function makeFact(validEnd?: string): Fact {
  return {
    id: "f_test",
    subjectId: "test-entity",
    propertyId: "test-property",
    value: { type: "text", value: "test" },
    validEnd,
  };
}

describe("isFactExpired", () => {
  it("returns false for facts without validEnd", () => {
    expect(isFactExpired(makeFact(undefined))).toBe(false);
  });

  it("returns true for a YYYY date in the past", () => {
    expect(isFactExpired(makeFact("2020"))).toBe(true);
  });

  it("returns true for a YYYY-MM date in the past", () => {
    expect(isFactExpired(makeFact("2020-06"))).toBe(true);
  });

  it("returns true for a YYYY-MM-DD date in the past", () => {
    expect(isFactExpired(makeFact("2020-01-15"))).toBe(true);
  });

  it("returns false for a YYYY date far in the future", () => {
    expect(isFactExpired(makeFact("2099"))).toBe(false);
  });

  it("returns false for a YYYY-MM date in the future", () => {
    expect(isFactExpired(makeFact("2099-12"))).toBe(false);
  });

  it("returns false for a YYYY-MM-DD date in the future", () => {
    expect(isFactExpired(makeFact("2099-12-31"))).toBe(false);
  });
});
