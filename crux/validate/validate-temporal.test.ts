import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { validateDateValue, compareDates } from "./validate-temporal.ts";

// For integration tests, we use vi.mock at the module level for ESM compat.
// We mock fs so the check functions read controlled test data instead of real files.
vi.mock("fs", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("fs");
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    readFileSync: vi.fn(actual.readFileSync),
    readdirSync: vi.fn(actual.readdirSync),
  };
});

// Import after mock setup
import { existsSync, readFileSync, readdirSync } from "fs";
import { runTemporalValidation } from "./validate-temporal.ts";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockReaddirSync = vi.mocked(readdirSync);

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

  // ── Custom minYear (used by `founded` field — universities can be ancient)
  it("accepts pre-1900 years when minYear is relaxed", () => {
    // Oxford founded 1096, Cambridge 1209, UPenn 1740, Stanford 1885
    expect(validateDateValue("1096", { minYear: 1000 })).toBeNull();
    expect(validateDateValue("1209", { minYear: 1000 })).toBeNull();
    expect(validateDateValue("1740", { minYear: 1000 })).toBeNull();
    expect(validateDateValue("1885", { minYear: 1000 })).toBeNull();
  });

  it("still rejects years below the relaxed minYear", () => {
    expect(validateDateValue("0999", { minYear: 1000 })).toContain("outside reasonable range");
    expect(validateDateValue("0500", { minYear: 1000 })).toContain("outside reasonable range");
  });

  it("error message reflects the custom range", () => {
    const err = validateDateValue("0500", { minYear: 1000 });
    expect(err).toContain("(1000-2100)");
  });
});

describe("compareDates", () => {
  // ── Same precision ────────────────────────────────────────────────
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

  // ── Mixed precision (the key fix) ─────────────────────────────────
  it("treats year-only as encompassing all months in that year", () => {
    expect(compareDates("2024", "2024-01")).toBe(0);
    expect(compareDates("2024", "2024-06")).toBe(0);
    expect(compareDates("2024", "2024-12")).toBe(0);
  });

  it("treats year-month as encompassing all days in that month", () => {
    expect(compareDates("2024-01", "2024-01-01")).toBe(0);
    expect(compareDates("2024-01", "2024-01-15")).toBe(0);
    expect(compareDates("2024-01", "2024-01-31")).toBe(0);
  });

  it("returns 0 when more-precise date is within less-precise date (reversed args)", () => {
    expect(compareDates("2024-01", "2024")).toBe(0);
    expect(compareDates("2024-06-15", "2024")).toBe(0);
    expect(compareDates("2024-01-15", "2024-01")).toBe(0);
  });

  it("correctly orders different years even with mixed precision", () => {
    expect(compareDates("2023", "2024-01")).toBeLessThan(0);
    expect(compareDates("2024-12", "2025")).toBeLessThan(0);
    expect(compareDates("2025", "2024-12")).toBeGreaterThan(0);
  });

  it("correctly orders different months with mixed precision", () => {
    expect(compareDates("2024-03", "2024-04-01")).toBeLessThan(0);
    expect(compareDates("2024-05-15", "2024-04")).toBeGreaterThan(0);
  });

  // ── Key use case: validEnd >= asOf with mixed precision ───────────
  it("validEnd='2024' satisfies asOf='2024-01' (year encompasses month)", () => {
    expect(compareDates("2024", "2024-01")).toBeGreaterThanOrEqual(0);
  });

  it("validEnd='2024' satisfies asOf='2024-12' (year encompasses last month)", () => {
    expect(compareDates("2024", "2024-12")).toBeGreaterThanOrEqual(0);
  });

  it("validEnd='2024-01' does not satisfy asOf='2024-02' (Jan before Feb)", () => {
    expect(compareDates("2024-01", "2024-02")).toBeLessThan(0);
  });

  // ── Specific bug cases from prior PRs ─────────────────────────────
  it("handles the specific bug case: validEnd before asOf", () => {
    expect(compareDates("2025-03", "2025-10")).toBeLessThan(0);
  });

  it("handles the specific bug case: trainingCutoff after releaseDate", () => {
    expect(compareDates("2023-04", "2023-03-14")).toBeGreaterThan(0);
  });
});

// ── Integration tests for check functions ─────────────────────────────────────

describe("runTemporalValidation", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("detects invalid month 00 in entity date fields", () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      return path.includes("data/entities");
    });

    mockReaddirSync.mockImplementation(((p: string) => {
      if (String(p).includes("data/entities")) return ["test-models.yaml"];
      return [];
    }) as unknown as typeof readdirSync);

    mockReadFileSync.mockImplementation(((p: string) => {
      if (String(p).includes("test-models.yaml")) {
        return `- id: bad-model\n  type: ai-model\n  releaseDate: "2024-00"\n`;
      }
      return "";
    }) as unknown as typeof readFileSync);

    const result = runTemporalValidation();
    expect(result.passed).toBe(false);
    const dateViolations = result.violations.filter(v => v.rule === "date-value-validity");
    expect(dateViolations.length).toBeGreaterThanOrEqual(1);
    expect(dateViolations[0].message).toContain("invalid month");
  });

  it("detects model trainingCutoff after releaseDate", () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      return path.includes("data/entities") || path.includes("ai-models.yaml");
    });

    mockReaddirSync.mockImplementation(((p: string) => {
      if (String(p).includes("data/entities")) return ["ai-models.yaml"];
      return [];
    }) as unknown as typeof readdirSync);

    mockReadFileSync.mockImplementation(((p: string) => {
      if (String(p).includes("ai-models.yaml")) {
        return `- id: future-model\n  type: ai-model\n  releaseDate: "2023-03"\n  trainingCutoff: "2023-06"\n`;
      }
      return "";
    }) as unknown as typeof readFileSync);

    const result = runTemporalValidation();
    const cutoffViolations = result.violations.filter(v => v.rule === "model-cutoff-release");
    expect(cutoffViolations).toHaveLength(1);
    expect(cutoffViolations[0].message).toContain("trainingCutoff");
  });

  it("skips excepted models (gpt-4-turbo) in cutoff check", () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      return path.includes("data/entities") || path.includes("ai-models.yaml");
    });

    mockReaddirSync.mockImplementation(((p: string) => {
      if (String(p).includes("data/entities")) return ["ai-models.yaml"];
      return [];
    }) as unknown as typeof readdirSync);

    mockReadFileSync.mockImplementation(((p: string) => {
      if (String(p).includes("ai-models.yaml")) {
        return `- id: gpt-4-turbo\n  type: ai-model\n  releaseDate: "2023-11-06"\n  trainingCutoff: "2023-12"\n`;
      }
      return "";
    }) as unknown as typeof readFileSync);

    const result = runTemporalValidation();
    const cutoffViolations = result.violations.filter(v => v.rule === "model-cutoff-release");
    expect(cutoffViolations).toHaveLength(0);
  });

  it("detects policy vote date before introduced date", () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      return path.includes("data/entities");
    });

    mockReaddirSync.mockImplementation(((p: string) => {
      if (String(p).includes("data/entities")) return ["policies.yaml"];
      return [];
    }) as unknown as typeof readdirSync);

    mockReadFileSync.mockImplementation(((p: string) => {
      if (String(p).includes("policies.yaml")) {
        return [
          "- id: bad-policy",
          "  type: policy",
          '  introduced: "2024-03"',
          "  votes:",
          '    - date: "2024-01"',
          "      chamber: house",
        ].join("\n");
      }
      return "";
    }) as unknown as typeof readFileSync);

    const result = runTemporalValidation();
    const policyViolations = result.violations.filter(v => v.rule === "policy-date-order");
    expect(policyViolations).toHaveLength(1);
    expect(policyViolations[0].message).toContain("vote date");
  });

  it("passes when all dates are valid and ordered correctly", () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      return path.includes("data/entities") || path.includes("ai-models.yaml");
    });

    mockReaddirSync.mockImplementation(((p: string) => {
      if (String(p).includes("data/entities")) return ["ai-models.yaml"];
      return [];
    }) as unknown as typeof readdirSync);

    mockReadFileSync.mockImplementation(((p: string) => {
      if (String(p).includes("ai-models.yaml")) {
        return `- id: good-model\n  type: ai-model\n  releaseDate: "2024-06"\n  trainingCutoff: "2024-03"\n`;
      }
      return "";
    }) as unknown as typeof readFileSync);

    const result = runTemporalValidation();
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("handles YAML parse errors gracefully without crashing", () => {
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      return path.includes("data/entities");
    });

    mockReaddirSync.mockImplementation(((p: string) => {
      if (String(p).includes("data/entities")) return ["bad.yaml"];
      return [];
    }) as unknown as typeof readdirSync);

    mockReadFileSync.mockImplementation(((p: string) => {
      if (String(p).includes("bad.yaml")) {
        return "{{invalid yaml::: [[[";
      }
      return "";
    }) as unknown as typeof readFileSync);

    // Should not throw, should return passed (no violations from unparseable files)
    const result = runTemporalValidation();
    expect(result.passed).toBe(true);
  });

  it("handles missing directories gracefully", () => {
    mockExistsSync.mockReturnValue(false);

    const result = runTemporalValidation();
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });
});
