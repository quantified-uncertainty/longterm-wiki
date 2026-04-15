/**
 * Tests for fix-contradicted-facts.ts
 *
 * Tests the core logic: YAML fact indexing, LLM response parsing,
 * numeric formatting, and YAML file surgery.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildFactIndex,
  parseExtractionResponse,
  formatNumericValue,
  applyFix,
  type FactLocation,
} from "./fix-contradicted-facts.ts";

// ---------------------------------------------------------------------------
// buildFactIndex
// ---------------------------------------------------------------------------

describe("buildFactIndex", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "fix-facts-test-"));
  });

  it("indexes simple numeric facts", () => {
    writeFileSync(
      join(tempDir, "test-org.yaml"),
      `entity: sid_abc123
facts:
  - id: f_test001
    property: revenue
    value: 1000000
    asOf: 2024-01

  - id: f_test002
    property: headcount
    value: 250
    asOf: 2024-06
`,
    );

    const index = buildFactIndex(tempDir);
    expect(index.size).toBe(2);

    const fact1 = index.get("f_test001");
    expect(fact1).toBeDefined();
    expect(fact1!.entitySlug).toBe("test-org");
    expect(fact1!.property).toBe("revenue");
    expect(fact1!.currentNumericValue).toBe(1000000);
    expect(fact1!.isMultiLineValue).toBe(false);

    const fact2 = index.get("f_test002");
    expect(fact2).toBeDefined();
    expect(fact2!.property).toBe("headcount");
    expect(fact2!.currentNumericValue).toBe(250);
  });

  it("indexes scientific notation values", () => {
    writeFileSync(
      join(tempDir, "bigco.yaml"),
      `entity: sid_xyz789
facts:
  - id: f_sci001
    property: revenue
    value: 1e+9
    asOf: 2024-01
`,
    );

    const index = buildFactIndex(tempDir);
    const fact = index.get("f_sci001");
    expect(fact).toBeDefined();
    expect(fact!.currentNumericValue).toBe(1e9);
  });

  it("detects multi-line values", () => {
    writeFileSync(
      join(tempDir, "multi.yaml"),
      `entity: sid_multi1
facts:
  - id: f_ml001
    property: notable-for
    value: >-
      This is a long description
      that spans multiple lines
    source: https://example.com
`,
    );

    const index = buildFactIndex(tempDir);
    const fact = index.get("f_ml001");
    expect(fact).toBeDefined();
    expect(fact!.isMultiLineValue).toBe(true);
    expect(fact!.currentNumericValue).toBeNull();
  });

  it("handles string values", () => {
    writeFileSync(
      join(tempDir, "str.yaml"),
      `entity: sid_str1
facts:
  - id: f_str001
    property: status
    value: "active"
    asOf: 2024-01
`,
    );

    const index = buildFactIndex(tempDir);
    const fact = index.get("f_str001");
    expect(fact).toBeDefined();
    expect(fact!.currentNumericValue).toBeNull();
    expect(fact!.currentValueRaw).toBe('"active"');
  });

  it("respects entity filter", () => {
    writeFileSync(
      join(tempDir, "org-a.yaml"),
      `entity: sid_a
facts:
  - id: f_a001
    property: revenue
    value: 100
`,
    );
    writeFileSync(
      join(tempDir, "org-b.yaml"),
      `entity: sid_b
facts:
  - id: f_b001
    property: revenue
    value: 200
`,
    );

    const index = buildFactIndex(tempDir, "org-a");
    expect(index.size).toBe(1);
    expect(index.has("f_a001")).toBe(true);
    expect(index.has("f_b001")).toBe(false);
  });

  it("handles boolean-like values as non-numeric", () => {
    writeFileSync(
      join(tempDir, "boolish.yaml"),
      `entity: sid_bool1
facts:
  - id: f_bool001
    property: is-active
    value: true
`,
    );

    const index = buildFactIndex(tempDir);
    const fact = index.get("f_bool001");
    expect(fact).toBeDefined();
    expect(fact!.currentNumericValue).toBeNull();
  });

  it("handles negative numbers", () => {
    writeFileSync(
      join(tempDir, "neg.yaml"),
      `entity: sid_neg1
facts:
  - id: f_neg001
    property: net-income
    value: -5000000
`,
    );

    const index = buildFactIndex(tempDir);
    const fact = index.get("f_neg001");
    expect(fact).toBeDefined();
    expect(fact!.currentNumericValue).toBe(-5000000);
  });

  it("handles decimal values", () => {
    writeFileSync(
      join(tempDir, "dec.yaml"),
      `entity: sid_dec1
facts:
  - id: f_dec001
    property: share-price
    value: 142.57
`,
    );

    const index = buildFactIndex(tempDir);
    const fact = index.get("f_dec001");
    expect(fact).toBeDefined();
    expect(fact!.currentNumericValue).toBe(142.57);
  });
});

// ---------------------------------------------------------------------------
// parseExtractionResponse
// ---------------------------------------------------------------------------

describe("parseExtractionResponse", () => {
  it("parses a numeric extraction", () => {
    const text = '{"value": "115576357", "is_numeric": true, "description": "Exact figure from Form 990"}';
    const result = parseExtractionResponse(text);
    expect(result.correctValue).toBe(115576357);
    expect(result.isNumeric).toBe(true);
    expect(result.description).toBe("Exact figure from Form 990");
  });

  it("parses a numeric extraction wrapped in markdown", () => {
    const text = '```json\n{"value": "25500", "is_numeric": true, "description": "25,500 employees"}\n```';
    const result = parseExtractionResponse(text);
    expect(result.correctValue).toBe(25500);
    expect(result.isNumeric).toBe(true);
  });

  it("handles AMBIGUOUS response", () => {
    const text = '{"value": "AMBIGUOUS", "is_numeric": false, "description": "Multiple possible values in source"}';
    const result = parseExtractionResponse(text);
    expect(result.correctValue).toBeNull();
    expect(result.isNumeric).toBe(false);
    expect(result.description).toBe("Multiple possible values in source");
  });

  it("handles UNCLEAR response", () => {
    const text = '{"value": "UNCLEAR", "is_numeric": false, "description": "Cannot determine value"}';
    const result = parseExtractionResponse(text);
    expect(result.correctValue).toBeNull();
  });

  it("handles non-numeric extraction", () => {
    const text = '{"value": "March 2026", "is_numeric": false, "description": "Correct trial date"}';
    const result = parseExtractionResponse(text);
    expect(result.correctValue).toBeNull();
    expect(result.isNumeric).toBe(false);
    expect(result.rawExtraction).toBe("March 2026");
  });

  it("handles invalid JSON", () => {
    const text = "This is not JSON at all";
    const result = parseExtractionResponse(text);
    expect(result.correctValue).toBeNull();
    expect(result.description).toContain("Failed to parse");
  });

  it("handles is_numeric=true but non-numeric value", () => {
    const text = '{"value": "not-a-number", "is_numeric": true, "description": "Bad extraction"}';
    const result = parseExtractionResponse(text);
    expect(result.correctValue).toBeNull();
    expect(result.description).toContain("not a valid number");
  });

  it("parses zero correctly", () => {
    const text = '{"value": "0", "is_numeric": true, "description": "Zero value"}';
    const result = parseExtractionResponse(text);
    expect(result.correctValue).toBe(0);
    expect(result.isNumeric).toBe(true);
  });

  it("parses negative numbers", () => {
    const text = '{"value": "-5000000", "is_numeric": true, "description": "Net loss"}';
    const result = parseExtractionResponse(text);
    expect(result.correctValue).toBe(-5000000);
    expect(result.isNumeric).toBe(true);
  });

  it("parses decimal numbers", () => {
    const text = '{"value": "0.45", "is_numeric": true, "description": "45% as decimal"}';
    const result = parseExtractionResponse(text);
    expect(result.correctValue).toBe(0.45);
    expect(result.isNumeric).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// formatNumericValue
// ---------------------------------------------------------------------------

describe("formatNumericValue", () => {
  it("formats exact integers", () => {
    expect(formatNumericValue(115576357)).toBe("115576357");
  });

  it("formats large round numbers as scientific notation", () => {
    expect(formatNumericValue(1000000000)).toBe("1e+9");
    expect(formatNumericValue(2000000000)).toBe("2e+9");
    expect(formatNumericValue(10000000)).toBe("1e+7");
  });

  it("does NOT use scientific notation for non-round large numbers", () => {
    expect(formatNumericValue(152422669)).toBe("152422669");
    expect(formatNumericValue(115576357)).toBe("115576357");
    expect(formatNumericValue(1234567)).toBe("1234567");
  });

  it("formats zero", () => {
    expect(formatNumericValue(0)).toBe("0");
  });

  it("formats negative round numbers with scientific notation", () => {
    expect(formatNumericValue(-5000000)).toBe("-5e+6");
    expect(formatNumericValue(-1000000000)).toBe("-1e+9");
  });

  it("formats negative non-round numbers without scientific notation", () => {
    expect(formatNumericValue(-5123456)).toBe("-5123456");
  });

  it("formats decimals", () => {
    expect(formatNumericValue(0.45)).toBe("0.45");
    expect(formatNumericValue(142.57)).toBe("142.57");
  });

  it("formats Infinity as string", () => {
    expect(formatNumericValue(Infinity)).toBe("Infinity");
  });

  it("formats NaN as string", () => {
    expect(formatNumericValue(NaN)).toBe("NaN");
  });

  it("formats 5e+8 correctly", () => {
    expect(formatNumericValue(500000000)).toBe("5e+8");
  });

  it("does NOT use scientific notation for values with >1 significant digit", () => {
    // 12000000 has "12" before trailing zeros — more than 1 significant digit
    expect(formatNumericValue(12000000)).toBe("12000000");
    // 15000000 has "15" — should NOT use sci notation
    expect(formatNumericValue(15000000)).toBe("15000000");
    // 100000000 has "1" before trailing zeros — should use sci notation
    expect(formatNumericValue(100000000)).toBe("1e+8");
  });
});

// ---------------------------------------------------------------------------
// applyFix
// ---------------------------------------------------------------------------

describe("applyFix", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "fix-facts-apply-"));
  });

  it("updates a simple numeric value", () => {
    const filePath = join(tempDir, "test.yaml");
    writeFileSync(
      filePath,
      `entity: sid_test1
facts:
  - id: f_test001
    property: annual-expenses
    value: 116000000
    asOf: "2023"
    source: https://example.com
`,
    );

    const location: FactLocation = {
      filePath,
      entitySlug: "test",
      idLineIndex: 2,
      valueLineIndex: 4,
      currentValueRaw: "116000000",
      currentNumericValue: 116000000,
      isMultiLineValue: false,
      property: "annual-expenses",
    };

    const success = applyFix(location, 115576357);
    expect(success).toBe(true);

    const updated = readFileSync(filePath, "utf-8");
    expect(updated).toContain("value: 115576357");
    // Verify other lines are preserved
    expect(updated).toContain("entity: sid_test1");
    expect(updated).toContain('asOf: "2023"');
    expect(updated).toContain("source: https://example.com");
  });

  it("preserves indentation", () => {
    const filePath = join(tempDir, "indent.yaml");
    writeFileSync(
      filePath,
      `entity: sid_test2
facts:
  - id: f_test002
    property: revenue
    value: 1e+8
    asOf: 2024-01
`,
    );

    const location: FactLocation = {
      filePath,
      entitySlug: "indent",
      idLineIndex: 2,
      valueLineIndex: 4,
      currentValueRaw: "1e+8",
      currentNumericValue: 1e8,
      isMultiLineValue: false,
      property: "revenue",
    };

    const success = applyFix(location, 151012759);
    expect(success).toBe(true);

    const updated = readFileSync(filePath, "utf-8");
    expect(updated).toContain("    value: 151012759");
  });

  it("uses scientific notation for large round values", () => {
    const filePath = join(tempDir, "sci.yaml");
    writeFileSync(
      filePath,
      `entity: sid_test3
facts:
  - id: f_test003
    property: revenue
    value: 900000000
    asOf: 2024-01
`,
    );

    const location: FactLocation = {
      filePath,
      entitySlug: "sci",
      idLineIndex: 2,
      valueLineIndex: 4,
      currentValueRaw: "900000000",
      currentNumericValue: 900000000,
      isMultiLineValue: false,
      property: "revenue",
    };

    const success = applyFix(location, 1000000000);
    expect(success).toBe(true);

    const updated = readFileSync(filePath, "utf-8");
    expect(updated).toContain("value: 1e+9");
  });

  it("does not corrupt other facts in the file", () => {
    const filePath = join(tempDir, "multi.yaml");
    writeFileSync(
      filePath,
      `entity: sid_test4
facts:
  - id: f_first
    property: revenue
    value: 100000
    asOf: 2024-01

  - id: f_second
    property: headcount
    value: 500
    asOf: 2024-01
`,
    );

    const location: FactLocation = {
      filePath,
      entitySlug: "multi",
      idLineIndex: 2,
      valueLineIndex: 4,
      currentValueRaw: "100000",
      currentNumericValue: 100000,
      isMultiLineValue: false,
      property: "revenue",
    };

    const success = applyFix(location, 99999);
    expect(success).toBe(true);

    const updated = readFileSync(filePath, "utf-8");
    expect(updated).toContain("value: 99999");
    // Second fact should be untouched
    expect(updated).toContain("value: 500");
    expect(updated).toContain("id: f_second");
  });
});
