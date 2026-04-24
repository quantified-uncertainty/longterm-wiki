import { describe, it, expect } from "vitest";
import {
  PURE_NUMERIC_STRING_RE,
  formatFactValueString,
} from "../format-cell-value";
import { sanitizeRawLargeNumbers } from "@/lib/format-compact";

describe("PURE_NUMERIC_STRING_RE", () => {
  it("accepts plain integers and decimals", () => {
    expect(PURE_NUMERIC_STRING_RE.test("1700000000")).toBe(true);
    expect(PURE_NUMERIC_STRING_RE.test("0.63")).toBe(true);
    expect(PURE_NUMERIC_STRING_RE.test("-0.5")).toBe(true);
    expect(PURE_NUMERIC_STRING_RE.test(".5")).toBe(true);
    expect(PURE_NUMERIC_STRING_RE.test("0")).toBe(true);
  });

  it("accepts scientific notation", () => {
    expect(PURE_NUMERIC_STRING_RE.test("1e+9")).toBe(true);
    expect(PURE_NUMERIC_STRING_RE.test("7e10")).toBe(true);
    expect(PURE_NUMERIC_STRING_RE.test("2.0097e+11")).toBe(true);
    expect(PURE_NUMERIC_STRING_RE.test("-1.5E-3")).toBe(true);
  });

  it("rejects non-numeric fact values that also appear in the facts.value column", () => {
    expect(PURE_NUMERIC_STRING_RE.test("Menlo Park, CA")).toBe(false);
    expect(PURE_NUMERIC_STRING_RE.test("sid_cMbVUVK29Q")).toBe(false);
    expect(PURE_NUMERIC_STRING_RE.test("0.015–0.025")).toBe(false); // en-dash range
    expect(PURE_NUMERIC_STRING_RE.test("1,700,000,000")).toBe(false); // pre-formatted
    expect(PURE_NUMERIC_STRING_RE.test("$1.7B")).toBe(false);
    expect(PURE_NUMERIC_STRING_RE.test("https://ai.meta.com/")).toBe(false);
    expect(PURE_NUMERIC_STRING_RE.test("2024-05")).toBe(false);
  });
});

describe("formatFactValueString (QUA-673)", () => {
  it("formats large numeric strings with USD prefix", () => {
    expect(formatFactValueString("1700000000", "USD")).toBe("$1.7B");
  });

  it("formats large numeric strings without a currency", () => {
    // Intent: the call site can still disambiguate via `row.currency`, but when
    // it's absent we fall back to the unit-less compact number so `user-count`
    // facts (e.g. 1e9 active users) don't render as `$1B`.
    expect(formatFactValueString("1000000000", null)).toBe("1B");
    expect(formatFactValueString("70000000000", undefined)).toBe("70B");
  });

  it("formats scientific notation strings", () => {
    expect(formatFactValueString("7e+10", "USD")).toBe("$70B");
    // formatCompactCurrency rounds to 0 decimals once abs >= 10 of the unit,
    // so 164.5B compacts to "$165B" (not "$164.5B"). The important contract
    // for QUA-673 is that no 10+ digit run remains.
    expect(formatFactValueString("1.645e+11", "USD")).toBe("$165B");
  });

  it("returns null for values < 1000 so small numbers render raw (no distortion)", () => {
    expect(formatFactValueString("63", null)).toBeNull();
    expect(formatFactValueString("999", null)).toBeNull();
    expect(formatFactValueString("-500", null)).toBeNull();
  });

  it("formats values >= 1000 as compact (below the render-audit threshold but still worth compacting)", () => {
    expect(formatFactValueString("1500", null)).toBe("1.5K");
    // formatCompactNumber rounds to 0 decimals once abs >= 10 of the unit.
    expect(formatFactValueString("78800", null)).toBe("79K");
  });

  it("returns null for non-numeric fact values", () => {
    expect(formatFactValueString("Menlo Park, CA", null)).toBeNull();
    expect(formatFactValueString("sid_abc", null)).toBeNull();
    expect(formatFactValueString("0.015–0.025", null)).toBeNull();
    expect(formatFactValueString("", null)).toBeNull();
    expect(formatFactValueString("   ", null)).toBeNull();
  });

  it("respects GBP currency", () => {
    expect(formatFactValueString("1325000000", "GBP")).toBe("£1.3B");
  });

  it("output never contains a bare 10+ digit run (the render-audit regex)", () => {
    const meta = [
      "1000000000",
      "69000000000",
      "125000000000",
      "70000000000",
      "164500000000",
      "200970000000",
      "27000000000",
    ];
    const bigDigitRegex = /(?<![a-zA-Z_])\d{10,}(?![a-zA-Z])/;
    for (const v of meta) {
      expect(formatFactValueString(v, "USD"), `USD ${v}`).not.toMatch(bigDigitRegex);
      expect(formatFactValueString(v, null), `plain ${v}`).not.toMatch(bigDigitRegex);
    }
  });
});

describe("sanitizeRawLargeNumbers (QUA-673)", () => {
  it("rewrites a bare 10+ digit run inside a label: value description", () => {
    // formatCompactNumber rounds to 1-decimal precision only below 10 of a
    // unit; 1.96B rounds to "2B", 1.7B stays "1.7B".
    expect(sanitizeRawLargeNumbers("Internal Revenue: 1700000000")).toBe(
      "Internal Revenue: 1.7B",
    );
    expect(sanitizeRawLargeNumbers("Internal Revenue: 1960000000")).toBe(
      "Internal Revenue: 2B",
    );
  });

  it("rewrites multiple runs in one string", () => {
    expect(
      sanitizeRawLargeNumbers("Parent Revenue: 164500000000; capex: 69000000000"),
    ).toBe("Parent Revenue: 165B; capex: 69B");
  });

  it("leaves sub-1000 numeric runs alone (phone-like codes that happen to be short)", () => {
    expect(sanitizeRawLargeNumbers("Code: 2024-05-23")).toBe("Code: 2024-05-23");
  });

  it("leaves numbers embedded inside alphanumeric tokens untouched (ids, hashes)", () => {
    // A stableId-looking token or commit hash must not be rewritten — only
    // runs that are already "bare" in the surrounding text.
    const hash = "abc1234567890def"; // 10 digits but embedded in alphanum
    expect(sanitizeRawLargeNumbers(hash)).toBe(hash);
  });

  it("leaves shorter digit runs alone", () => {
    // 9-digit runs are below the render-audit regex threshold and sometimes
    // legitimate (phone numbers, smaller identifiers). Keep untouched.
    expect(sanitizeRawLargeNumbers("Revenue: 123456789")).toBe(
      "Revenue: 123456789",
    );
  });

  it("is idempotent on an already-formatted description", () => {
    const formatted = "Internal Revenue: $1.7B";
    expect(sanitizeRawLargeNumbers(formatted)).toBe(formatted);
  });

  it("does not corrupt decimals that happen to contain a 10+ digit tail", () => {
    // Regression: an earlier regex fired on "1700000000.5" because the
    // trailing "." was not in the negative look-ahead, producing "1.7B.5".
    expect(sanitizeRawLargeNumbers("1700000000.5")).toBe("1700000000.5");
    expect(sanitizeRawLargeNumbers("Version 2.1700000000")).toBe("Version 2.1700000000");
    expect(sanitizeRawLargeNumbers("ratio 0.1700000000")).toBe("ratio 0.1700000000");
  });

  it("still rewrites currency-prefixed amounts and negatives", () => {
    // $ / space / start-of-string boundary should still allow a match.
    expect(sanitizeRawLargeNumbers("Total $1700000000")).toBe("Total $1.7B");
    // Negative values: the `-` is outside the captured digit run, so the
    // replacement happens and the sign is preserved in the surrounding text.
    expect(sanitizeRawLargeNumbers("Losses -1700000000")).toBe("Losses -1.7B");
  });

  it("eliminates every run the render-audit regex flags", () => {
    const raw =
      "Internal Revenue: 1700000000. Parent Revenue: 164500000000. Users: 1000000000.";
    const out = sanitizeRawLargeNumbers(raw);
    expect(out).not.toMatch(/(?<![a-zA-Z_])\d{10,}(?![a-zA-Z])/);
  });
});
