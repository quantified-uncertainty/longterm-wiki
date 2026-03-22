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

describe("formatValue adaptive divisor ($0B bug fix)", () => {
  const revenueProperty: Property = {
    id: "revenue",
    name: "Revenue",
    dataType: "number",
    unit: "USD",
    display: { divisor: 1e9, prefix: "$", suffix: "B" },
  };

  it("falls back to M for values under $50M (would round to $0B)", () => {
    expect(formatValue(50_000_000, revenueProperty)).toBe("$50M");
    expect(formatValue(10_000_000, revenueProperty)).toBe("$10M");
    expect(formatValue(1_000_000, revenueProperty)).toBe("$1M");
  });

  it("falls back to K for very small values", () => {
    // 500K / 1e6 = 0.5 → "$0.5M" (M is sufficient)
    expect(formatValue(500_000, revenueProperty)).toBe("$0.5M");
    // 50K / 1e6 = 0.05 < 0.1 → falls through to K: 50K / 1e3 = 50 → "$50K"
    expect(formatValue(50_000, revenueProperty)).toBe("$50K");
  });

  it("falls back to raw value when all scales too large", () => {
    // 5 / 1e3 = 0.005 < 0.1 → all scales exhausted → raw value
    expect(formatValue(5, revenueProperty)).toBe("$5");
  });

  it("still uses B for values that display correctly", () => {
    expect(formatValue(1_000_000_000, revenueProperty)).toBe("$1B");
    expect(formatValue(10_000_000_000, revenueProperty)).toBe("$10B");
    expect(formatValue(500_000_000, revenueProperty)).toBe("$0.5B");
  });

  it("handles the boundary correctly (values < 0.1 after division fall back)", () => {
    // 49M / 1e9 = 0.049 < 0.1 → falls back to M
    expect(formatValue(49_000_000, revenueProperty)).toBe("$49M");
    // 50M / 1e9 = 0.05 < 0.1 → falls back to M
    expect(formatValue(50_000_000, revenueProperty)).toBe("$50M");
    // 99M / 1e9 = 0.099 < 0.1 → falls back to M
    expect(formatValue(99_000_000, revenueProperty)).toBe("$99M");
    // 100M / 1e9 = 0.1 → displays as $0.1B (at the threshold)
    expect(formatValue(100_000_000, revenueProperty)).toBe("$0.1B");
  });

  it("handles negative values with adaptive fallback", () => {
    expect(formatValue(-10_000_000, revenueProperty)).toBe("$-10M");
  });

  it("handles zero correctly (no fallback needed)", () => {
    expect(formatValue(0, revenueProperty)).toBe("$0B");
  });

  it("preserves currency override with adaptive fallback", () => {
    expect(formatValue(50_000_000, revenueProperty, "GBP")).toBe("£50M");
  });

  it("does not adapt non-scale suffixes", () => {
    const customProperty: Property = {
      id: "custom",
      name: "Custom",
      dataType: "number",
      display: { divisor: 1e9, prefix: "", suffix: " widgets" },
    };
    // Non-scale suffix: should NOT adapt, just display the divided value
    expect(formatValue(10_000_000, customProperty)).toBe("0 widgets");
  });
});
