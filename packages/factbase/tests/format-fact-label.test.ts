import { describe, it, expect } from "vitest";
import { formatFactLabel } from "../src/format";

// QUA-397: regression — formatFactLabel must never return a raw fact ID.
// Prior to this helper, multiple call sites used `f.label || f.measure || f.factId`
// and leaked raw IDs into `things.title` / CLI output / wiki-server search.

describe("formatFactLabel", () => {
  it("prefers label when present", () => {
    expect(formatFactLabel({ label: "Revenue", measure: "revenue" })).toBe("Revenue");
  });

  it("falls back to measure when label is null", () => {
    expect(formatFactLabel({ label: null, measure: "founded-date" })).toBe("founded-date");
  });

  it("falls back to measure when label is empty string", () => {
    expect(formatFactLabel({ label: "", measure: "employee-count" })).toBe("employee-count");
  });

  it("falls back to `fact` when both label and measure are missing", () => {
    expect(formatFactLabel({ label: null, measure: null })).toBe("fact");
  });

  it("never returns a raw fact ID even when caller passes one", () => {
    // Caller might pass an object with an extra `factId` field (e.g. wiki-server
    // DTOs). The helper ignores it — the fallback stops at "fact".
    const f = { label: null, measure: null, factId: "f_mEKUPPFYRg" };
    const result = formatFactLabel(f);
    expect(result).toBe("fact");
    expect(result).not.toMatch(/^f_/);
    expect(result).not.toMatch(/^[a-f0-9]{8,}/);
  });

  it("handles undefined fields (Fact type has optional label/measure)", () => {
    expect(formatFactLabel({})).toBe("fact");
  });
});
