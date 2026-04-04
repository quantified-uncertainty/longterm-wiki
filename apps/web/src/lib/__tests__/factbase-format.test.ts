/**
 * Tests for formatKBNumber and formatKBFactValue in factbase/format.ts.
 *
 * Covers Bug 28 (unformatted large numbers) and Bug 29 (missing % signs)
 * which occurred when property definitions were absent or missing unit metadata.
 */
import { describe, expect, it } from "vitest";
import {
  formatKBNumber,
  formatKBFactValue,
} from "@components/wiki/factbase/format";
import type { Fact } from "@longterm-wiki/factbase";

// ── formatKBNumber ────────────────────────────────────────────────────

describe("formatKBNumber", () => {
  describe("with known unit (smart formatter)", () => {
    it("formats USD billions", () => {
      expect(formatKBNumber(5_500_000_000, "USD")).toBe("$5.5 billion");
    });

    it("formats USD millions", () => {
      expect(formatKBNumber(850_000_000, "USD")).toBe("$850 million");
    });

    it("formats percent", () => {
      expect(formatKBNumber(88, "percent")).toBe("88%");
    });

    it("formats count billions", () => {
      expect(formatKBNumber(2_500_000_000, "count")).toBe("2.5 billion");
    });
  });

  describe("with display config (no unit)", () => {
    it("applies divisor and suffix", () => {
      // monthly-active-users: divisor 1e6, suffix "M"
      expect(formatKBNumber(18_900_000, undefined, { divisor: 1e6, suffix: "M" })).toBe("18.9M");
    });

    it("applies prefix and suffix with divisor", () => {
      // revenue-like display
      expect(formatKBNumber(2_000_000_000, undefined, { divisor: 1e9, prefix: "$", suffix: "B" })).toBe("$2B");
    });

    it("converts fraction to percent via divisor 0.01 (Bug 29 fix: fraction properties)", () => {
      // gov-retention-rate stored as 0-1, display converts to percent
      expect(formatKBNumber(0.85, undefined, { divisor: 0.01, suffix: "%" })).toBe("85%");
    });
  });

  describe("fallback: no unit, no display (Bug 28 fix)", () => {
    it("uses smart magnitude formatting for large numbers instead of raw toLocaleString", () => {
      // Before fix: "5,500,000,000" — After fix: "5.5 billion"
      expect(formatKBNumber(5_500_000_000)).toBe("5.5 billion");
    });

    it("formats trillion values", () => {
      expect(formatKBNumber(1_200_000_000_000)).toBe("1.2 trillion");
    });

    it("formats million values", () => {
      expect(formatKBNumber(270_000_000)).toBe("270 million");
    });

    it("formats small numbers with locale separators", () => {
      // Under 1M: toLocaleString still applies
      expect(formatKBNumber(50)).toBe("50");
      expect(formatKBNumber(1500)).toBe("1,500");
    });

    it("preserves year-like integers (1800–2100) as plain strings", () => {
      expect(formatKBNumber(2024)).toBe("2024");
      expect(formatKBNumber(1975)).toBe("1975");
    });

    it("does not add currency symbol when no unit or currency provided", () => {
      expect(formatKBNumber(380_000_000_000)).toBe("380 billion");
      expect(formatKBNumber(380_000_000_000)).not.toContain("$");
    });
  });
});

// ── formatKBFactValue ─────────────────────────────────────────────────

function makeFact(propertyId: string, value: Fact["value"]): Fact {
  return { id: "test", subjectId: "test", propertyId, value };
}

describe("formatKBFactValue", () => {
  describe("Bug 29: percentage facts without property definition", () => {
    it("formats number fact with percent unit", () => {
      // retention-rate has unit: percent in properties.yaml
      const fact = makeFact("retention-rate", { type: "number", value: 88 });
      expect(formatKBFactValue(fact, "percent", { suffix: "%" })).toBe("88%");
    });

    it("formats number fact with percent unit — customer-concentration", () => {
      const fact = makeFact("customer-concentration", { type: "number", value: 25 });
      expect(formatKBFactValue(fact, "percent", { suffix: "%" })).toBe("25%");
    });

    it("formats number fact with percent unit — safety-staffing-ratio", () => {
      const fact = makeFact("safety-staffing-ratio", { type: "number", value: 25 });
      expect(formatKBFactValue(fact, "percent", { suffix: "%" })).toBe("25%");
    });

    it("formats fraction property via display divisor (gov-retention-rate = 0.85 → 85%)", () => {
      const fact = makeFact("gov-retention-rate", { type: "number", value: 0.85 });
      expect(formatKBFactValue(fact, undefined, { divisor: 0.01, suffix: "%" })).toBe("85%");
    });

    it("returns raw number string without property metadata (no % added)", () => {
      // When property is completely unknown, we can't infer percentage
      const fact = makeFact("unknown-rate", { type: "number", value: 88 });
      // With no unit/display, formatKBNumber falls back to smart formatter
      // 88 is < 1M so it stays as "88" (not "88%")
      expect(formatKBFactValue(fact, undefined, undefined)).toBe("88");
    });
  });

  describe("Bug 28: large monetary values without property definition", () => {
    it("formats large USD number with unit (property found)", () => {
      // employee-tender-offer with unit: USD
      const fact = makeFact("employee-tender-offer", { type: "number", value: 5_500_000_000 });
      expect(formatKBFactValue(fact, "USD")).toBe("$5.5 billion");
    });

    it("formats large number without unit using smart magnitude fallback", () => {
      // Before fix: "5,500,000,000" — After fix: "5.5 billion"
      const fact = makeFact("unknown-monetary", { type: "number", value: 5_500_000_000 });
      expect(formatKBFactValue(fact, undefined, undefined)).toBe("5.5 billion");
    });

    it("formats very large numbers without unit", () => {
      const fact = makeFact("unknown-cap", { type: "number", value: 270_000_000_000 });
      expect(formatKBFactValue(fact, undefined, undefined)).toBe("270 billion");
    });

    it("formats range without property definition using smart magnitude", () => {
      // range: {low: 53B, high: 80B} with no unit
      const fact = makeFact("unknown-range", { type: "range", low: 53_000_000_000, high: 80_000_000_000 });
      expect(formatKBFactValue(fact, undefined, undefined)).toBe("53 billion\u201380 billion");
    });

    it("formats range with USD unit (property found)", () => {
      const fact = makeFact("revenue", { type: "range", low: 1_000_000_000, high: 2_000_000_000 });
      expect(formatKBFactValue(fact, "USD")).toBe("$1 billion\u2013$2 billion");
    });
  });

  describe("Bug #3305: range and min values missing currency", () => {
    it("passes currency to formatKBNumber for range values", () => {
      const fact: Fact = {
        id: "test", subjectId: "test", propertyId: "revenue",
        value: { type: "range", low: 20_000_000_000, high: 26_000_000_000 },
        currency: "GBP",
      };
      const result = formatKBFactValue(fact, "USD");
      expect(result).toContain("£");
      expect(result).not.toContain("$");
    });

    it("passes currency to formatKBNumber for min values", () => {
      const fact: Fact = {
        id: "test", subjectId: "test", propertyId: "revenue",
        value: { type: "min", value: 5_000_000_000 },
        currency: "GBP",
      };
      const result = formatKBFactValue(fact, "USD");
      expect(result).toContain("£");
      expect(result).not.toContain("$");
    });

    it("uses range value own unit when property unit is absent", () => {
      const fact = makeFact("unknown-prop", { type: "range", low: 1_000_000_000, high: 2_000_000_000, unit: "USD" });
      const result = formatKBFactValue(fact);
      expect(result).toContain("$");
    });

    it("uses min value own unit when property unit is absent", () => {
      const fact = makeFact("unknown-prop", { type: "min", value: 1_000_000_000, unit: "USD" });
      const result = formatKBFactValue(fact);
      expect(result).toContain("$");
    });
  });

  describe("Bug #3305: JSON-wrapped nested FactValue objects", () => {
    it("unwraps nested number from json format", () => {
      const fact = makeFact("valuation", { type: "json", value: { type: "number", value: 500_000_000_000 } });
      expect(formatKBFactValue(fact, "USD")).toBe("$500 billion");
    });

    it("unwraps nested number with unit from json format", () => {
      const fact = makeFact("valuation", { type: "json", value: { type: "number", value: 500_000_000_000, unit: "USD" } });
      expect(formatKBFactValue(fact)).toBe("$500 billion");
    });

    it("unwraps nested text from json format", () => {
      const fact = makeFact("some-field", { type: "json", value: { type: "text", value: "Hello World" } });
      expect(formatKBFactValue(fact)).toBe("Hello World");
    });

    it("unwraps nested boolean from json format", () => {
      const fact = makeFact("some-bool", { type: "json", value: { type: "boolean", value: true } });
      expect(formatKBFactValue(fact)).toBe("Yes");
    });

    it("unwraps nested date from json format", () => {
      const fact = makeFact("some-date", { type: "json", value: { type: "date", value: "2025-06" } });
      expect(formatKBFactValue(fact)).toBe("Jun 2025");
    });

    it("falls back to JSON.stringify for non-FactValue json objects", () => {
      const fact = makeFact("some-json", { type: "json", value: { foo: "bar", baz: 42 } });
      expect(formatKBFactValue(fact)).toBe('{"foo":"bar","baz":42}');
    });
  });

  describe("render audit regression — no raw 10+ digit numbers", () => {
    it("formats 15B without raw digits (Meta AI infra-investment)", () => {
      const fact = makeFact("infrastructure-investment", { type: "number", value: 15_000_000_000 });
      const result = formatKBFactValue(fact, "USD");
      expect(result).toBe("$15 billion");
      expect(result).not.toMatch(/\d{10,}/);
    });

    it("formats 13.5B without raw digits", () => {
      const fact = makeFact("infrastructure-investment", { type: "number", value: 13_500_000_000 });
      const result = formatKBFactValue(fact, "USD");
      expect(result).toBe("$13.5 billion");
      expect(result).not.toMatch(/\d{10,}/);
    });

    it("formats 380B without raw digits (Anthropic valuation)", () => {
      const fact = makeFact("valuation", { type: "number", value: 380_000_000_000 });
      const result = formatKBFactValue(fact, "USD");
      expect(result).toBe("$380 billion");
      expect(result).not.toMatch(/\d{10,}/);
    });

    it("formats large number without unit and produces no raw digits", () => {
      const fact = makeFact("parent-revenue", { type: "number", value: 200_970_000_000 });
      const result = formatKBFactValue(fact);
      expect(result).not.toMatch(/\d{10,}/);
      expect(result).toContain("billion");
    });

    it("formats number with 'users' unit", () => {
      const fact = makeFact("user-count", { type: "number", value: 1_000_000_000 });
      const result = formatKBFactValue(fact, "users");
      expect(result).not.toMatch(/\d{10,}/);
      expect(result).toContain("billion");
    });
  });

  describe("existing value types are unaffected", () => {
    it("formats boolean facts", () => {
      const fact = makeFact("some-bool", { type: "boolean", value: true });
      expect(formatKBFactValue(fact)).toBe("Yes");
    });

    it("formats text facts", () => {
      const fact = makeFact("headquarters", { type: "text", value: "San Francisco, CA" });
      expect(formatKBFactValue(fact)).toBe("San Francisco, CA");
    });

    it("formats date facts", () => {
      const fact = makeFact("founded-date", { type: "date", value: "2021-01" });
      expect(formatKBFactValue(fact)).toBe("Jan 2021");
    });

    it("preserves year-like number values (no comma/B suffix added)", () => {
      const fact = makeFact("born-year", { type: "number", value: 1975 });
      expect(formatKBFactValue(fact, undefined, undefined)).toBe("1975");
    });

    it("formats small counts without unit as plain numbers", () => {
      const fact = makeFact("interpretability-team-size", { type: "number", value: 50 });
      expect(formatKBFactValue(fact, undefined, undefined)).toBe("50");
    });
  });
});
