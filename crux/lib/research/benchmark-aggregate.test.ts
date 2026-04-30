import { describe, it, expect } from "vitest";

import {
  computeAggregate,
  median,
  percentile,
  type SuiteEntityResult,
} from "./benchmark-aggregate.ts";

function entry(slug: string, score: number, min = 0): SuiteEntityResult {
  return { slug, type: "policy", coverage_score: score, expected_min_coverage: min };
}

describe("percentile", () => {
  it("returns 0 on empty input", () => {
    expect(percentile([], 0.5)).toBe(0);
  });

  it("returns the lone value for a single sample", () => {
    expect(percentile([0.42], 0)).toBe(0.42);
    expect(percentile([0.42], 0.5)).toBe(0.42);
    expect(percentile([0.42], 1)).toBe(0.42);
  });

  it("matches numpy linear interpolation on a known distribution", () => {
    // np.percentile([1,2,3,4,5], 25) === 2.0; p50 === 3; p75 === 4.
    const v = [1, 2, 3, 4, 5];
    expect(percentile(v, 0.25)).toBe(2);
    expect(percentile(v, 0.5)).toBe(3);
    expect(percentile(v, 0.75)).toBe(4);
  });

  it("interpolates between samples when rank is non-integer", () => {
    // np.percentile([1,2,3,4], 0.25) === 1.75; sorted rank = 0.25*3 = 0.75 →
    // blend(1, 2, frac=0.75) = 1.75.
    expect(percentile([1, 2, 3, 4], 0.25)).toBeCloseTo(1.75, 10);
  });

  it("does not require pre-sorted input", () => {
    const a = percentile([5, 1, 3, 4, 2], 0.5);
    const b = percentile([1, 2, 3, 4, 5], 0.5);
    expect(a).toBe(b);
  });

  it("clamps p outside [0, 1]", () => {
    const v = [1, 2, 3];
    expect(percentile(v, -0.5)).toBe(1);
    expect(percentile(v, 1.5)).toBe(3);
  });

  it("handles repeated values (ties)", () => {
    expect(percentile([0.5, 0.5, 0.5, 0.5], 0.25)).toBe(0.5);
    expect(percentile([0.5, 0.5, 0.5, 0.5], 0.75)).toBe(0.5);
  });
});

describe("median", () => {
  it("returns 0 on empty input", () => {
    expect(median([])).toBe(0);
  });

  it("returns the value for a single sample", () => {
    expect(median([0.7])).toBe(0.7);
  });

  it("matches numpy median on odd-length input", () => {
    expect(median([1, 2, 3])).toBe(2);
  });

  it("matches numpy median on even-length input (interpolates middle two)", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe("computeAggregate", () => {
  it("returns zeros and empty list on an empty suite", () => {
    const a = computeAggregate([]);
    expect(a).toEqual({
      count: 0,
      median_coverage_score: 0,
      p25_coverage_score: 0,
      count_below_min: 0,
      below_min_slugs: [],
    });
  });

  it("rounds median and p25 to 2 decimals", () => {
    const a = computeAggregate([
      entry("a", 0.123456),
      entry("b", 0.987654),
    ]);
    // median of [0.12..., 0.98...] = average = 0.555555; rounded = 0.56
    expect(a.median_coverage_score).toBe(0.56);
    expect(a.p25_coverage_score).toBe(0.34);
  });

  it("reports count_below_min strictly (< not ≤)", () => {
    // Score equal to the floor is NOT below min — the suite tolerates exact-floor entries.
    const a = computeAggregate([
      entry("equal", 0.5, 0.5),
      entry("below", 0.49, 0.5),
      entry("above", 0.51, 0.5),
    ]);
    expect(a.count_below_min).toBe(1);
    expect(a.below_min_slugs).toEqual(["below"]);
  });

  it("when all entries are below min, lists them all", () => {
    const a = computeAggregate([
      entry("a", 0.1, 0.5),
      entry("b", 0.2, 0.5),
      entry("c", 0.3, 0.5),
    ]);
    expect(a.count_below_min).toBe(3);
    expect(a.below_min_slugs).toEqual(["a", "b", "c"]);
  });

  it("preserves below_min_slugs in input order", () => {
    // The suite YAML order is the canonical order — we want the report stable
    // so a regression on entity #5 always shows up in the same column.
    const a = computeAggregate([
      entry("z-last", 0.1, 0.5),
      entry("a-first", 0.2, 0.5),
    ]);
    expect(a.below_min_slugs).toEqual(["z-last", "a-first"]);
  });

  it("computes count even when no entries are below min", () => {
    const a = computeAggregate([
      entry("a", 0.9, 0.5),
      entry("b", 0.95, 0.5),
    ]);
    expect(a.count).toBe(2);
    expect(a.count_below_min).toBe(0);
    expect(a.below_min_slugs).toEqual([]);
  });

  it("works with a single-entry suite", () => {
    const a = computeAggregate([entry("solo", 0.7, 0.5)]);
    expect(a.count).toBe(1);
    expect(a.median_coverage_score).toBe(0.7);
    expect(a.p25_coverage_score).toBe(0.7);
    expect(a.count_below_min).toBe(0);
  });
});
