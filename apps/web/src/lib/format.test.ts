import { describe, it, expect } from "vitest";
import { formatDateDeterministic } from "./format";

describe("formatDateDeterministic", () => {
  it("formats full ISO date", () => {
    expect(formatDateDeterministic("2025-12-15T10:30:00Z")).toBe(
      "Dec 15, 2025",
    );
  });

  it("formats date without time", () => {
    expect(formatDateDeterministic("2025-01-03")).toBe("Jan 3, 2025");
  });

  it("formats year-month only", () => {
    expect(formatDateDeterministic("2025-12")).toBe("Dec 2025");
  });

  it("formats year only", () => {
    expect(formatDateDeterministic("2025")).toBe("2025");
  });

  it("returns input for empty string", () => {
    expect(formatDateDeterministic("")).toBe("");
  });

  it("returns year part for malformed date", () => {
    // Splits on "-", treats first segment as year
    expect(formatDateDeterministic("not-a-date")).toBe("not");
  });

  it("rejects day > 31 (falls back to month-year)", () => {
    expect(formatDateDeterministic("2025-12-99")).toBe("Dec 2025");
  });

  it("rejects month > 12 (falls back to year)", () => {
    expect(formatDateDeterministic("2025-13-01")).toBe("2025");
  });

  it("handles month = 0 (falls back to year)", () => {
    expect(formatDateDeterministic("2025-00-01")).toBe("2025");
  });

  it("handles day = 0 (falls back to month-year)", () => {
    expect(formatDateDeterministic("2025-06-00")).toBe("Jun 2025");
  });

  it("formats all 12 months correctly", () => {
    const months = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    for (let i = 1; i <= 12; i++) {
      const m = String(i).padStart(2, "0");
      expect(formatDateDeterministic(`2025-${m}-15`)).toBe(
        `${months[i - 1]} 15, 2025`,
      );
    }
  });

  it("produces identical output regardless of execution context", () => {
    // The whole point: no timezone/locale dependence
    const result1 = formatDateDeterministic("2025-12-31T23:59:59Z");
    const result2 = formatDateDeterministic("2025-12-31T23:59:59Z");
    expect(result1).toBe(result2);
    expect(result1).toBe("Dec 31, 2025");
  });
});
