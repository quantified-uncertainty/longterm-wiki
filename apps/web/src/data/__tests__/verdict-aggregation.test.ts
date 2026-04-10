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

  it("ranks unverifiable above outdated, partial, confirmed", () => {
    expect(
      pickWorstVerdict(["confirmed", "partial", "unverifiable", "outdated"]),
    ).toBe("unverifiable");
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

  it("returns null for an empty list containing a bare null equivalent", () => {
    // Defensive: the severity ladder doesn't include "unchecked" or empty
    // strings, so they should be ignored.
    expect(pickWorstVerdict(["unchecked", "", "confirmed"])).toBe("confirmed");
  });
});
