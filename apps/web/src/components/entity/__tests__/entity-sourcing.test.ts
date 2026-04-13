import { describe, it, expect } from "vitest";
import { rollupVerdictFromSummary } from "../entity-sourcing";

const zeroCounts = {
  confirmed: 0,
  contradicted: 0,
  outdated: 0,
  partial: 0,
  unverifiable: 0,
  unchecked: 0,
};

describe("rollupVerdictFromSummary", () => {
  it("returns null for null summary", () => {
    expect(rollupVerdictFromSummary(null)).toBeNull();
    expect(rollupVerdictFromSummary(undefined)).toBeNull();
  });

  it("returns null when all verdict counts are zero", () => {
    expect(rollupVerdictFromSummary(zeroCounts)).toBeNull();
  });

  it("returns the only verdict when only one is present", () => {
    expect(rollupVerdictFromSummary({ ...zeroCounts, confirmed: 5 })).toBe(
      "confirmed",
    );
    expect(rollupVerdictFromSummary({ ...zeroCounts, contradicted: 1 })).toBe(
      "contradicted",
    );
    expect(rollupVerdictFromSummary({ ...zeroCounts, unchecked: 10 })).toBe(
      "unchecked",
    );
  });

  it("prefers contradicted over all other verdicts", () => {
    expect(
      rollupVerdictFromSummary({
        ...zeroCounts,
        confirmed: 100,
        contradicted: 1,
        outdated: 10,
        partial: 5,
        unverifiable: 3,
        unchecked: 50,
      }),
    ).toBe("contradicted");
  });

  it("prefers outdated over partial/unverifiable/confirmed/unchecked", () => {
    expect(
      rollupVerdictFromSummary({
        ...zeroCounts,
        confirmed: 10,
        outdated: 1,
        partial: 5,
        unverifiable: 3,
        unchecked: 50,
      }),
    ).toBe("outdated");
  });

  it("prefers partial over unverifiable/confirmed/unchecked", () => {
    expect(
      rollupVerdictFromSummary({
        ...zeroCounts,
        confirmed: 10,
        partial: 1,
        unverifiable: 3,
        unchecked: 50,
      }),
    ).toBe("partial");
  });

  it("prefers unverifiable over confirmed/unchecked", () => {
    expect(
      rollupVerdictFromSummary({
        ...zeroCounts,
        confirmed: 10,
        unverifiable: 1,
        unchecked: 50,
      }),
    ).toBe("unverifiable");
  });

  it("prefers confirmed over unchecked", () => {
    expect(
      rollupVerdictFromSummary({
        ...zeroCounts,
        confirmed: 1,
        unchecked: 50,
      }),
    ).toBe("confirmed");
  });

  it("ignores extra fields beyond the required verdict counts", () => {
    // Caller may pass the full RpcEntitySummaryRow; rollup should still work
    expect(
      rollupVerdictFromSummary({
        ...zeroCounts,
        confirmed: 3,
        // Simulate additional fields from the upstream row
        entityId: "anthropic",
        totalVerdicts: 3,
        avgConfidence: 0.9,
        totalRecords: 7,
      } as Parameters<typeof rollupVerdictFromSummary>[0]),
    ).toBe("confirmed");
  });
});
