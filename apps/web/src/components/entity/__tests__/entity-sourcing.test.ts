import { describe, it, expect } from "vitest";
import {
  rollupVerdictFromSummary,
  rollupVerdictFromVerdictList,
} from "../entity-sourcing";

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

describe("rollupVerdictFromVerdictList", () => {
  it("returns null for an empty list", () => {
    expect(rollupVerdictFromVerdictList([])).toBeNull();
  });

  it("returns the only verdict for a single-element list", () => {
    expect(rollupVerdictFromVerdictList([{ verdict: "confirmed" }])).toBe("confirmed");
    expect(rollupVerdictFromVerdictList([{ verdict: "contradicted" }])).toBe("contradicted");
    expect(rollupVerdictFromVerdictList([{ verdict: "unchecked" }])).toBe("unchecked");
  });

  it("prefers contradicted over all other verdicts", () => {
    expect(
      rollupVerdictFromVerdictList([
        { verdict: "confirmed" },
        { verdict: "outdated" },
        { verdict: "partial" },
        { verdict: "unverifiable" },
        { verdict: "contradicted" },
        { verdict: "unchecked" },
      ]),
    ).toBe("contradicted");
  });

  it("prefers outdated over partial/unverifiable/confirmed/unchecked", () => {
    expect(
      rollupVerdictFromVerdictList([
        { verdict: "confirmed" },
        { verdict: "partial" },
        { verdict: "outdated" },
        { verdict: "unverifiable" },
        { verdict: "unchecked" },
      ]),
    ).toBe("outdated");
  });

  it("prefers partial over unverifiable/confirmed/unchecked", () => {
    expect(
      rollupVerdictFromVerdictList([
        { verdict: "confirmed" },
        { verdict: "unverifiable" },
        { verdict: "partial" },
        { verdict: "unchecked" },
      ]),
    ).toBe("partial");
  });

  it("prefers unverifiable over confirmed/unchecked", () => {
    expect(
      rollupVerdictFromVerdictList([
        { verdict: "confirmed" },
        { verdict: "unverifiable" },
        { verdict: "unchecked" },
      ]),
    ).toBe("unverifiable");
  });

  it("prefers confirmed over unchecked", () => {
    expect(
      rollupVerdictFromVerdictList([
        { verdict: "confirmed" },
        { verdict: "unchecked" },
      ]),
    ).toBe("confirmed");
  });

  it("treats unknown verdicts as priority 99 (lowest)", () => {
    // Unknown verdict ranks below all known ones; confirmed should win.
    expect(
      rollupVerdictFromVerdictList([
        { verdict: "totally-made-up-verdict" },
        { verdict: "confirmed" },
      ]),
    ).toBe("confirmed");
  });

  it("returns the unknown verdict when it's the only one", () => {
    expect(rollupVerdictFromVerdictList([{ verdict: "weird" }])).toBe("weird");
  });

  it("ignores extra fields on each verdict item", () => {
    // The full `RpcSourcingDetailResult.verdicts` row has many fields;
    // the rollup should only depend on `verdict`.
    expect(
      rollupVerdictFromVerdictList([
        { verdict: "confirmed", fieldName: "amount", confidence: 0.9 } as { verdict: string },
        { verdict: "contradicted", fieldName: "investor", confidence: 0.7 } as { verdict: string },
      ]),
    ).toBe("contradicted");
  });
});
