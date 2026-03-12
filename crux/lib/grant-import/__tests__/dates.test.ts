import { describe, it, expect } from "vitest";
import {
  QUARTER_TO_MONTH,
  parseMonthYear,
  parseQuarterYear,
  extractISODate,
  truncateToMonth,
} from "../dates.ts";

describe("QUARTER_TO_MONTH", () => {
  it("maps all four quarters", () => {
    expect(QUARTER_TO_MONTH["1"]).toBe("01");
    expect(QUARTER_TO_MONTH["2"]).toBe("04");
    expect(QUARTER_TO_MONTH["3"]).toBe("07");
    expect(QUARTER_TO_MONTH["4"]).toBe("10");
  });
});

describe("parseMonthYear", () => {
  it("parses 'February 2016'", () => {
    expect(parseMonthYear("February 2016")).toBe("2016-02");
  });

  it("parses 'December 2023'", () => {
    expect(parseMonthYear("December 2023")).toBe("2023-12");
  });

  it("parses 'January 2020'", () => {
    expect(parseMonthYear("January 2020")).toBe("2020-01");
  });

  it("handles leading/trailing whitespace", () => {
    expect(parseMonthYear("  March 2021  ")).toBe("2021-03");
  });

  it("returns null for empty string", () => {
    expect(parseMonthYear("")).toBeNull();
  });

  it("returns null for unrecognized month name", () => {
    expect(parseMonthYear("Foo 2020")).toBeNull();
  });

  it("returns null for single word", () => {
    expect(parseMonthYear("2020")).toBeNull();
  });

  it("returns null for three-word input", () => {
    expect(parseMonthYear("January 1 2020")).toBeNull();
  });
});

describe("parseQuarterYear", () => {
  it("parses '2025 Q3'", () => {
    expect(parseQuarterYear("2025 Q3")).toBe("2025-07");
  });

  it("parses '2024 Q1'", () => {
    expect(parseQuarterYear("2024 Q1")).toBe("2024-01");
  });

  it("parses '2023 Q2'", () => {
    expect(parseQuarterYear("2023 Q2")).toBe("2023-04");
  });

  it("parses '2022 Q4'", () => {
    expect(parseQuarterYear("2022 Q4")).toBe("2022-10");
  });

  it("handles leading/trailing whitespace", () => {
    expect(parseQuarterYear("  2025 Q3  ")).toBe("2025-07");
  });

  it("returns null for empty string", () => {
    expect(parseQuarterYear("")).toBeNull();
  });

  it("returns null for non-quarter format", () => {
    expect(parseQuarterYear("2025 H1")).toBeNull();
  });

  it("returns null for invalid quarter number", () => {
    expect(parseQuarterYear("2025 Q5")).toBeNull();
  });

  it("returns null for year-only", () => {
    expect(parseQuarterYear("2025")).toBeNull();
  });
});

describe("extractISODate", () => {
  it("extracts date from ISO timestamp", () => {
    expect(extractISODate("2023-05-15T12:00:00Z")).toBe("2023-05-15");
  });

  it("extracts date from plain YYYY-MM-DD", () => {
    expect(extractISODate("2022-03-15")).toBe("2022-03-15");
  });

  it("extracts date from string with trailing content", () => {
    expect(extractISODate("2024-01-01 some extra text")).toBe("2024-01-01");
  });

  it("returns null for empty string", () => {
    expect(extractISODate("")).toBeNull();
  });

  it("returns null for non-date string", () => {
    expect(extractISODate("not a date")).toBeNull();
  });

  it("returns null for year-month only", () => {
    expect(extractISODate("2023-05")).toBeNull();
  });
});

describe("truncateToMonth", () => {
  it("truncates YYYY-MM-DD to YYYY-MM", () => {
    expect(truncateToMonth("2022-03-15")).toBe("2022-03");
  });

  it("keeps YYYY-MM unchanged", () => {
    expect(truncateToMonth("2022-03")).toBe("2022-03");
  });

  it("truncates full ISO timestamp", () => {
    expect(truncateToMonth("2024-12-25T00:00:00Z")).toBe("2024-12");
  });

  it("returns null for empty string", () => {
    expect(truncateToMonth("")).toBeNull();
  });

  it("returns null for year-only", () => {
    expect(truncateToMonth("2022")).toBeNull();
  });

  it("returns null for non-date string", () => {
    expect(truncateToMonth("not a date")).toBeNull();
  });
});
