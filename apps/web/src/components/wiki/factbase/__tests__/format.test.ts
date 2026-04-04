/**
 * Tests for formatKBDate, formatKBCellValue, and formatKBNumber edge cases
 * in factbase/format.ts.
 *
 * Complements the existing factbase-format.test.ts which covers formatKBNumber
 * and formatKBFactValue core paths.
 */
import { describe, expect, it } from "vitest";
import {
  formatKBDate,
  formatKBNumber,
  formatKBCellValue,
  formatKBFactValue,
} from "../format";
import type { Fact, FieldDef } from "@longterm-wiki/factbase";

// ── formatKBDate ─────────────────────────────────────────────────────

describe("formatKBDate", () => {
  it("formats year-month as 'Mon YYYY'", () => {
    expect(formatKBDate("2024-06")).toBe("Jun 2024");
  });

  it("formats full ISO date as 'Mon YYYY' (day is dropped)", () => {
    expect(formatKBDate("2024-06-15")).toBe("Jun 2024");
  });

  it("formats year-only as raw year string", () => {
    expect(formatKBDate("2024")).toBe("2024");
  });

  it("returns em-dash for undefined", () => {
    expect(formatKBDate(undefined)).toBe("\u2014");
  });

  it("returns em-dash for empty string", () => {
    expect(formatKBDate("")).toBe("\u2014");
  });

  it("returns raw string for unrecognized format", () => {
    expect(formatKBDate("Q3 2024")).toBe("Q3 2024");
  });

  it("handles January (month index 0)", () => {
    expect(formatKBDate("2025-01")).toBe("Jan 2025");
  });

  it("handles December (month index 11)", () => {
    expect(formatKBDate("2025-12")).toBe("Dec 2025");
  });

  it("returns raw string for invalid month 00", () => {
    expect(formatKBDate("2024-00")).toBe("2024-00");
  });

  it("returns raw string for invalid month 13", () => {
    expect(formatKBDate("2024-13")).toBe("2024-13");
  });
});

// ── formatKBNumber edge cases ────────────────────────────────────────

describe("formatKBNumber edge cases", () => {
  it("formats zero", () => {
    expect(formatKBNumber(0)).toBe("0");
  });

  it("formats zero with USD unit", () => {
    expect(formatKBNumber(0, "USD")).toBe("$0");
  });

  it("formats negative numbers with USD", () => {
    const result = formatKBNumber(-500_000_000, "USD");
    expect(result).toContain("$");
    expect(result).toContain("million");
  });

  it("formats very large number (trillion+)", () => {
    expect(formatKBNumber(2_500_000_000_000, "USD")).toBe("$2.5 trillion");
  });

  it("uses currency override (GBP) with display config", () => {
    const result = formatKBNumber(5_000_000_000, undefined, { divisor: 1e9, prefix: "$", suffix: "B" }, "GBP");
    expect(result).toContain("£");
    expect(result).not.toContain("$");
  });

  it("year-like value in display config with no prefix/suffix is not comma-formatted", () => {
    // A year value like 2024 with no display prefix/suffix should not be "2,024"
    expect(formatKBNumber(2024, undefined, {})).toBe("2024");
  });
});

// ── formatKBCellValue ────────────────────────────────────────────────

describe("formatKBCellValue", () => {
  it("returns em-dash for null", () => {
    expect(formatKBCellValue(null)).toBe("\u2014");
  });

  it("returns em-dash for undefined", () => {
    expect(formatKBCellValue(undefined)).toBe("\u2014");
  });

  describe("with field definition", () => {
    it("formats number with unit", () => {
      const fd: FieldDef = { type: "number", unit: "USD", description: "" };
      expect(formatKBCellValue(1_000_000_000, fd)).toBe("$1 billion");
    });

    it("formats date string", () => {
      const fd: FieldDef = { type: "date", description: "" };
      expect(formatKBCellValue("2024-03", fd)).toBe("Mar 2024");
    });

    it("formats boolean true as Yes", () => {
      const fd: FieldDef = { type: "boolean", description: "" };
      expect(formatKBCellValue(true, fd)).toBe("Yes");
    });

    it("formats boolean false as No", () => {
      const fd: FieldDef = { type: "boolean", description: "" };
      expect(formatKBCellValue(false, fd)).toBe("No");
    });

    it("returns string for ref type", () => {
      const fd: FieldDef = { type: "ref", description: "" };
      expect(formatKBCellValue("anthropic", fd)).toBe("anthropic");
    });

    it("JSON-stringifies object values for ref type", () => {
      const fd: FieldDef = { type: "ref", description: "" };
      expect(formatKBCellValue({ id: "test" }, fd)).toBe('{"id":"test"}');
    });

    it("returns string for text type", () => {
      const fd: FieldDef = { type: "text", description: "" };
      expect(formatKBCellValue("hello world", fd)).toBe("hello world");
    });

    it("JSON-stringifies object values for text type", () => {
      const fd: FieldDef = { type: "text", description: "" };
      expect(formatKBCellValue({ nested: true }, fd)).toBe('{"nested":true}');
    });
  });

  describe("without field definition (fallback)", () => {
    it("formats number with locale separators", () => {
      expect(formatKBCellValue(12345)).toBe("12,345");
    });

    it("formats boolean true as Yes", () => {
      expect(formatKBCellValue(true)).toBe("Yes");
    });

    it("formats boolean false as No", () => {
      expect(formatKBCellValue(false)).toBe("No");
    });

    it("joins array values with comma", () => {
      expect(formatKBCellValue(["a", "b", "c"])).toBe("a, b, c");
    });

    it("JSON-stringifies objects", () => {
      expect(formatKBCellValue({ x: 1 })).toBe('{"x":1}');
    });

    it("converts other values to string", () => {
      expect(formatKBCellValue("plain text")).toBe("plain text");
    });
  });
});

// ── formatKBFactValue additional types ───────────────────────────────

function makeFact(propertyId: string, value: Fact["value"]): Fact {
  return { id: "test", subjectId: "test", propertyId, value };
}

describe("formatKBFactValue additional coverage", () => {
  it("formats ref value as raw string", () => {
    const fact = makeFact("parent-org", { type: "ref", value: "anthropic" });
    expect(formatKBFactValue(fact)).toBe("anthropic");
  });

  it("formats refs value as comma-separated", () => {
    const fact = makeFact("subsidiaries", { type: "refs", value: ["openai", "anthropic"] });
    expect(formatKBFactValue(fact)).toBe("openai, anthropic");
  });

  it("filters out [object Object] text artifacts", () => {
    const fact = makeFact("junk", { type: "text", value: "[object Object]" });
    expect(formatKBFactValue(fact)).toBe("");
  });

  it("formats min value with >= prefix", () => {
    const fact = makeFact("revenue", { type: "min", value: 5_000_000_000 });
    expect(formatKBFactValue(fact, "USD")).toBe("\u2265$5 billion");
  });

  it("formats number fact with value-level unit when property unit absent", () => {
    const fact = makeFact("some-val", { type: "number", value: 100_000_000, unit: "USD" });
    // value.unit = "USD" should be used when property unit is not provided
    expect(formatKBFactValue(fact)).toBe("$100 million");
  });

  it("handles unknown/default case for unrecognized value types gracefully", () => {
    // Simulate an unknown value type
    const fact = makeFact("weird", { type: "custom" as never, value: "hello" } as never);
    expect(formatKBFactValue(fact)).toBe("hello");
  });

  it("handles unknown case with object value (JSON.stringify)", () => {
    const fact = makeFact("weird", { type: "custom" as never, value: { a: 1 } } as never);
    expect(formatKBFactValue(fact)).toBe('{"a":1}');
  });
});
