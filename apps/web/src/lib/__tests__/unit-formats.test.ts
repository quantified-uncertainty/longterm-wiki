import { describe, it, expect } from "vitest";
import { UNIT_FORMATS, formatWithUnitFormat } from "../unit-formats";

describe("UNIT_FORMATS", () => {
  it("defines all expected format IDs", () => {
    const ids = Object.keys(UNIT_FORMATS);
    expect(ids).toContain("usd-billions");
    expect(ids).toContain("usd-millions");
    expect(ids).toContain("percent");
    expect(ids).toContain("count");
    expect(ids).toContain("tokens");
    expect(ids).toContain("fte");
    expect(ids).toContain("flop");
  });

  it("each format has consistent id field", () => {
    for (const [key, fmt] of Object.entries(UNIT_FORMATS)) {
      expect(fmt.id).toBe(key);
    }
  });
});

describe("formatWithUnitFormat", () => {
  it("formats USD billions", () => {
    expect(formatWithUnitFormat(380_000_000_000, "usd-billions")).toBe("$380B");
    expect(formatWithUnitFormat(14_000_000_000, "usd-billions")).toBe("$14B");
    expect(formatWithUnitFormat(1_500_000_000, "usd-billions")).toBe("$1.5B");
  });

  it("formats USD millions", () => {
    expect(formatWithUnitFormat(2_500_000, "usd-millions")).toBe("$2.5M");
    expect(formatWithUnitFormat(100_000_000, "usd-millions")).toBe("$100M");
  });

  it("formats percentages", () => {
    expect(formatWithUnitFormat(40, "percent")).toBe("40%");
    expect(formatWithUnitFormat(88.5, "percent")).toBe("88.5%");
    expect(formatWithUnitFormat(0, "percent")).toBe("0%");
  });

  it("formats counts (no suffix)", () => {
    expect(formatWithUnitFormat(1200, "count")).toBe("1,200");
    expect(formatWithUnitFormat(0, "count")).toBe("0");
  });

  it("formats tokens", () => {
    expect(formatWithUnitFormat(200000, "tokens")).toBe("200,000 tokens");
  });

  it("formats FTE", () => {
    expect(formatWithUnitFormat(50, "fte")).toBe("50 FTE");
  });

  it("formats FLOP", () => {
    expect(formatWithUnitFormat(1e18, "flop")).toBe(
      `${(1e18).toLocaleString("en-US")} FLOP`
    );
  });

  it("falls back to locale string for null formatId", () => {
    expect(formatWithUnitFormat(1234567, null)).toBe("1,234,567");
  });

  it("falls back to locale string for undefined formatId", () => {
    expect(formatWithUnitFormat(1234567, undefined)).toBe("1,234,567");
  });

  it("falls back to locale string for unknown formatId", () => {
    expect(formatWithUnitFormat(1234567, "unknown-format")).toBe("1,234,567");
  });

  it("handles zero", () => {
    expect(formatWithUnitFormat(0, "usd-billions")).toBe("$0B");
    expect(formatWithUnitFormat(0, null)).toBe("0");
  });

  it("handles negative values", () => {
    expect(formatWithUnitFormat(-2_800_000_000, "usd-billions")).toBe("-$2.8B");
  });
});
