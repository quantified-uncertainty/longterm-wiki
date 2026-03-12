import { describe, it, expect } from "vitest";
import {
  convertToUSD,
  formatAmount,
  isSupportedCurrency,
  getRate,
} from "../currency.ts";

describe("isSupportedCurrency", () => {
  it("returns true for all supported currencies", () => {
    for (const code of ["USD", "GBP", "EUR", "CHF", "CAD", "AUD", "SEK", "NOK", "DKK"]) {
      expect(isSupportedCurrency(code)).toBe(true);
    }
  });

  it("returns false for unsupported currencies", () => {
    expect(isSupportedCurrency("JPY")).toBe(false);
    expect(isSupportedCurrency("BTC")).toBe(false);
    expect(isSupportedCurrency("")).toBe(false);
  });
});

describe("convertToUSD", () => {
  it("returns the same amount for USD", () => {
    expect(convertToUSD(1000, "USD")).toBe(1000);
  });

  it("converts GBP to USD", () => {
    const result = convertToUSD(1000, "GBP");
    expect(result).toBe(1270); // 1000 * 1.27
  });

  it("converts EUR to USD", () => {
    const result = convertToUSD(1000, "EUR");
    expect(result).toBe(1080); // 1000 * 1.08
  });

  it("converts CHF to USD", () => {
    const result = convertToUSD(1000, "CHF");
    expect(result).toBe(1130); // 1000 * 1.13
  });

  it("converts SEK to USD", () => {
    const result = convertToUSD(10000, "SEK");
    expect(result).toBe(960); // 10000 * 0.096
  });

  it("handles zero amount", () => {
    expect(convertToUSD(0, "GBP")).toBe(0);
  });

  it("handles negative amounts", () => {
    expect(convertToUSD(-100, "GBP")).toBe(-127);
  });

  it("rounds to 2 decimal places", () => {
    // 333 * 1.27 = 422.91
    expect(convertToUSD(333, "GBP")).toBe(422.91);
  });

  it("throws for unsupported currency", () => {
    expect(() => convertToUSD(1000, "JPY")).toThrow("Unsupported currency: JPY");
  });
});

describe("formatAmount", () => {
  it("formats millions with USD", () => {
    expect(formatAmount(1_200_000, "USD")).toBe("$1.2M");
    expect(formatAmount(5_000_000, "USD")).toBe("$5M");
  });

  it("formats thousands with USD", () => {
    expect(formatAmount(500_000, "USD")).toBe("$500K");
    expect(formatAmount(25_000, "USD")).toBe("$25K");
    expect(formatAmount(10_000, "USD")).toBe("$10K");
  });

  it("formats small amounts with USD", () => {
    expect(formatAmount(1_500, "USD")).toBe("$1,500");
    expect(formatAmount(500, "USD")).toBe("$500");
  });

  it("formats GBP with pound sign", () => {
    expect(formatAmount(500_000, "GBP")).toBe("\u00a3500K");
    expect(formatAmount(1_000_000, "GBP")).toBe("\u00a31M");
  });

  it("formats EUR with euro sign", () => {
    expect(formatAmount(300_000, "EUR")).toBe("\u20ac300K");
  });

  it("formats CHF with prefix", () => {
    expect(formatAmount(100_000, "CHF")).toBe("CHF\u00a0100K");
  });

  it("re-buckets to M when K rounds up to 1000", () => {
    expect(formatAmount(999_950, "USD")).toBe("$1M");
    expect(formatAmount(999_500, "USD")).toBe("$999.5K");
  });

  it("handles negative amounts", () => {
    expect(formatAmount(-1_500_000, "USD")).toBe("-$1.5M");
    expect(formatAmount(-50_000, "USD")).toBe("-$50K");
  });

  it("uses currency code for unknown currencies", () => {
    expect(formatAmount(100_000, "JPY")).toBe("JPY\u00a0100K");
  });

  it("formats zero", () => {
    expect(formatAmount(0, "USD")).toBe("$0");
  });
});

describe("getRate", () => {
  it("returns 1 for USD", () => {
    expect(getRate("USD")).toBe(1.0);
  });

  it("returns rate for supported currencies", () => {
    expect(getRate("GBP")).toBe(1.27);
    expect(getRate("EUR")).toBe(1.08);
  });

  it("returns null for unsupported currencies", () => {
    expect(getRate("JPY")).toBeNull();
    expect(getRate("")).toBeNull();
  });
});
