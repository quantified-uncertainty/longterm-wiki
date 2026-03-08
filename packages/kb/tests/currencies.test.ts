import { describe, it, expect } from "vitest";
import { CURRENCIES, resolveCurrency, isCurrencyCode } from "../src/currencies";
import { formatMoney, formatValue } from "../src/format";
import type { Property } from "../src/types";

describe("currencies", () => {
  describe("CURRENCIES registry", () => {
    it("contains common currencies", () => {
      expect(CURRENCIES.USD).toBeDefined();
      expect(CURRENCIES.GBP).toBeDefined();
      expect(CURRENCIES.EUR).toBeDefined();
      expect(CURRENCIES.CAD).toBeDefined();
      expect(CURRENCIES.JPY).toBeDefined();
    });

    it("has correct symbols", () => {
      expect(CURRENCIES.USD.symbol).toBe("$");
      expect(CURRENCIES.GBP.symbol).toBe("£");
      expect(CURRENCIES.EUR.symbol).toBe("€");
      expect(CURRENCIES.CAD.symbol).toBe("C$");
      expect(CURRENCIES.JPY.symbol).toBe("¥");
    });
  });

  describe("resolveCurrency", () => {
    it("returns fact currency when valid", () => {
      expect(resolveCurrency("GBP", "USD")).toBe("GBP");
    });

    it("falls back to property unit when fact currency is absent", () => {
      expect(resolveCurrency(undefined, "USD")).toBe("USD");
    });

    it("defaults to USD when both are absent", () => {
      expect(resolveCurrency(undefined, undefined)).toBe("USD");
    });

    it("ignores unknown fact currency", () => {
      expect(resolveCurrency("FAKE", "USD")).toBe("USD");
    });

    it("ignores unknown property unit", () => {
      expect(resolveCurrency(undefined, "widgets")).toBe("USD");
    });
  });

  describe("isCurrencyCode", () => {
    it("returns true for known codes", () => {
      expect(isCurrencyCode("USD")).toBe(true);
      expect(isCurrencyCode("GBP")).toBe(true);
    });

    it("returns false for unknown codes", () => {
      expect(isCurrencyCode("FAKE")).toBe(false);
      expect(isCurrencyCode("percent")).toBe(false);
    });
  });
});

describe("formatMoney with currencies", () => {
  it("formats USD by default", () => {
    expect(formatMoney(1_500_000_000)).toBe("$1.5B");
    expect(formatMoney(100_000_000)).toBe("$100M");
    expect(formatMoney(5_000)).toBe("$5K");
  });

  it("formats GBP", () => {
    expect(formatMoney(100_000_000, "GBP")).toBe("£100M");
    expect(formatMoney(1_500_000_000, "GBP")).toBe("£1.5B");
  });

  it("formats EUR", () => {
    expect(formatMoney(50_000_000, "EUR")).toBe("€50M");
  });

  it("formats CAD", () => {
    expect(formatMoney(50_000_000, "CAD")).toBe("C$50M");
  });

  it("formats JPY", () => {
    expect(formatMoney(1_000_000_000_000, "JPY")).toBe("¥1.0T");
  });

  it("formats negative values", () => {
    expect(formatMoney(-5_000_000_000, "GBP")).toBe("-£5.0B");
  });

  it("falls back to USD for unknown currency", () => {
    expect(formatMoney(100_000_000, "FAKE")).toBe("$100M");
  });

  it("formats suffix currencies (SEK)", () => {
    expect(formatMoney(100_000_000, "SEK")).toBe("100M kr");
  });
});

describe("formatValue with currency override", () => {
  const revenueProperty: Property = {
    id: "revenue",
    name: "Revenue",
    dataType: "number",
    unit: "USD",
    display: { divisor: 1e9, prefix: "$", suffix: "B" },
  };

  it("uses property prefix when no currency override", () => {
    const result = formatValue(10_000_000_000, revenueProperty);
    expect(result).toBe("$10B");
  });

  it("uses GBP symbol when currency override is GBP", () => {
    const result = formatValue(10_000_000_000, revenueProperty, "GBP");
    expect(result).toBe("£10B");
  });

  it("uses EUR symbol when currency override is EUR", () => {
    const result = formatValue(10_000_000_000, revenueProperty, "EUR");
    expect(result).toBe("€10B");
  });

  it("preserves suffix from property display", () => {
    const result = formatValue(10_000_000_000, revenueProperty, "GBP");
    expect(result).toContain("B"); // suffix preserved
    expect(result).toContain("£"); // GBP prefix
  });

  it("does not override prefix for non-currency properties", () => {
    const percentProperty: Property = {
      id: "margin",
      name: "Margin",
      dataType: "number",
      unit: "percent",
      display: { suffix: "%" },
    };
    const result = formatValue(40, percentProperty, "GBP");
    // percent is not in CURRENCIES, so GBP override should not apply
    expect(result).toBe("40%");
  });
});
