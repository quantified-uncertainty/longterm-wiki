import { describe, expect, it } from "vitest";
import { isHiddenPerson } from "../hidden-people";

describe("isHiddenPerson", () => {
  it("matches hidden slugs", () => {
    expect(isHiddenPerson("olivia-jimenez")).toBe(true);
  });

  it("matches hidden names regardless of case, punctuation and accents", () => {
    expect(isHiddenPerson("Olivia Jimenez")).toBe(true);
    expect(isHiddenPerson("olivia g jimenez")).toBe(true);
    expect(isHiddenPerson("Olivia Jiménez")).toBe(true);
    expect(isHiddenPerson("new:Olivia G. Jimenez")).toBe(true);
  });

  it("checks every candidate and ignores empty ones", () => {
    expect(isHiddenPerson(null, undefined, "sid_abc", "Olivia Jimenez")).toBe(true);
  });

  it("does not match other people", () => {
    expect(isHiddenPerson("jason-green-lowe", "Jason Green-Lowe")).toBe(false);
    expect(isHiddenPerson("Olivia Alperstein")).toBe(false);
    expect(isHiddenPerson()).toBe(false);
  });
});
