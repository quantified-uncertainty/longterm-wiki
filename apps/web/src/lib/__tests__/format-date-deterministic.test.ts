import { describe, expect, it } from "vitest";
import { formatDateDeterministic } from "../format";

describe("formatDateDeterministic", () => {
  it("formats full ISO datetime", () => {
    expect(formatDateDeterministic("2024-06-15T10:30:00Z")).toBe("Jun 15, 2024");
  });

  it("formats date-only ISO string", () => {
    expect(formatDateDeterministic("2024-06-15")).toBe("Jun 15, 2024");
  });

  it("formats year-month only", () => {
    expect(formatDateDeterministic("2024-06")).toBe("Jun 2024");
  });

  it("formats year only", () => {
    expect(formatDateDeterministic("2024")).toBe("2024");
  });

  it("handles January (month boundary)", () => {
    expect(formatDateDeterministic("2025-01-01")).toBe("Jan 1, 2025");
  });

  it("handles December (month boundary)", () => {
    expect(formatDateDeterministic("2025-12-31")).toBe("Dec 31, 2025");
  });

  it("returns a best-effort result for unparseable input", () => {
    // "not-a-date" splits into ["not","a","date"]; month/day don't parse as
    // valid numbers so the function falls back to returning the first segment.
    expect(formatDateDeterministic("not-a-date")).toBe("not");
  });

  it("handles empty string", () => {
    expect(formatDateDeterministic("")).toBe("");
  });

  it("produces identical output regardless of timezone environment", () => {
    // This is the key property: the function does NOT construct a Date object,
    // so timezone differences between server and client cannot cause mismatches.
    const iso = "2024-01-31T23:59:59Z";
    const result = formatDateDeterministic(iso);
    expect(result).toBe("Jan 31, 2024");
  });
});
