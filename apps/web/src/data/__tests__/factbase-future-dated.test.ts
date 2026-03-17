import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isFactFutureDated } from "../factbase";
import type { Fact } from "@longterm-wiki/factbase";

/** Create a minimal fact stub for testing. */
function makeFact(overrides: Partial<Fact> = {}): Fact {
  return {
    id: "f_test",
    subjectId: "test-entity",
    propertyId: "test-property",
    value: { type: "number", value: 42, unit: "%" },
    ...overrides,
  };
}

describe("isFactFutureDated", () => {
  beforeEach(() => {
    // Pin "today" to 2026-03-17 for deterministic tests
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-17T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns false for facts without asOf", () => {
    expect(isFactFutureDated(makeFact({ asOf: undefined }))).toBe(false);
  });

  it("returns false for a YYYY date in the past", () => {
    expect(isFactFutureDated(makeFact({ asOf: "2024" }))).toBe(false);
  });

  it("returns false for a YYYY-MM date in the past", () => {
    expect(isFactFutureDated(makeFact({ asOf: "2025-12" }))).toBe(false);
  });

  it("returns false for a YYYY-MM-DD date in the past", () => {
    expect(isFactFutureDated(makeFact({ asOf: "2026-03-16" }))).toBe(false);
  });

  it("returns false for today's date (YYYY-MM-DD)", () => {
    expect(isFactFutureDated(makeFact({ asOf: "2026-03-17" }))).toBe(false);
  });

  it("returns false for current month (YYYY-MM padded to first of month)", () => {
    // "2026-03" pads to "2026-03-01" which is <= today (2026-03-17)
    expect(isFactFutureDated(makeFact({ asOf: "2026-03" }))).toBe(false);
  });

  it("returns true for a YYYY date in the future", () => {
    expect(isFactFutureDated(makeFact({ asOf: "2027" }))).toBe(true);
  });

  it("returns true for a YYYY-MM date in the future", () => {
    expect(isFactFutureDated(makeFact({ asOf: "2026-12" }))).toBe(true);
  });

  it("returns true for a YYYY-MM-DD date in the future", () => {
    expect(isFactFutureDated(makeFact({ asOf: "2026-03-18" }))).toBe(true);
  });

  it("returns true for a far-future date", () => {
    expect(isFactFutureDated(makeFact({ asOf: "2099-12-31" }))).toBe(true);
  });
});

describe("getFactBaseLatest future-date filtering", () => {
  /**
   * We can't easily test getFactBaseLatest directly since it depends on
   * getFactBase() loading factbase-data.json. Instead, we verify the
   * composition logic by testing isFactFutureDated + isFactExpired which
   * are the filter predicates used by getFactBaseLatest.
   *
   * The key scenario (Anthropic gross margin bug):
   *   - Fact A: asOf="2025-12", value=40% (actual)
   *   - Fact B: asOf="2026-12", value=63% (2026 target)
   *
   * With today = 2026-03-17:
   *   - Fact B is future-dated (2026-12 > today) → filtered out
   *   - Fact A is NOT future-dated (2025-12 < today) → selected as latest
   */
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-17T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("correctly identifies the Anthropic gross margin scenario", () => {
    const actualFact = makeFact({ asOf: "2025-12", value: { type: "number", value: 40, unit: "%" } });
    const targetFact = makeFact({ asOf: "2026-12", value: { type: "number", value: 63, unit: "%" } });

    // The target (63%) is future-dated and should be filtered out
    expect(isFactFutureDated(targetFact)).toBe(true);
    // The actual (40%) is NOT future-dated and should be selected
    expect(isFactFutureDated(actualFact)).toBe(false);
  });

  it("simulates the full filter pipeline: sorted desc, filter future, take first", () => {
    // Simulate what getFactBaseLatest does internally
    const facts = [
      makeFact({ id: "target", asOf: "2026-12", value: { type: "number", value: 63, unit: "%" } }),
      makeFact({ id: "actual", asOf: "2025-12", value: { type: "number", value: 40, unit: "%" } }),
      makeFact({ id: "old", asOf: "2024-06", value: { type: "number", value: 50, unit: "%" } }),
    ]; // Already sorted most-recent-first (as getFactBaseFacts returns)

    const nonFuture = facts.filter((f) => !isFactFutureDated(f));
    expect(nonFuture).toHaveLength(2);
    expect(nonFuture[0].id).toBe("actual"); // 2025-12
    expect(nonFuture[1].id).toBe("old"); // 2024-06
  });

  it("falls back to most recent future fact when all facts are future-dated", () => {
    const facts = [
      makeFact({ id: "far_future", asOf: "2028-12" }),
      makeFact({ id: "near_future", asOf: "2027-06" }),
    ];

    const nonFuture = facts.filter((f) => !isFactFutureDated(f));
    expect(nonFuture).toHaveLength(0);

    // Fallback: last element (closest to today) from the sorted-desc array
    const fallback = facts[facts.length - 1];
    expect(fallback.id).toBe("near_future");
  });
});
