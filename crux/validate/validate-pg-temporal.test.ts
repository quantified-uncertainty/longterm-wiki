import { describe, it, expect } from "vitest";
import {
  parseDateToNumeric,
  extractYear,
  validateDateField,
  validateDatePair,
  validateRecords,
  TABLE_CONFIGS,
  type TemporalViolation,
  type DatePairTableConfig,
  type SingleDateTableConfig,
} from "./validate-pg-temporal.ts";

// ---------------------------------------------------------------------------
// parseDateToNumeric
// ---------------------------------------------------------------------------

describe("parseDateToNumeric", () => {
  it("parses YYYY format", () => {
    expect(parseDateToNumeric("2024")).toBe(20240101);
  });

  it("parses YYYY-MM format", () => {
    expect(parseDateToNumeric("2024-03")).toBe(20240301);
  });

  it("parses YYYY-MM-DD format", () => {
    expect(parseDateToNumeric("2024-03-15")).toBe(20240315);
  });

  it("parses ISO datetime format", () => {
    expect(parseDateToNumeric("2024-03-15T10:30:00Z")).toBe(20240315);
  });

  it("returns null for empty string", () => {
    expect(parseDateToNumeric("")).toBeNull();
  });

  it("returns null for garbage input", () => {
    expect(parseDateToNumeric("not-a-date")).toBeNull();
  });

  it("returns null for partial date with invalid month", () => {
    expect(parseDateToNumeric("2024-13")).toBeNull();
  });

  it("returns null for partial date with zero month", () => {
    expect(parseDateToNumeric("2024-00")).toBeNull();
  });

  it("returns null for date with invalid day", () => {
    expect(parseDateToNumeric("2024-03-32")).toBeNull();
  });

  it("returns null for date with zero day", () => {
    expect(parseDateToNumeric("2024-03-00")).toBeNull();
  });

  it("preserves ordering: 2020 < 2024", () => {
    const a = parseDateToNumeric("2020");
    const b = parseDateToNumeric("2024");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!).toBeLessThan(b!);
  });

  it("preserves ordering: 2024-01 < 2024-12", () => {
    const a = parseDateToNumeric("2024-01");
    const b = parseDateToNumeric("2024-12");
    expect(a!).toBeLessThan(b!);
  });

  it("preserves ordering: 2024-03-01 < 2024-03-31", () => {
    const a = parseDateToNumeric("2024-03-01");
    const b = parseDateToNumeric("2024-03-31");
    expect(a!).toBeLessThan(b!);
  });

  it("handles YYYY correctly when compared with YYYY-MM (same year)", () => {
    // YYYY defaults to YYYY-01-01, so 2024 == 2024-01 in terms of numeric
    const a = parseDateToNumeric("2024");
    const b = parseDateToNumeric("2024-01");
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// extractYear
// ---------------------------------------------------------------------------

describe("extractYear", () => {
  it("extracts year from YYYY", () => {
    expect(extractYear("2024")).toBe(2024);
  });

  it("extracts year from YYYY-MM", () => {
    expect(extractYear("2024-06")).toBe(2024);
  });

  it("extracts year from YYYY-MM-DD", () => {
    expect(extractYear("2024-06-15")).toBe(2024);
  });

  it("returns null for empty string", () => {
    expect(extractYear("")).toBeNull();
  });

  it("returns null for non-date string", () => {
    expect(extractYear("abc")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validateDateField
// ---------------------------------------------------------------------------

describe("validateDateField", () => {
  it("returns no violations for valid YYYY date", () => {
    const violations = validateDateField("test", "r1", "date", "2024");
    expect(violations).toHaveLength(0);
  });

  it("returns no violations for valid YYYY-MM date", () => {
    const violations = validateDateField("test", "r1", "date", "2024-06");
    expect(violations).toHaveLength(0);
  });

  it("returns no violations for valid YYYY-MM-DD date", () => {
    const violations = validateDateField("test", "r1", "date", "2024-06-15");
    expect(violations).toHaveLength(0);
  });

  it("returns a warning for invalid format", () => {
    const violations = validateDateField("test", "r1", "date", "June 2024");
    expect(violations).toHaveLength(1);
    expect(violations[0].severity).toBe("warning");
    expect(violations[0].issue).toContain("Invalid date format");
    expect(violations[0].table).toBe("test");
    expect(violations[0].recordId).toBe("r1");
    expect(violations[0].field).toBe("date");
    expect(violations[0].value).toBe("June 2024");
  });

  it("returns a warning for date before MIN_YEAR (1900)", () => {
    const violations = validateDateField("test", "r1", "date", "1899");
    expect(violations).toHaveLength(1);
    expect(violations[0].severity).toBe("warning");
    expect(violations[0].issue).toContain("outside reasonable range");
  });

  it("returns a warning for date after MAX_YEAR (2100)", () => {
    const violations = validateDateField("test", "r1", "date", "2101");
    expect(violations).toHaveLength(1);
    expect(violations[0].severity).toBe("warning");
    expect(violations[0].issue).toContain("outside reasonable range");
  });

  it("accepts boundary year 1900", () => {
    const violations = validateDateField("test", "r1", "date", "1900");
    expect(violations).toHaveLength(0);
  });

  it("accepts boundary year 2100", () => {
    const violations = validateDateField("test", "r1", "date", "2100");
    expect(violations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// validateDatePair
// ---------------------------------------------------------------------------

describe("validateDatePair", () => {
  it("returns no violations when both dates are null", () => {
    const violations = validateDatePair(
      "test", "r1", "startDate", null, "endDate", null,
    );
    expect(violations).toHaveLength(0);
  });

  it("returns no violations when only start date exists", () => {
    const violations = validateDatePair(
      "test", "r1", "startDate", "2024", "endDate", null,
    );
    expect(violations).toHaveLength(0);
  });

  it("returns no violations when only end date exists", () => {
    const violations = validateDatePair(
      "test", "r1", "startDate", null, "endDate", "2024",
    );
    expect(violations).toHaveLength(0);
  });

  it("returns no violations for valid ordering (start < end)", () => {
    const violations = validateDatePair(
      "test", "r1", "startDate", "2020", "endDate", "2024",
    );
    expect(violations).toHaveLength(0);
  });

  it("returns no violations for equal dates", () => {
    const violations = validateDatePair(
      "test", "r1", "startDate", "2024-06", "endDate", "2024-06",
    );
    expect(violations).toHaveLength(0);
  });

  it("returns an error when start date is after end date", () => {
    const violations = validateDatePair(
      "test", "r1", "startDate", "2025", "endDate", "2020",
    );
    const errors = violations.filter((v) => v.severity === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].issue).toContain("Start date (2025) is after end date (2020)");
    expect(errors[0].field).toBe("startDate / endDate");
    expect(errors[0].value).toBe("2025 → 2020");
  });

  it("detects reversed YYYY-MM dates", () => {
    const violations = validateDatePair(
      "test", "r1", "startDate", "2024-12", "endDate", "2024-01",
    );
    const errors = violations.filter((v) => v.severity === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].issue).toContain("is after end date");
  });

  it("reports format errors alongside ordering errors", () => {
    // Start is bad format, end is valid — only format warning for start
    const violations = validateDatePair(
      "test", "r1", "startDate", "garbage", "endDate", "2024",
    );
    expect(violations.length).toBeGreaterThanOrEqual(1);
    expect(violations.some((v) => v.issue.includes("Invalid date format"))).toBe(true);
  });

  it("validates both start and end individually", () => {
    // Both have out-of-range years
    const violations = validateDatePair(
      "test", "r1", "startDate", "1800", "endDate", "2200",
    );
    const rangeWarnings = violations.filter((v) =>
      v.issue.includes("outside reasonable range"),
    );
    expect(rangeWarnings).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// validateRecords
// ---------------------------------------------------------------------------

describe("validateRecords", () => {
  const pairConfig: DatePairTableConfig = {
    kind: "pair",
    table: "personnel",
    apiPath: "/api/personnel/all",
    recordsKey: "personnel",
    startField: "startDate",
    endField: "endDate",
  };

  const singleConfig: SingleDateTableConfig = {
    kind: "single",
    table: "grants",
    apiPath: "/api/grants/all",
    recordsKey: "grants",
    dateField: "date",
  };

  it("returns no violations for valid pair records", () => {
    const records = [
      { id: "r1", startDate: "2020", endDate: "2024" },
      { id: "r2", startDate: "2018-06", endDate: null },
      { id: "r3", startDate: null, endDate: null },
    ];
    const violations = validateRecords(pairConfig, records);
    expect(violations).toHaveLength(0);
  });

  it("detects start > end in pair records", () => {
    const records = [
      { id: "r1", startDate: "2025", endDate: "2020" },
    ];
    const violations = validateRecords(pairConfig, records);
    expect(violations.some((v) => v.severity === "error")).toBe(true);
  });

  it("returns no violations for valid single date records", () => {
    const records = [
      { id: "g1", date: "2024-03" },
      { id: "g2", date: null },
      { id: "g3", date: "" },
    ];
    const violations = validateRecords(singleConfig, records);
    expect(violations).toHaveLength(0);
  });

  it("detects bad format in single date records", () => {
    const records = [
      { id: "g1", date: "next year" },
    ];
    const violations = validateRecords(singleConfig, records);
    expect(violations).toHaveLength(1);
    expect(violations[0].issue).toContain("Invalid date format");
  });

  it("detects out-of-range year in single date records", () => {
    const records = [
      { id: "g1", date: "1850" },
    ];
    const violations = validateRecords(singleConfig, records);
    expect(violations).toHaveLength(1);
    expect(violations[0].issue).toContain("outside reasonable range");
  });

  it("handles missing id field gracefully", () => {
    const records = [
      { date: "2024-03" } as Record<string, unknown>,
    ];
    const violations = validateRecords(singleConfig, records);
    // Should not crash; id defaults to "unknown"
    expect(violations).toHaveLength(0);
  });

  it("handles non-string date field gracefully", () => {
    const records = [
      { id: "g1", date: 2024 },
    ];
    const violations = validateRecords(singleConfig, records);
    // Numbers are not typeof string, so they're skipped
    expect(violations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// TABLE_CONFIGS
// ---------------------------------------------------------------------------

describe("TABLE_CONFIGS", () => {
  it("has configs for all expected tables", () => {
    const tables = TABLE_CONFIGS.map((c) => c.table);
    expect(tables).toContain("personnel");
    expect(tables).toContain("divisions");
    expect(tables).toContain("division_personnel");
    expect(tables).toContain("equity_positions");
    expect(tables).toContain("funding_programs");
    expect(tables).toContain("funding_rounds");
    expect(tables).toContain("investments");
    expect(tables).toContain("grants");
    expect(tables).toContain("benchmarks");
    expect(tables).toContain("benchmark_results");
  });

  it("pair configs have startField and endField", () => {
    const pairConfigs = TABLE_CONFIGS.filter((c) => c.kind === "pair");
    expect(pairConfigs.length).toBeGreaterThan(0);
    for (const c of pairConfigs) {
      expect(c).toHaveProperty("startField");
      expect(c).toHaveProperty("endField");
    }
  });

  it("single configs have dateField", () => {
    const singleConfigs = TABLE_CONFIGS.filter((c) => c.kind === "single");
    expect(singleConfigs.length).toBeGreaterThan(0);
    for (const c of singleConfigs) {
      expect(c).toHaveProperty("dateField");
    }
  });

  it("all configs have non-empty apiPath and recordsKey", () => {
    for (const c of TABLE_CONFIGS) {
      expect(c.apiPath).toBeTruthy();
      expect(c.recordsKey).toBeTruthy();
    }
  });
});
