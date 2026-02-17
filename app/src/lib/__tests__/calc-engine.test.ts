import { describe, it, expect } from "vitest";
import { calc, formatValue, type CalcFormat } from "../calc-engine";
import type { Fact } from "@/data";

// Mock fact store
const mockFacts: Record<string, Fact> = {
  "anthropic.valuation": {
    value: "$380 billion",
    numeric: 380_000_000_000,
    asOf: "2026-02",
    entity: "anthropic",
    factId: "valuation",
  },
  "anthropic.revenue-arr-2025": {
    value: "$9 billion",
    numeric: 9_000_000_000,
    asOf: "2025-12",
    entity: "anthropic",
    factId: "revenue-arr-2025",
  },
  "anthropic.gross-margin": {
    value: "40%",
    numeric: 0.4,
    asOf: "2025",
    entity: "anthropic",
    factId: "gross-margin",
  },
  "anthropic.business-customers": {
    value: "300,000+",
    numeric: 300_000,
    asOf: "2025",
    entity: "anthropic",
    factId: "business-customers",
  },
};

function mockLookup(entity: string, factId: string): Fact | undefined {
  return mockFacts[`${entity}.${factId}`];
}

// ────────────────────────────────────────────────────────────
// Expression evaluation
// ────────────────────────────────────────────────────────────

describe("calc — expression evaluation", () => {
  it("evaluates a simple fact reference", () => {
    const result = calc("{anthropic.valuation}", mockLookup);
    expect(result.value).toBe(380_000_000_000);
  });

  it("evaluates division of two facts", () => {
    const result = calc(
      "{anthropic.valuation} / {anthropic.revenue-arr-2025}",
      mockLookup
    );
    expect(result.value).toBeCloseTo(42.22, 1);
  });

  it("evaluates multiplication", () => {
    const result = calc("{anthropic.revenue-arr-2025} * 2", mockLookup);
    expect(result.value).toBe(18_000_000_000);
  });

  it("evaluates addition and subtraction", () => {
    const result = calc(
      "{anthropic.valuation} - {anthropic.revenue-arr-2025}",
      mockLookup
    );
    expect(result.value).toBe(371_000_000_000);
  });

  it("evaluates parenthesized expressions", () => {
    const result = calc(
      "({anthropic.valuation} + {anthropic.revenue-arr-2025}) / 2",
      mockLookup
    );
    expect(result.value).toBe(194_500_000_000);
  });

  it("evaluates exponentiation", () => {
    const result = calc("2 ^ 10", mockLookup);
    expect(result.value).toBe(1024);
  });

  it("evaluates unary negation", () => {
    const result = calc("-{anthropic.revenue-arr-2025}", mockLookup);
    expect(result.value).toBe(-9_000_000_000);
  });

  it("evaluates scientific notation", () => {
    const result = calc("1e9 + {anthropic.revenue-arr-2025}", mockLookup);
    expect(result.value).toBe(10_000_000_000);
  });

  it("handles plain numeric expressions with no fact refs", () => {
    const result = calc("100 * 3 + 50", mockLookup);
    expect(result.value).toBe(350);
  });
});

// ────────────────────────────────────────────────────────────
// Error handling
// ────────────────────────────────────────────────────────────

describe("calc — error handling", () => {
  it("throws on unknown fact reference", () => {
    expect(() => calc("{nonexistent.fact}", mockLookup)).toThrow("Unknown fact");
  });

  it("throws on malformed reference (no dot)", () => {
    expect(() => calc("{nodot}", mockLookup)).toThrow("expected {entity.factId}");
  });

  it("throws on division by zero", () => {
    expect(() => calc("{anthropic.valuation} / 0", mockLookup)).toThrow(
      "Division by zero"
    );
  });

  it("throws on unexpected characters", () => {
    expect(() => calc("{anthropic.valuation} @ 2", mockLookup)).toThrow(
      "Unexpected character"
    );
  });
});

// ────────────────────────────────────────────────────────────
// Input tracking
// ────────────────────────────────────────────────────────────

describe("calc — input tracking", () => {
  it("tracks all referenced facts", () => {
    const result = calc(
      "{anthropic.valuation} / {anthropic.revenue-arr-2025}",
      mockLookup
    );
    expect(result.inputs).toHaveLength(2);
    expect(result.inputs[0].ref).toBe("anthropic.valuation");
    expect(result.inputs[0].value).toBe("$380 billion");
    expect(result.inputs[0].asOf).toBe("2026-02");
    expect(result.inputs[1].ref).toBe("anthropic.revenue-arr-2025");
  });

  it("preserves the original expression", () => {
    const expr = "{anthropic.valuation} / {anthropic.revenue-arr-2025}";
    const result = calc(expr, mockLookup);
    expect(result.expr).toBe(expr);
  });
});

// ────────────────────────────────────────────────────────────
// Formatting
// ────────────────────────────────────────────────────────────

describe("formatValue", () => {
  it("auto-formats large numbers with scale suffix", () => {
    expect(formatValue(380_000_000_000)).toBe("380.0 billion");
    expect(formatValue(9_000_000_000)).toBe("9.0 billion");
    expect(formatValue(1_500_000)).toBe("1.5 million");
    expect(formatValue(2_000_000_000_000)).toBe("2.0 trillion");
  });

  it("formats currency with $ prefix", () => {
    expect(formatValue(380_000_000_000, { format: "currency" })).toBe(
      "$380.0 billion"
    );
    expect(formatValue(9_000_000_000, { format: "currency" })).toBe(
      "$9.0 billion"
    );
    expect(formatValue(1_500, { format: "currency" })).toBe("$1,500");
  });

  it("formats percentages from decimal", () => {
    expect(formatValue(0.4, { format: "percent" })).toBe("40%");
    expect(formatValue(0.883, { format: "percent", precision: 1 })).toBe(
      "88.3%"
    );
  });

  it("formats numbers with commas", () => {
    expect(formatValue(300_000, { format: "number" })).toBe("300,000");
  });

  it("applies precision", () => {
    expect(formatValue(38.888, { precision: 1 })).toBe("38.9");
    expect(formatValue(38.888, { precision: 0 })).toBe("39");
  });

  it("applies prefix and suffix", () => {
    expect(formatValue(38.9, { precision: 1, suffix: "x" })).toBe("38.9x");
    expect(formatValue(42, { prefix: "~", suffix: "%" })).toBe("~42%");
  });

  it("formats negative currency", () => {
    expect(formatValue(-5_000_000_000, { format: "currency" })).toBe(
      "-$5.0 billion"
    );
  });
});

// ────────────────────────────────────────────────────────────
// Integration: calc with formatting
// ────────────────────────────────────────────────────────────

describe("calc — formatted output", () => {
  it("formats P/S ratio with suffix", () => {
    const result = calc(
      "{anthropic.valuation} / {anthropic.revenue-arr-2025}",
      mockLookup,
      { precision: 0, suffix: "x" }
    );
    expect(result.display).toBe("42x");
  });

  it("formats gross margin as percent", () => {
    const result = calc("{anthropic.gross-margin}", mockLookup, {
      format: "percent",
    });
    expect(result.display).toBe("40%");
  });

  it("formats revenue as currency", () => {
    const result = calc("{anthropic.revenue-arr-2025}", mockLookup, {
      format: "currency",
    });
    expect(result.display).toBe("$9.0 billion");
  });
});
