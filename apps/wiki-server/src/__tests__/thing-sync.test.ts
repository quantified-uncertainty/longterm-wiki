import { describe, it, expect } from "vitest";
import { hasRawIdLeak } from "../routes/shared/thing-sync.js";

// QUA-397: thing-sync sentinel unit tests.
//
// hasRawIdLeak is the detection predicate used by upsertThingsInTx to warn
// when a sync handler is about to write a raw FactBase/stableId into a
// display column. Regression anchor for QUA-316 / QUA-346 / QUA-354 / QUA-397.
describe("hasRawIdLeak", () => {
  it("detects a raw FactBase fact id embedded in a title", () => {
    expect(hasRawIdLeak("f_mEKUPPFYRg — Google DeepMind")).toBe(true);
  });

  it("detects a raw FactBase fact id inside a description", () => {
    expect(hasRawIdLeak("f_mEKUPPFYRg: 2010-09")).toBe(true);
  });

  it("detects a raw stableId embedded in a title", () => {
    expect(hasRawIdLeak("sid_Aqcyu3onCA — Demis Hassabis")).toBe(true);
  });

  it("detects a bare raw stableId", () => {
    expect(hasRawIdLeak("sid_A4XoubikkQ")).toBe(true);
  });

  it("does not flag legitimate titles containing property slugs", () => {
    expect(hasRawIdLeak("Founded — Google DeepMind")).toBe(false);
    expect(hasRawIdLeak("founded-date — Google DeepMind")).toBe(false);
    expect(hasRawIdLeak("Subsidiary of Alphabet Inc.")).toBe(false);
  });

  it("does not flag entity slugs or short identifiers", () => {
    expect(hasRawIdLeak("google-deepmind")).toBe(false);
    expect(hasRawIdLeak("anthropic → openai")).toBe(false);
    expect(hasRawIdLeak("f_small")).toBe(false); // 5 chars after f_ — below minimum
  });

  it("does not flag null, undefined, or empty input", () => {
    expect(hasRawIdLeak(null)).toBe(false);
    expect(hasRawIdLeak(undefined)).toBe(false);
    expect(hasRawIdLeak("")).toBe(false);
  });

  it("detects raw ids embedded mid-string", () => {
    expect(hasRawIdLeak("revenue: f_abcdefgh12 as of 2024")).toBe(true);
  });

  it("is not fooled by similar-looking but invalid prefixes", () => {
    // Not preceded by a word boundary-breaking char: "xf_abcdefgh12" has a
    // word boundary at the start of "xf_" vs. "f_" — the \b anchor means
    // this substring is NOT matched (the \b is between non-word and word,
    // and 'x' and 'f' are both word chars).
    expect(hasRawIdLeak("xf_abcdefgh12")).toBe(false);
  });
});
