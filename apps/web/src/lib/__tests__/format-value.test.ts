import { describe, expect, it } from "vitest";

import {
  formatStructuredValue,
  formatNumberWithUnit,
  formatValueRange,
} from "../format-value";

describe("formatNumberWithUnit", () => {
  describe("USD (prefix currency)", () => {
    it("formats sub-thousand values with $ prefix and locale grouping", () => {
      expect(formatNumberWithUnit(500, "USD")).toBe("$500");
    });

    it("formats thousands with K suffix", () => {
      // $22,060 on Redwood Research's profile triggered QUA-681 — must render as $22K.
      expect(formatNumberWithUnit(22060, "USD")).toBe("$22K");
      expect(formatNumberWithUnit(1500, "USD")).toBe("$1.5K");
    });

    it("formats millions with M suffix", () => {
      expect(formatNumberWithUnit(2.5e6, "USD")).toBe("$2.5M");
    });

    it("formats billions with B suffix", () => {
      expect(formatNumberWithUnit(30e9, "USD")).toBe("$30B");
    });

    it("formats trillions with T suffix", () => {
      expect(formatNumberWithUnit(1.5e12, "USD")).toBe("$1.5T");
    });

    it("formats zero", () => {
      expect(formatNumberWithUnit(0, "USD")).toBe("$0");
    });

    it("drops trailing .0 from round numbers", () => {
      expect(formatNumberWithUnit(380e9, "USD")).toBe("$380B");
      expect(formatNumberWithUnit(100e6, "USD")).toBe("$100M");
      expect(formatNumberWithUnit(1e12, "USD")).toBe("$1T");
    });

    it("preserves meaningful decimals below 10 of a unit", () => {
      expect(formatNumberWithUnit(2.5e9, "USD")).toBe("$2.5B");
      expect(formatNumberWithUnit(1.5e12, "USD")).toBe("$1.5T");
      expect(formatNumberWithUnit(3.7e6, "USD")).toBe("$3.7M");
    });

    it("drops decimals at or above 10 of a unit", () => {
      expect(formatNumberWithUnit(19e9, "USD")).toBe("$19B");
      expect(formatNumberWithUnit(380e9, "USD")).toBe("$380B");
    });
  });

  describe("negative values with prefix currency", () => {
    it("places negative sign before the currency symbol", () => {
      expect(formatNumberWithUnit(-850e6, "USD")).toBe("-$850M");
    });

    it("handles negative billions", () => {
      expect(formatNumberWithUnit(-30e9, "USD")).toBe("-$30B");
    });

    it("handles negative trillions", () => {
      expect(formatNumberWithUnit(-1.5e12, "USD")).toBe("-$1.5T");
    });

    it("handles negative sub-thousand values", () => {
      expect(formatNumberWithUnit(-500, "USD")).toBe("-$500");
    });
  });

  describe("boundary values at magnitude thresholds", () => {
    it("formats exactly 1e6 as $1M", () => {
      expect(formatNumberWithUnit(1e6, "USD")).toBe("$1M");
    });

    it("formats exactly 1e9 as $1B", () => {
      expect(formatNumberWithUnit(1e9, "USD")).toBe("$1B");
    });

    it("formats exactly 1e12 as $1T", () => {
      expect(formatNumberWithUnit(1e12, "USD")).toBe("$1T");
    });

    it("promotes 999,999 up to $1M instead of rendering $1000K", () => {
      expect(formatNumberWithUnit(999999, "USD")).toBe("$1M");
    });

    it("still renders values that stay under 1000 of a unit", () => {
      expect(formatNumberWithUnit(950000, "USD")).toBe("$950K");
      expect(formatNumberWithUnit(950e6, "USD")).toBe("$950M");
      expect(formatNumberWithUnit(950e9, "USD")).toBe("$950B");
    });
  });

  describe("suffix currencies (SEK, NOK)", () => {
    it("formats SEK with suffix kr", () => {
      expect(formatNumberWithUnit(100e6, "SEK")).toBe("100M kr");
    });

    it("formats SEK billions with suffix kr", () => {
      expect(formatNumberWithUnit(5e9, "SEK")).toBe("5B kr");
    });

    it("formats SEK trillions with suffix kr", () => {
      expect(formatNumberWithUnit(2e12, "SEK")).toBe("2T kr");
    });

    it("formats NOK sub-million with suffix kr", () => {
      expect(formatNumberWithUnit(5000, "NOK")).toBe("5K kr");
    });

    it("places negative sign correctly for suffix currencies", () => {
      expect(formatNumberWithUnit(-100e6, "SEK")).toBe("-100M kr");
    });
  });

  describe("other prefix currencies", () => {
    it("formats GBP with pound sign", () => {
      expect(formatNumberWithUnit(100e6, "GBP")).toBe("\u00A3100M");
    });

    it("formats EUR with euro sign", () => {
      expect(formatNumberWithUnit(50e9, "EUR")).toBe("\u20AC50B");
    });

    it("formats JPY with yen sign", () => {
      expect(formatNumberWithUnit(1e12, "JPY")).toBe("\u00A51T");
    });

    it("formats CAD with C$ prefix", () => {
      expect(formatNumberWithUnit(200e6, "CAD")).toBe("C$200M");
    });
  });

  describe("percent unit", () => {
    it("formats whole numbers", () => {
      expect(formatNumberWithUnit(40, "percent")).toBe("40%");
    });

    it("formats decimal percentages", () => {
      expect(formatNumberWithUnit(99.9, "percent")).toBe("99.9%");
    });

    it("formats 100%", () => {
      expect(formatNumberWithUnit(100, "percent")).toBe("100%");
    });

    it("formats 0%", () => {
      expect(formatNumberWithUnit(0, "percent")).toBe("0%");
    });
  });

  describe("count and tokens units (long-form unchanged)", () => {
    it("formats count with comma separator", () => {
      expect(formatNumberWithUnit(1500, "count")).toBe("1,500");
    });

    it("formats count millions in long form", () => {
      expect(formatNumberWithUnit(2.5e6, "count")).toBe("2.5 million");
    });

    it("formats count billions in long form", () => {
      expect(formatNumberWithUnit(2.5e9, "count")).toBe("2.5 billion");
    });

    it("formats count trillions in long form", () => {
      expect(formatNumberWithUnit(1e12, "count")).toBe("1 trillion");
    });

    it("formats tokens the same as count", () => {
      expect(formatNumberWithUnit(200000, "tokens")).toBe("200,000");
      expect(formatNumberWithUnit(1e9, "tokens")).toBe("1 billion");
    });
  });

  describe("currency override parameter", () => {
    it("overrides unit currency with explicit currency", () => {
      expect(formatNumberWithUnit(100e6, "USD", "GBP")).toBe("\u00A3100M");
    });

    it("does not apply currency override when unit is percent", () => {
      expect(formatNumberWithUnit(40, "percent", "GBP")).toBe("40%");
    });

    it("does not apply currency override when unit is count", () => {
      expect(formatNumberWithUnit(1500, "count", "GBP")).toBe("1,500");
    });

    it("applies currency override when unit is also a currency", () => {
      expect(formatNumberWithUnit(50e6, "USD", "EUR")).toBe("\u20AC50M");
    });
  });

  describe("fallback (no unit or unknown unit)", () => {
    it("formats with no unit (long form unchanged)", () => {
      expect(formatNumberWithUnit(1500)).toBe("1,500");
    });

    it("formats millions with no unit in long form", () => {
      expect(formatNumberWithUnit(5e6)).toBe("5 million");
    });

    it("formats billions with no unit in long form", () => {
      expect(formatNumberWithUnit(3e9)).toBe("3 billion");
    });

    it("formats trillions with no unit in long form", () => {
      expect(formatNumberWithUnit(2e12)).toBe("2 trillion");
    });

    it("handles null unit", () => {
      expect(formatNumberWithUnit(1000, null)).toBe("1,000");
    });

    it("handles undefined unit", () => {
      expect(formatNumberWithUnit(1000, undefined)).toBe("1,000");
    });

    it("uses scientific notation for very large numbers (>= 1e15)", () => {
      expect(formatNumberWithUnit(1e26, "FLOP")).toBe("10^26");
    });

    it("includes mantissa when not exactly 1", () => {
      expect(formatNumberWithUnit(2.5e20)).toBe("2.5 × 10^20");
    });

    it("omits mantissa when approximately 1", () => {
      expect(formatNumberWithUnit(1e18)).toBe("10^18");
    });
  });
});

describe("formatValueRange", () => {
  describe("USD range (prefix currency)", () => {
    it("formats billion range", () => {
      expect(formatValueRange(20e9, 26e9, "USD")).toBe("$20B-$26B");
    });

    it("formats million range", () => {
      expect(formatValueRange(20e6, 30e6, "USD")).toBe("$20M-$30M");
    });

    it("formats sub-thousand range", () => {
      expect(formatValueRange(500, 900, "USD")).toBe("$500-$900");
    });

    it("formats thousand range", () => {
      expect(formatValueRange(1500, 3000, "USD")).toBe("$1.5K-$3K");
    });
  });

  describe("percent range", () => {
    it("formats integer percent range", () => {
      expect(formatValueRange(20, 30, "percent")).toBe("20-30%");
    });

    it("formats decimal percent range", () => {
      expect(formatValueRange(10.5, 20.5, "percent")).toBe("10.5-20.5%");
    });

    it("cleans .0 from round percent values", () => {
      expect(formatValueRange(10, 20, "percent")).toBe("10-20%");
    });
  });

  describe("suffix currency range (SEK)", () => {
    it("formats billion range with suffix", () => {
      expect(formatValueRange(20e9, 26e9, "SEK")).toBe("20B kr-26B kr");
    });

    it("formats million range with suffix", () => {
      expect(formatValueRange(20e6, 30e6, "SEK")).toBe("20M kr-30M kr");
    });

    it("formats sub-thousand range with suffix", () => {
      expect(formatValueRange(500, 900, "SEK")).toBe("500 kr-900 kr");
    });
  });

  describe("currency override in range", () => {
    it("overrides unit currency with explicit currency", () => {
      expect(formatValueRange(20e6, 30e6, "USD", "GBP")).toBe(
        "\u00A320M-\u00A330M"
      );
    });
  });

  describe("count/tokens range (long-form unchanged)", () => {
    it("formats million range for count", () => {
      expect(formatValueRange(20e6, 30e6, "count")).toBe("20-30 million");
    });

    it("formats sub-million range for count", () => {
      expect(formatValueRange(1500, 3000, "count")).toBe("1,500-3,000");
    });
  });

  describe("fallback (no unit)", () => {
    it("formats plain number range", () => {
      expect(formatValueRange(1500, 3000)).toBe("1,500-3,000");
    });
  });
});

describe("formatStructuredValue", () => {
  describe("numeric strings", () => {
    it("parses and formats a numeric string with USD unit", () => {
      expect(formatStructuredValue("850000000", "USD")).toBe("$850M");
    });

    it("parses and formats a small number", () => {
      expect(formatStructuredValue("1500", "count")).toBe("1,500");
    });

    it("parses and formats zero", () => {
      expect(formatStructuredValue("0", "USD")).toBe("$0");
    });

    it("parses negative numbers", () => {
      expect(formatStructuredValue("-500000000", "USD")).toBe("-$500M");
    });

    it("parses decimal strings", () => {
      expect(formatStructuredValue("42.5", "percent")).toBe("42.5%");
    });
  });

  describe("non-numeric strings", () => {
    it("returns text as-is with null unit", () => {
      expect(formatStructuredValue("San Francisco", null)).toBe(
        "San Francisco"
      );
    });

    it("returns text as-is with a currency unit", () => {
      expect(formatStructuredValue("Unknown", "USD")).toBe("Unknown");
    });
  });

  describe("edge cases", () => {
    it("returns whitespace as-is", () => {
      expect(formatStructuredValue("  ", null)).toBe("  ");
    });

    it("treats empty string as non-numeric (trim check)", () => {
      // Number("") === 0 but trim() === "" so it should return as-is
      expect(formatStructuredValue("", null)).toBe("");
    });

    it("treats NaN string as non-numeric", () => {
      expect(formatStructuredValue("NaN", null)).toBe("NaN");
    });

    it("treats Infinity as non-numeric (not finite)", () => {
      expect(formatStructuredValue("Infinity", null)).toBe("Infinity");
    });

    it("treats -Infinity as non-numeric (not finite)", () => {
      expect(formatStructuredValue("-Infinity", null)).toBe("-Infinity");
    });
  });
});
