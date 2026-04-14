import { describe, it, expect } from "vitest";
import { formatMoney } from "../routes/shared/format-money.js";

describe("formatMoney", () => {
  it("formats USD by default", () => {
    expect(formatMoney(1_234_567)).toBe("$1,234,567");
  });

  it("formats explicit USD with $ symbol", () => {
    expect(formatMoney(1_500_000, "USD")).toBe("$1,500,000");
  });

  it("formats EUR with € symbol", () => {
    expect(formatMoney(2_000_000, "EUR")).toBe("€2,000,000");
  });

  it("formats GBP with £ symbol", () => {
    expect(formatMoney(750_000, "GBP")).toBe("£750,000");
  });

  it("formats CNY with ¥ or CN¥ symbol", () => {
    const result = formatMoney(10_000_000, "CNY");
    // Different ICU builds render CNY as either "¥" or "CN¥" — accept either.
    expect(result).toMatch(/(?:CN)?¥10,000,000/);
  });

  it("strips fractional digits for round amounts", () => {
    expect(formatMoney(1_000_000.5, "USD")).toBe("$1,000,001");
  });

  it("accepts string amounts", () => {
    expect(formatMoney("500000", "USD")).toBe("$500,000");
  });

  it("handles zero", () => {
    expect(formatMoney(0, "USD")).toBe("$0");
  });

  it("handles negative amounts", () => {
    expect(formatMoney(-1_000, "USD")).toBe("-$1,000");
  });

  it("defaults null currency to USD", () => {
    expect(formatMoney(1_000, null)).toBe("$1,000");
  });

  it("defaults undefined currency to USD", () => {
    expect(formatMoney(1_000, undefined)).toBe("$1,000");
  });

  it("defaults empty-string currency to USD", () => {
    expect(formatMoney(1_000, "  ")).toBe("$1,000");
  });

  it("falls back to code prefix for unknown currency code", () => {
    // ZZZ is reserved as 'no currency' in ISO 4217; Intl may accept or reject.
    const result = formatMoney(1_234, "XYZ");
    // Either Intl rendered it (as "XYZ 1,234") or our fallback did.
    expect(result).toMatch(/XYZ\s?1,234/);
  });

  it("returns String(amount) for non-finite input", () => {
    expect(formatMoney(NaN)).toBe("NaN");
    expect(formatMoney(Infinity)).toBe("Infinity");
  });
});
