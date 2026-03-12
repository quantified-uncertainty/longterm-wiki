import { describe, it, expect } from "vitest";
import { parseCSVLine, reassembleCSVRows } from "../csv.ts";

describe("parseCSVLine", () => {
  it("parses simple comma-separated fields", () => {
    expect(parseCSVLine("a,b,c")).toEqual(["a", "b", "c"]);
  });

  it("handles quoted fields", () => {
    expect(parseCSVLine('"hello","world"')).toEqual(["hello", "world"]);
  });

  it("handles commas inside quotes", () => {
    expect(parseCSVLine('"a,b",c,"d,e"')).toEqual(["a,b", "c", "d,e"]);
  });

  it("handles escaped quotes (double-double)", () => {
    expect(parseCSVLine('"say ""hello""",done')).toEqual(['say "hello"', "done"]);
  });

  it("handles empty fields", () => {
    expect(parseCSVLine("a,,c,")).toEqual(["a", "", "c", ""]);
  });

  it("handles single field", () => {
    expect(parseCSVLine("hello")).toEqual(["hello"]);
  });

  it("handles empty string", () => {
    expect(parseCSVLine("")).toEqual([""]);
  });

  it("handles line with only commas", () => {
    expect(parseCSVLine(",,,")).toEqual(["", "", "", ""]);
  });

  it("handles very long field (>10K chars)", () => {
    const longField = "x".repeat(15000);
    const result = parseCSVLine(`a,${longField},c`);
    expect(result).toEqual(["a", longField, "c"]);
    expect(result[1]).toHaveLength(15000);
  });

  it("handles field with only whitespace", () => {
    expect(parseCSVLine("  ,\t,  \t  ")).toEqual(["  ", "\t", "  \t  "]);
  });
});

describe("reassembleCSVRows", () => {
  it("skips header and returns data rows", () => {
    const text = "Name,Amount\nGrant A,100\nGrant B,200";
    expect(reassembleCSVRows(text)).toEqual(["Grant A,100", "Grant B,200"]);
  });

  it("reassembles multi-line quoted fields", () => {
    const text = 'Name,Details\n"Grant A","Line 1\nLine 2",100';
    const rows = reassembleCSVRows(text);
    expect(rows.length).toBe(1);
    expect(rows[0]).toContain("Line 1\nLine 2");
  });

  it("handles empty lines between rows", () => {
    const text = "Header\nRow 1\n\nRow 2";
    const rows = reassembleCSVRows(text);
    expect(rows).toEqual(["Row 1", "Row 2"]);
  });

  it("returns empty array for header-only input", () => {
    const text = "Name,Amount";
    const rows = reassembleCSVRows(text);
    expect(rows).toEqual([]);
  });
});
