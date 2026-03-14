import { describe, expect, it } from "vitest";

import { compareByValue, type SortDir } from "./sort-utils";

// ── Helpers ──────────────────────────────────────────────────────

interface TestRow {
  value: string | number | null;
}

function row(value: string | number | null): TestRow {
  return { value };
}

function getValue(r: TestRow): string | number | null {
  return r.value;
}

function sort(rows: TestRow[], dir: SortDir): TestRow[] {
  return [...rows].sort((a, b) => compareByValue(a, b, getValue, dir));
}

// ═══════════════════════════════════════════════════════════════════
// compareByValue
// ═══════════════════════════════════════════════════════════════════

describe("compareByValue", () => {
  describe("numeric sorting", () => {
    it("sorts ascending (smaller first)", () => {
      expect(compareByValue(row(1), row(10), getValue, "asc")).toBeLessThan(0);
    });

    it("sorts descending (larger first)", () => {
      expect(compareByValue(row(1), row(10), getValue, "desc")).toBeGreaterThan(
        0,
      );
    });

    it("returns 0 for equal values ascending", () => {
      expect(compareByValue(row(42), row(42), getValue, "asc")).toBe(0);
    });

    it("returns 0 for equal values descending", () => {
      // (42 - 42) * -1 produces -0, which is functionally equal to 0 for sorting
      const result = compareByValue(row(42), row(42), getValue, "desc");
      expect(result === 0 || Object.is(result, -0)).toBe(true);
    });

    it("handles negative numbers", () => {
      expect(
        compareByValue(row(-5), row(3), getValue, "asc"),
      ).toBeLessThan(0);
      expect(
        compareByValue(row(-5), row(3), getValue, "desc"),
      ).toBeGreaterThan(0);
    });

    it("handles zero", () => {
      expect(compareByValue(row(0), row(5), getValue, "asc")).toBeLessThan(0);
      expect(compareByValue(row(0), row(-1), getValue, "asc")).toBeGreaterThan(
        0,
      );
    });

    it("handles large numbers", () => {
      expect(
        compareByValue(row(1e9), row(50e9), getValue, "asc"),
      ).toBeLessThan(0);
    });
  });

  describe("string sorting", () => {
    it("sorts ascending alphabetically", () => {
      expect(
        compareByValue(row("alpha"), row("beta"), getValue, "asc"),
      ).toBeLessThan(0);
    });

    it("sorts descending alphabetically", () => {
      expect(
        compareByValue(row("alpha"), row("beta"), getValue, "desc"),
      ).toBeGreaterThan(0);
    });

    it("returns 0 for equal strings", () => {
      expect(
        compareByValue(row("same"), row("same"), getValue, "asc"),
      ).toBe(0);
    });

    it("uses locale-aware comparison (localeCompare)", () => {
      // localeCompare is used for string comparison
      // "a" vs "b" should sort "a" first
      expect(
        compareByValue(row("a"), row("b"), getValue, "asc"),
      ).toBeLessThan(0);
    });

    it("handles empty strings", () => {
      expect(
        compareByValue(row(""), row("z"), getValue, "asc"),
      ).toBeLessThan(0);
      expect(
        compareByValue(row(""), row(""), getValue, "asc"),
      ).toBe(0);
    });
  });

  describe("null handling", () => {
    it("puts nulls last in ascending order", () => {
      expect(
        compareByValue(row(5), row(null), getValue, "asc"),
      ).toBeLessThan(0);
      expect(
        compareByValue(row(null), row(5), getValue, "asc"),
      ).toBeGreaterThan(0);
    });

    it("puts nulls last in descending order", () => {
      expect(
        compareByValue(row(5), row(null), getValue, "desc"),
      ).toBeLessThan(0);
      expect(
        compareByValue(row(null), row(5), getValue, "desc"),
      ).toBeGreaterThan(0);
    });

    it("treats two nulls as equal", () => {
      expect(compareByValue(row(null), row(null), getValue, "asc")).toBe(0);
      expect(compareByValue(row(null), row(null), getValue, "desc")).toBe(0);
    });

    it("handles null strings (null sorts after any string)", () => {
      expect(
        compareByValue(row("abc"), row(null), getValue, "asc"),
      ).toBeLessThan(0);
      expect(
        compareByValue(row(null), row("abc"), getValue, "desc"),
      ).toBeGreaterThan(0);
    });

    it("distinguishes 0 from null", () => {
      // 0 is a real value, not null
      expect(
        compareByValue(row(0), row(null), getValue, "asc"),
      ).toBeLessThan(0);
      expect(
        compareByValue(row(null), row(0), getValue, "asc"),
      ).toBeGreaterThan(0);
    });

    it("distinguishes empty string from null", () => {
      // Empty string is a real value, not null
      expect(
        compareByValue(row(""), row(null), getValue, "asc"),
      ).toBeLessThan(0);
      expect(
        compareByValue(row(null), row(""), getValue, "asc"),
      ).toBeGreaterThan(0);
    });
  });

  describe("mixed types in arrays", () => {
    it("sorts a mixed numeric array ascending with nulls last", () => {
      const rows = [row(30), row(null), row(10), row(null), row(20)];
      const sorted = sort(rows, "asc");
      expect(sorted.map((r) => r.value)).toEqual([10, 20, 30, null, null]);
    });

    it("sorts a mixed numeric array descending with nulls last", () => {
      const rows = [row(30), row(null), row(10), row(null), row(20)];
      const sorted = sort(rows, "desc");
      expect(sorted.map((r) => r.value)).toEqual([30, 20, 10, null, null]);
    });

    it("sorts a mixed string array ascending with nulls last", () => {
      const rows = [row("c"), row(null), row("a"), row("b"), row(null)];
      const sorted = sort(rows, "asc");
      expect(sorted.map((r) => r.value)).toEqual(["a", "b", "c", null, null]);
    });

    it("sorts a mixed string array descending with nulls last", () => {
      const rows = [row("c"), row(null), row("a"), row("b"), row(null)];
      const sorted = sort(rows, "desc");
      expect(sorted.map((r) => r.value)).toEqual(["c", "b", "a", null, null]);
    });

    it("handles array of all nulls", () => {
      const rows = [row(null), row(null), row(null)];
      const sorted = sort(rows, "asc");
      expect(sorted.map((r) => r.value)).toEqual([null, null, null]);
    });

    it("handles single-element array", () => {
      const rows = [row(42)];
      const sorted = sort(rows, "asc");
      expect(sorted.map((r) => r.value)).toEqual([42]);
    });

    it("handles empty array", () => {
      const sorted = sort([], "asc");
      expect(sorted).toEqual([]);
    });
  });

  describe("custom getValue", () => {
    interface NamedRow {
      name: string;
      score: number | null;
    }

    it("works with a custom value extractor", () => {
      const a: NamedRow = { name: "Alice", score: 90 };
      const b: NamedRow = { name: "Bob", score: 85 };
      const getScore = (r: NamedRow) => r.score;

      expect(compareByValue(a, b, getScore, "asc")).toBeGreaterThan(0);
      expect(compareByValue(a, b, getScore, "desc")).toBeLessThan(0);
    });
  });
});
