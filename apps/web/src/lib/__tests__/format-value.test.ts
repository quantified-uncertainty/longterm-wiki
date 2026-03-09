import { describe, expect, it } from "vitest";

import {
  formatStructuredValue,
  formatValue,
  formatValueRange,
} from "../format-value";

describe("formatValue", () => {
  describe("USD (prefix currency)", () => {
    it("formats sub-million values with $ prefix", () => {
      expect(formatValue(500, "USD")).toBe("$500");
    });

    it("formats thousands with comma separator", () => {
      expect(formatValue(1500, "USD")).toBe("$1,500");
    });

    it("formats millions", () => {
      expect(formatValue(2.5e6, "USD")).toBe("$2.5 million");
    });

    it("formats billions", () => {
      expect(formatValue(30e9, "USD")).toBe("$30 billion");
    });

    it("formats trillions", () => {
      expect(formatValue(1.5e12, "USD")).toBe("$1.5 trillion");
    });

    it("formats zero", () => {
      expect(formatValue(0, "USD")).toBe("$0");
    });

    it("cleans trailing .0 from round numbers", () => {
      expect(formatValue(380e9, "USD")).toBe("$380 billion");
      expect(formatValue(100e6, "USD")).toBe("$100 million");
      expect(formatValue(1e12, "USD")).toBe("$1 trillion");
    });

    it("preserves meaningful decimals", () => {
      expect(formatValue(2.5e9, "USD")).toBe("$2.5 billion");
      expect(formatValue(1.5e12, "USD")).toBe("$1.5 trillion");
      expect(formatValue(3.7e6, "USD")).toBe("$3.7 million");
    });
  });

  describe("negative values with prefix currency", () => {
    it("places negative sign before the currency symbol", () => {
      expect(formatValue(-850e6, "USD")).toBe("-$850 million");
    });

    it("handles negative billions", () => {
      expect(formatValue(-30e9, "USD")).toBe("-$30 billion");
    });

    it("handles negative trillions", () => {
      expect(formatValue(-1.5e12, "USD")).toBe("-$1.5 trillion");
    });

    it("handles negative sub-million values", () => {
      expect(formatValue(-500, "USD")).toBe("-$500");
    });
  });

  describe("boundary values at magnitude thresholds", () => {
    it("formats exactly 1e6 as million", () => {
      expect(formatValue(1e6, "USD")).toBe("$1 million");
    });

    it("formats exactly 1e9 as billion", () => {
      expect(formatValue(1e9, "USD")).toBe("$1 billion");
    });

    it("formats exactly 1e12 as trillion", () => {
      expect(formatValue(1e12, "USD")).toBe("$1 trillion");
    });

    it("formats just below 1e6 as a plain number", () => {
      expect(formatValue(999999, "USD")).toBe("$999,999");
    });
  });

  describe("suffix currencies (SEK, NOK)", () => {
    it("formats SEK with suffix kr", () => {
      expect(formatValue(100e6, "SEK")).toBe("100 million kr");
    });

    it("formats SEK billions with suffix kr", () => {
      expect(formatValue(5e9, "SEK")).toBe("5 billion kr");
    });

    it("formats SEK trillions with suffix kr", () => {
      expect(formatValue(2e12, "SEK")).toBe("2 trillion kr");
    });

    it("formats NOK sub-million with suffix kr", () => {
      expect(formatValue(5000, "NOK")).toBe("5,000 kr");
    });

    it("places negative sign correctly for suffix currencies", () => {
      expect(formatValue(-100e6, "SEK")).toBe("-100 million kr");
    });
  });

  describe("other prefix currencies", () => {
    it("formats GBP with pound sign", () => {
      expect(formatValue(100e6, "GBP")).toBe("\u00A3100 million");
    });

    it("formats EUR with euro sign", () => {
      expect(formatValue(50e9, "EUR")).toBe("\u20AC50 billion");
    });

    it("formats JPY with yen sign", () => {
      expect(formatValue(1e12, "JPY")).toBe("\u00A51 trillion");
    });

    it("formats CAD with C$ prefix", () => {
      expect(formatValue(200e6, "CAD")).toBe("C$200 million");
    });
  });

  describe("percent unit", () => {
    it("formats whole numbers", () => {
      expect(formatValue(40, "percent")).toBe("40%");
    });

    it("formats decimal percentages", () => {
      expect(formatValue(99.9, "percent")).toBe("99.9%");
    });

    it("formats 100%", () => {
      expect(formatValue(100, "percent")).toBe("100%");
    });

    it("formats 0%", () => {
      expect(formatValue(0, "percent")).toBe("0%");
    });
  });

  describe("count and tokens units", () => {
    it("formats count with comma separator", () => {
      expect(formatValue(1500, "count")).toBe("1,500");
    });

    it("formats count millions", () => {
      expect(formatValue(2.5e6, "count")).toBe("2.5 million");
    });

    it("formats count billions", () => {
      expect(formatValue(2.5e9, "count")).toBe("2.5 billion");
    });

    it("formats count trillions", () => {
      expect(formatValue(1e12, "count")).toBe("1 trillion");
    });

    it("formats tokens the same as count", () => {
      expect(formatValue(200000, "tokens")).toBe("200,000");
      expect(formatValue(1e9, "tokens")).toBe("1 billion");
    });
  });

  describe("currency override parameter", () => {
    it("overrides unit currency with explicit currency", () => {
      expect(formatValue(100e6, "USD", "GBP")).toBe("\u00A3100 million");
    });

    it("does not apply currency override when unit is percent", () => {
      expect(formatValue(40, "percent", "GBP")).toBe("40%");
    });

    it("does not apply currency override when unit is count", () => {
      expect(formatValue(1500, "count", "GBP")).toBe("1,500");
    });

    it("applies currency override when unit is also a currency", () => {
      expect(formatValue(50e6, "USD", "EUR")).toBe("\u20AC50 million");
    });
  });

  describe("fallback (no unit or unknown unit)", () => {
    it("formats with no unit", () => {
      expect(formatValue(1500)).toBe("1,500");
    });

    it("formats millions with no unit", () => {
      expect(formatValue(5e6)).toBe("5 million");
    });

    it("formats billions with no unit", () => {
      expect(formatValue(3e9)).toBe("3 billion");
    });

    it("formats trillions with no unit", () => {
      expect(formatValue(2e12)).toBe("2 trillion");
    });

    it("handles null unit", () => {
      expect(formatValue(1000, null)).toBe("1,000");
    });

    it("handles undefined unit", () => {
      expect(formatValue(1000, undefined)).toBe("1,000");
    });
  });
});

describe("formatValueRange", () => {
  describe("USD range (prefix currency)", () => {
    it("formats billion range", () => {
      expect(formatValueRange(20e9, 26e9, "USD")).toBe("$20-$26 billion");
    });

    it("formats million range", () => {
      expect(formatValueRange(20e6, 30e6, "USD")).toBe("$20-$30 million");
    });

    it("formats sub-million range", () => {
      expect(formatValueRange(1500, 3000, "USD")).toBe("$1,500-$3,000");
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
      expect(formatValueRange(20e9, 26e9, "SEK")).toBe("20-26 billion kr");
    });

    it("formats million range with suffix", () => {
      expect(formatValueRange(20e6, 30e6, "SEK")).toBe("20-30 million kr");
    });

    it("formats sub-million range with suffix", () => {
      expect(formatValueRange(1500, 3000, "SEK")).toBe("1,500-3,000 kr");
    });
  });

  describe("currency override in range", () => {
    it("overrides unit currency with explicit currency", () => {
      expect(formatValueRange(20e6, 30e6, "USD", "GBP")).toBe(
        "\u00A320-\u00A330 million"
      );
    });
  });

  describe("count/tokens range", () => {
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
      expect(formatStructuredValue("850000000", "USD")).toBe("$850 million");
    });

    it("parses and formats a small number", () => {
      expect(formatStructuredValue("1500", "count")).toBe("1,500");
    });

    it("parses and formats zero", () => {
      expect(formatStructuredValue("0", "USD")).toBe("$0");
    });

    it("parses negative numbers", () => {
      expect(formatStructuredValue("-500000000", "USD")).toBe("-$500 million");
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
