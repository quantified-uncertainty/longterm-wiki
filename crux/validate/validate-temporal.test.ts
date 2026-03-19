import { describe, it, expect } from "vitest";
import { validateDateValue, compareDates } from "./validate-temporal.ts";

describe("validateDateValue", () => {
  // ── Valid dates ──────────────────────────────────────────────────────
  it("accepts year-only format (YYYY)", () => {
    expect(validateDateValue("2024")).toBeNull();
    expect(validateDateValue("1999")).toBeNull();
    expect(validateDateValue("2100")).toBeNull();
    expect(validateDateValue("1900")).toBeNull();
  });

  it("accepts year-month format (YYYY-MM)", () => {
    expect(validateDateValue("2024-01")).toBeNull();
    expect(validateDateValue("2024-06")).toBeNull();
    expect(validateDateValue("2024-12")).toBeNull();
  });

  it("accepts full date format (YYYY-MM-DD)", () => {
    expect(validateDateValue("2024-01-01")).toBeNull();
    expect(validateDateValue("2024-03-14")).toBeNull();
    expect(validateDateValue("2024-12-31")).toBeNull();
  });

  it("accepts leap day on leap years", () => {
    expect(validateDateValue("2024-02-29")).toBeNull(); // 2024 is a leap year
    expect(validateDateValue("2000-02-29")).toBeNull(); // divisible by 400
  });

  // ── Invalid formats ────────────────────────────────────────────────
  it("rejects non-ISO date formats", () => {
    expect(validateDateValue("April 2, 2024")).not.toBeNull();
    expect(validateDateValue("2024/01/01")).not.toBeNull();
    expect(validateDateValue("01-2024")).not.toBeNull();
    expect(validateDateValue("20240101")).not.toBeNull();
  });

  it("rejects empty and non-string values", () => {
    expect(validateDateValue("")).not.toBeNull();
  });

  // ── Invalid months ─────────────────────────────────────────────────
  it("rejects month 00", () => {
    const result = validateDateValue("2024-00");
    expect(result).not.toBeNull();
    expect(result).toContain("invalid month");
  });

  it("rejects month 13", () => {
    const result = validateDateValue("2024-13");
    expect(result).not.toBeNull();
    expect(result).toContain("invalid month");
  });

  it("rejects month 99", () => {
    expect(validateDateValue("2024-99")).not.toBeNull();
  });

  // ── Invalid days ───────────────────────────────────────────────────
  it("rejects day 00", () => {
    const result = validateDateValue("2024-01-00");
    expect(result).not.toBeNull();
    expect(result).toContain("invalid day");
  });

  it("rejects day 32 for any month", () => {
    expect(validateDateValue("2024-01-32")).not.toBeNull();
    expect(validateDateValue("2024-03-32")).not.toBeNull();
  });

  it("rejects day 31 for months with 30 days", () => {
    expect(validateDateValue("2024-04-31")).not.toBeNull(); // April has 30 days
    expect(validateDateValue("2024-06-31")).not.toBeNull(); // June has 30 days
    expect(validateDateValue("2024-09-31")).not.toBeNull(); // September has 30 days
    expect(validateDateValue("2024-11-31")).not.toBeNull(); // November has 30 days
  });

  it("rejects Feb 29 on non-leap years", () => {
    expect(validateDateValue("2023-02-29")).not.toBeNull(); // 2023 is not a leap year
    expect(validateDateValue("1900-02-29")).not.toBeNull(); // divisible by 100 but not 400
  });

  it("rejects Feb 30 even on leap years", () => {
    expect(validateDateValue("2024-02-30")).not.toBeNull();
  });

  // ── Year range ─────────────────────────────────────────────────────
  it("rejects years outside 1900-2100 range", () => {
    expect(validateDateValue("1899")).not.toBeNull();
    expect(validateDateValue("2101")).not.toBeNull();
    expect(validateDateValue("0001")).not.toBeNull();
  });
});

describe("compareDates", () => {
  it("compares equal dates as 0", () => {
    expect(compareDates("2024", "2024")).toBe(0);
    expect(compareDates("2024-01", "2024-01")).toBe(0);
    expect(compareDates("2024-01-15", "2024-01-15")).toBe(0);
  });

  it("compares earlier dates as negative", () => {
    expect(compareDates("2023", "2024")).toBeLessThan(0);
    expect(compareDates("2024-01", "2024-02")).toBeLessThan(0);
    expect(compareDates("2024-01-01", "2024-01-02")).toBeLessThan(0);
  });

  it("compares later dates as positive", () => {
    expect(compareDates("2024", "2023")).toBeGreaterThan(0);
    expect(compareDates("2024-12", "2024-01")).toBeGreaterThan(0);
    expect(compareDates("2024-01-31", "2024-01-01")).toBeGreaterThan(0);
  });

  it("handles mixed precision dates", () => {
    // YYYY vs YYYY-MM: "2024" < "2024-01" lexicographically
    expect(compareDates("2023", "2024-01")).toBeLessThan(0);
    expect(compareDates("2024-12", "2025")).toBeLessThan(0);
  });

  it("handles the specific bug case: validEnd before asOf", () => {
    // From PR #2718: asOf=2025-10, validEnd=2025-03
    expect(compareDates("2025-03", "2025-10")).toBeLessThan(0);
  });

  it("handles the specific bug case: trainingCutoff after releaseDate", () => {
    // From PR #2700: trainingCutoff=2023-04, releaseDate=2023-03-14
    expect(compareDates("2023-04", "2023-03-14")).toBeGreaterThan(0);
  });
});
