import { describe, it, expect } from "vitest";
import { parseCSVLine } from "../routes/wikibase/resources.js";

describe("parseCSVLine", () => {
  it("parses simple unquoted fields", () => {
    expect(parseCSVLine("a,b,c")).toEqual(["a", "b", "c"]);
  });

  it("parses quoted fields with commas", () => {
    expect(parseCSVLine('"hello, world",bar')).toEqual(["hello, world", "bar"]);
  });

  it("handles escaped quotes (doubled)", () => {
    expect(parseCSVLine('"he said ""hi""",ok')).toEqual(['he said "hi"', "ok"]);
  });

  it("handles trailing comma as empty field", () => {
    expect(parseCSVLine("a,b,")).toEqual(["a", "b", ""]);
  });

  it("handles single field (no commas)", () => {
    expect(parseCSVLine("hello")).toEqual(["hello"]);
  });

  it("handles single quoted field (no commas)", () => {
    expect(parseCSVLine('"hello"')).toEqual(["hello"]);
  });

  it("does not add spurious trailing field for quoted end-of-line", () => {
    expect(parseCSVLine('a,"b"')).toEqual(["a", "b"]);
  });

  it("handles empty string", () => {
    expect(parseCSVLine("")).toEqual([]);
  });

  it("handles quoted empty field", () => {
    expect(parseCSVLine('""')).toEqual([""]);
  });

  it("handles mixed quoted and unquoted", () => {
    expect(parseCSVLine('name,"city, state",age')).toEqual(["name", "city, state", "age"]);
  });

  it("handles real-world CSV header", () => {
    expect(parseCSVLine("Organization,Grant Title,Amount,Date")).toEqual([
      "Organization", "Grant Title", "Amount", "Date",
    ]);
  });
});
