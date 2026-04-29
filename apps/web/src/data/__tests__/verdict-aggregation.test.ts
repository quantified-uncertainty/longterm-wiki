import { describe, it, expect } from "vitest";
import { pickWorstVerdict } from "../tablebase";

describe("pickWorstVerdict", () => {
  it("returns null for an empty list", () => {
    expect(pickWorstVerdict([])).toBeNull();
  });

  it("returns null when no verdicts are known", () => {
    expect(pickWorstVerdict(["unknown", "mystery"])).toBeNull();
  });

  it("passes through a single confirmed verdict", () => {
    expect(pickWorstVerdict(["confirmed"])).toBe("confirmed");
  });

  it("ranks contradicted above everything else", () => {
    expect(
      pickWorstVerdict([
        "confirmed",
        "contradicted",
        "partial",
        "unverifiable",
      ]),
    ).toBe("contradicted");
  });

  it("ranks outdated above partial, unverifiable, confirmed", () => {
    // QUA-429: canonical order is contradicted > outdated > partial >
    // unverifiable > confirmed > unchecked. Previously this helper had its
    // own ladder with unverifiable above outdated, which conflicted with
    // rollupVerdictFromSummary on the same record.
    expect(
      pickWorstVerdict(["confirmed", "partial", "unverifiable", "outdated"]),
    ).toBe("outdated");
  });

  it("ranks partial above unverifiable and confirmed", () => {
    expect(
      pickWorstVerdict(["confirmed", "unverifiable", "partial"]),
    ).toBe("partial");
  });

  it("ranks unverifiable above confirmed", () => {
    expect(pickWorstVerdict(["confirmed", "unverifiable"])).toBe("unverifiable");
  });

  it("ranks outdated above partial and confirmed", () => {
    expect(pickWorstVerdict(["confirmed", "partial", "outdated"])).toBe(
      "outdated",
    );
  });

  it("ranks partial above confirmed", () => {
    expect(pickWorstVerdict(["confirmed", "partial", "confirmed"])).toBe(
      "partial",
    );
  });

  it("returns confirmed when all verdicts are confirmed", () => {
    expect(
      pickWorstVerdict(["confirmed", "confirmed", "confirmed"]),
    ).toBe("confirmed");
  });

  it("ignores unknown strings mixed with known ones", () => {
    expect(
      pickWorstVerdict(["mystery", "confirmed", "garbage"]),
    ).toBe("confirmed");
  });

  it("returns the worst even when the worst appears last", () => {
    expect(
      pickWorstVerdict(["confirmed", "confirmed", "contradicted"]),
    ).toBe("contradicted");
  });

  it("treats unchecked as the lowest-priority known verdict", () => {
    // unchecked is in the canonical priority map (worst in the sense that it
    // means "no data") but every real verdict outranks it as a "worst" pick.
    expect(pickWorstVerdict(["unchecked", "", "confirmed"])).toBe("confirmed");
    expect(pickWorstVerdict(["unchecked"])).toBe("unchecked");
    expect(pickWorstVerdict(["unchecked", "contradicted"])).toBe("contradicted");
  });
});
