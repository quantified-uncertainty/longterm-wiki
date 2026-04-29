import { describe, it, expect } from "vitest";
import {
  CURRENCY_COLUMNS,
  PERCENTAGE_COLUMNS,
  ENTITY_REF_FALLBACKS,
  tryParseNumeric,
  formatPercentage,
  resolveFallbackValue,
} from "../format-numeric";

describe("tryParseNumeric (QUA-767)", () => {
  it("accepts plain numbers", () => {
    expect(tryParseNumeric(0)).toBe(0);
    expect(tryParseNumeric(42)).toBe(42);
    expect(tryParseNumeric(-1.5)).toBe(-1.5);
    expect(tryParseNumeric(450_000_000)).toBe(450_000_000);
  });

  it("accepts numeric strings (Drizzle returns numeric() as string)", () => {
    expect(tryParseNumeric("450000000")).toBe(450_000_000);
    expect(tryParseNumeric("0.07")).toBe(0.07);
    expect(tryParseNumeric("-1.5")).toBe(-1.5);
    expect(tryParseNumeric("1e9")).toBe(1_000_000_000);
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(tryParseNumeric("  450  ")).toBe(450);
  });

  it("returns null for null/undefined/non-string-non-number", () => {
    expect(tryParseNumeric(null)).toBeNull();
    expect(tryParseNumeric(undefined)).toBeNull();
    expect(tryParseNumeric({})).toBeNull();
    expect(tryParseNumeric([1, 2])).toBeNull();
    expect(tryParseNumeric(true)).toBeNull();
  });

  it("returns null for empty / whitespace-only strings", () => {
    expect(tryParseNumeric("")).toBeNull();
    expect(tryParseNumeric("   ")).toBeNull();
  });

  it('returns null for non-numeric strings like "not-a-number"', () => {
    expect(tryParseNumeric("not-a-number")).toBeNull();
    expect(tryParseNumeric("Menlo Park, CA")).toBeNull();
    expect(tryParseNumeric("sid_abc123")).toBeNull();
  });

  it('returns null for range strings like "[0.07, 0.15]" so they fall through to JSON renderer', () => {
    expect(tryParseNumeric("[0.07, 0.15]")).toBeNull();
    expect(tryParseNumeric("[1, 2, 3]")).toBeNull();
    expect(tryParseNumeric('{"low": 0.07}')).toBeNull();
  });

  it("returns null for NaN / Infinity / -Infinity", () => {
    expect(tryParseNumeric(NaN)).toBeNull();
    expect(tryParseNumeric(Infinity)).toBeNull();
    expect(tryParseNumeric(-Infinity)).toBeNull();
    expect(tryParseNumeric("NaN")).toBeNull();
    expect(tryParseNumeric("Infinity")).toBeNull();
  });

  it("handles very large numeric strings without precision loss for typical funding amounts", () => {
    // $4 billion — the largest funding round in QUA-90 acceptance criteria
    expect(tryParseNumeric("4000000000")).toBe(4_000_000_000);
    // Above Number.MAX_SAFE_INTEGER would lose precision, but tryParseNumeric
    // still returns *some* finite number rather than null. Worth a regression
    // marker so anyone changing the helper notices.
    const huge = tryParseNumeric("9007199254740993"); // MAX_SAFE_INTEGER + 2
    expect(huge).not.toBeNull();
    expect(Number.isFinite(huge)).toBe(true);
  });
});

describe("formatPercentage (QUA-767)", () => {
  it("formats 0–1 decimals as X.X% (multiplies by 100)", () => {
    expect(formatPercentage(0.07)).toBe("7%");
    expect(formatPercentage(0.15)).toBe("15%");
    expect(formatPercentage(0.123)).toBe("12.3%");
    expect(formatPercentage(0.5)).toBe("50%");
    expect(formatPercentage(1)).toBe("100%");
  });

  it("treats values > 1 as already-percent-points (legacy data)", () => {
    expect(formatPercentage(15)).toBe("15%");
    expect(formatPercentage(7.5)).toBe("7.5%");
  });

  it("strips trailing .0 for clean display", () => {
    expect(formatPercentage(0.07)).toBe("7%"); // not "7.0%"
    expect(formatPercentage(0.5)).toBe("50%"); // not "50.0%"
  });

  it("preserves one decimal when the value has fractional precision", () => {
    expect(formatPercentage(0.073)).toBe("7.3%");
    expect(formatPercentage(0.155)).toBe("15.5%");
  });

  it("handles zero and negative values", () => {
    expect(formatPercentage(0)).toBe("0%");
    // Negative stake is unusual but should not crash; formatter preserves sign.
    expect(formatPercentage(-0.05)).toBe("-5%");
  });
});

describe("CURRENCY_COLUMNS membership (QUA-767)", () => {
  it("includes every column the set is documented to contain", () => {
    // Locking down the full membership so a future drop / rename / typo
    // surfaces as a test failure instead of a silent regression in formatting.
    const expected = [
      "amount", "raised", "raised_low", "raised_high",
      "valuation", "valuation_low", "valuation_high",
      "amount_low", "amount_high", "total_budget",
      "usd_equivalent", "cost_usd",
    ];
    expect(CURRENCY_COLUMNS.size).toBe(expected.length);
    for (const col of expected) {
      expect(CURRENCY_COLUMNS.has(col), `expected ${col} in CURRENCY_COLUMNS`).toBe(true);
    }
  });

  it("does NOT include obviously-non-currency columns", () => {
    expect(CURRENCY_COLUMNS.has("stake_low")).toBe(false);
    expect(CURRENCY_COLUMNS.has("stake_high")).toBe(false);
    expect(CURRENCY_COLUMNS.has("entity_id")).toBe(false);
    expect(CURRENCY_COLUMNS.has("title")).toBe(false);
    expect(CURRENCY_COLUMNS.has("notes")).toBe(false);
  });
});

describe("PERCENTAGE_COLUMNS membership (QUA-767)", () => {
  it("includes the stake columns named in the QUA-767 task list", () => {
    expect(PERCENTAGE_COLUMNS.has("stake_low")).toBe(true);
    expect(PERCENTAGE_COLUMNS.has("stake_high")).toBe(true);
  });

  it("does NOT overlap with CURRENCY_COLUMNS", () => {
    for (const col of PERCENTAGE_COLUMNS) {
      expect(CURRENCY_COLUMNS.has(col), `${col} should not be in both sets`).toBe(false);
    }
  });
});

describe("ENTITY_REF_FALLBACKS (QUA-767)", () => {
  it("maps lead_investor_entity_id to the legacy raw text column", () => {
    expect(ENTITY_REF_FALLBACKS["lead_investor_entity_id"]).toBe("leadInvestor");
  });

  it("uses camelCase keys on the right-hand side (matches Drizzle row shape)", () => {
    // The viewer reads `row[ENTITY_REF_FALLBACKS[col.name]]`. Drizzle rows
    // arrive with camelCase keys, so a snake_case fallback target would
    // silently miss every row.
    for (const fallback of Object.values(ENTITY_REF_FALLBACKS)) {
      if (fallback === undefined) continue;
      expect(fallback, `fallback ${fallback} must be camelCase`).not.toMatch(/_/);
    }
  });
});

describe("resolveFallbackValue (QUA-767)", () => {
  const row = {
    leadInvestor: "Sequoia Capital",
    leadInvestorEntityId: null,
    notes: "ok",
  };

  it("returns the primary value untouched when it is non-empty", () => {
    const r = resolveFallbackValue("sid_abc", "lead_investor_entity_id", row);
    expect(r).toEqual({ value: "sid_abc", isFallback: false });
  });

  it("falls back to the legacy text column when primary is null", () => {
    const r = resolveFallbackValue(null, "lead_investor_entity_id", row);
    expect(r).toEqual({ value: "Sequoia Capital", isFallback: true });
  });

  it("falls back when primary is undefined", () => {
    const r = resolveFallbackValue(undefined, "lead_investor_entity_id", row);
    expect(r).toEqual({ value: "Sequoia Capital", isFallback: true });
  });

  it("falls back when primary is the empty string", () => {
    const r = resolveFallbackValue("", "lead_investor_entity_id", row);
    expect(r).toEqual({ value: "Sequoia Capital", isFallback: true });
  });

  it("does NOT fall back when the column has no fallback configured", () => {
    const r = resolveFallbackValue(null, "company_entity_id", row);
    expect(r).toEqual({ value: null, isFallback: false });
  });

  it("does NOT fall back when the fallback row key is missing on the row", () => {
    const r = resolveFallbackValue(null, "lead_investor_entity_id", { foo: "bar" });
    expect(r).toEqual({ value: null, isFallback: false });
  });

  it("does NOT fall back when the fallback row key is the empty string", () => {
    const r = resolveFallbackValue(null, "lead_investor_entity_id", { leadInvestor: "" });
    expect(r).toEqual({ value: null, isFallback: false });
  });

  it("rejects non-string fallback candidates so a 'Lead Investor' column never renders a JSON blob", () => {
    // A stray numeric / object / boolean in the legacy column would otherwise
    // flow into `CellValue` and render through the JsonValue / boolean paths,
    // producing absurd output in a column labeled "Lead Investor".
    expect(resolveFallbackValue(null, "lead_investor_entity_id", { leadInvestor: 42 }))
      .toEqual({ value: null, isFallback: false });
    expect(resolveFallbackValue(null, "lead_investor_entity_id", { leadInvestor: { name: "x" } }))
      .toEqual({ value: null, isFallback: false });
    expect(resolveFallbackValue(null, "lead_investor_entity_id", { leadInvestor: true }))
      .toEqual({ value: null, isFallback: false });
  });

  it("returns the primary value untouched when row is undefined", () => {
    const r = resolveFallbackValue(null, "lead_investor_entity_id", undefined);
    expect(r).toEqual({ value: null, isFallback: false });
  });
});
