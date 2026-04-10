import { describe, it, expect } from "vitest";
import { pickWorstPolicyVerdict } from "../tablebase";

describe("pickWorstPolicyVerdict", () => {
  it("returns null for an empty list", () => {
    expect(pickWorstPolicyVerdict([])).toBeNull();
  });

  it("returns null when no verdicts are known", () => {
    expect(pickWorstPolicyVerdict(["unknown", "mystery"])).toBeNull();
  });

  it("passes through a single confirmed verdict", () => {
    expect(pickWorstPolicyVerdict(["confirmed"])).toBe("confirmed");
  });

  it("ranks contradicted above everything else", () => {
    expect(
      pickWorstPolicyVerdict([
        "confirmed",
        "contradicted",
        "partial",
        "unverifiable",
      ]),
    ).toBe("contradicted");
  });

  it("ranks unverifiable above outdated, partial, confirmed", () => {
    expect(
      pickWorstPolicyVerdict(["confirmed", "partial", "unverifiable", "outdated"]),
    ).toBe("unverifiable");
  });

  it("ranks outdated above partial and confirmed", () => {
    expect(pickWorstPolicyVerdict(["confirmed", "partial", "outdated"])).toBe(
      "outdated",
    );
  });

  it("ranks partial above confirmed", () => {
    expect(pickWorstPolicyVerdict(["confirmed", "partial", "confirmed"])).toBe(
      "partial",
    );
  });

  it("returns confirmed when all verdicts are confirmed", () => {
    expect(
      pickWorstPolicyVerdict(["confirmed", "confirmed", "confirmed"]),
    ).toBe("confirmed");
  });

  it("ignores unknown strings mixed with known ones", () => {
    expect(
      pickWorstPolicyVerdict(["mystery", "confirmed", "garbage"]),
    ).toBe("confirmed");
  });

  it("returns the worst even when the worst appears last", () => {
    expect(
      pickWorstPolicyVerdict(["confirmed", "confirmed", "contradicted"]),
    ).toBe("contradicted");
  });
});
