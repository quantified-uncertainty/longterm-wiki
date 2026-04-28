import { describe, expect, it } from "vitest";
import {
  formatCompactCurrency,
  formatCompactNumber,
  formatDateShapedInteger,
  formatIntroducedDate,
  sanitizeRawLargeNumbers,
} from "../format-compact";

describe("formatCompactCurrency", () => {
  it("formats trillions", () => {
    expect(formatCompactCurrency(1.5e12)).toBe("$1.5T");
  });

  it("formats billions", () => {
    expect(formatCompactCurrency(2.3e9)).toBe("$2.3B");
  });

  it("formats millions", () => {
    expect(formatCompactCurrency(850e6)).toBe("$850M");
  });

  it("formats large thousands (>= 10K) with 0 decimal", () => {
    expect(formatCompactCurrency(42000)).toBe("$42K");
  });

  it("formats small thousands (< 10K) with 1 decimal", () => {
    expect(formatCompactCurrency(4100)).toBe("$4.1K");
    expect(formatCompactCurrency(1500)).toBe("$1.5K");
  });

  it("drops trailing .0 for even thousands", () => {
    expect(formatCompactCurrency(4000)).toBe("$4K");
  });

  it("formats small numbers", () => {
    expect(formatCompactCurrency(500)).toBe("$500");
  });

  it("returns empty for null/undefined/NaN", () => {
    expect(formatCompactCurrency(null)).toBe("");
    expect(formatCompactCurrency(undefined)).toBe("");
    expect(formatCompactCurrency(NaN)).toBe("");
    expect(formatCompactCurrency(Infinity)).toBe("");
  });

  it("uses GBP symbol for GBP currency", () => {
    expect(formatCompactCurrency(5e6, "GBP")).toBe("£5M");
  });

  it("uses EUR symbol for EUR currency", () => {
    expect(formatCompactCurrency(1.2e9, "EUR")).toBe("€1.2B");
  });

  it("uses CHF prefix for CHF currency", () => {
    expect(formatCompactCurrency(500000, "CHF")).toBe("CHF\u00A0500K");
  });

  it("falls back to currency code for unknown currencies", () => {
    expect(formatCompactCurrency(1e6, "SEK")).toBe("SEK\u00A01M");
  });

  it("treats empty string currency as USD", () => {
    expect(formatCompactCurrency(1e6, "")).toBe("$1M");
  });

  it("defaults to USD when no currency provided", () => {
    expect(formatCompactCurrency(1e6)).toBe("$1M");
  });

  it("handles negative values", () => {
    expect(formatCompactCurrency(-5e6)).toBe("$-5M");
  });
});

describe("formatCompactNumber", () => {
  it("returns empty for null/undefined/NaN", () => {
    expect(formatCompactNumber(null)).toBe("");
    expect(formatCompactNumber(undefined)).toBe("");
    expect(formatCompactNumber(NaN)).toBe("");
  });

  it("formats billions", () => {
    expect(formatCompactNumber(2_300_000_000)).toBe("2.3B");
  });

  it("formats millions", () => {
    expect(formatCompactNumber(850_000_000)).toBe("850M");
  });

  it("formats small thousands (< 10K) with 1 decimal for headcount precision", () => {
    expect(formatCompactNumber(4074)).toBe("4.1K");
    expect(formatCompactNumber(1500)).toBe("1.5K");
    expect(formatCompactNumber(7800)).toBe("7.8K");
  });

  it("formats large thousands (>= 10K) with 0 decimal", () => {
    expect(formatCompactNumber(42000)).toBe("42K");
  });

  it("drops trailing .0 for even thousands", () => {
    expect(formatCompactNumber(4000)).toBe("4K");
  });

  it("formats small numbers with locale separator", () => {
    expect(formatCompactNumber(500)).toBe("500");
  });

  it("has no currency symbol", () => {
    expect(formatCompactNumber(1_000_000)).not.toContain("$");
  });
});

describe("formatIntroducedDate", () => {
  describe("year-only format", () => {
    it("returns year as-is for 4-digit year", () => {
      expect(formatIntroducedDate("2021")).toBe("2021");
    });

    it("returns year as-is for recent year", () => {
      expect(formatIntroducedDate("2024")).toBe("2024");
    });

    it("returns year as-is for older year", () => {
      expect(formatIntroducedDate("2019")).toBe("2019");
    });
  });

  describe("year-month format", () => {
    it("formats YYYY-MM as Mon YYYY", () => {
      expect(formatIntroducedDate("2021-04")).toBe("Apr 2021");
    });

    it("formats January correctly", () => {
      expect(formatIntroducedDate("2023-01")).toBe("Jan 2023");
    });

    it("formats December correctly", () => {
      expect(formatIntroducedDate("2024-12")).toBe("Dec 2024");
    });

    it("formats November correctly", () => {
      expect(formatIntroducedDate("2023-11")).toBe("Nov 2023");
    });

    it("formats February correctly", () => {
      expect(formatIntroducedDate("2024-02")).toBe("Feb 2024");
    });

    it("formats May correctly", () => {
      expect(formatIntroducedDate("2024-05")).toBe("May 2024");
    });
  });

  describe("full ISO date format", () => {
    it("formats YYYY-MM-DD as Mon DD, YYYY", () => {
      expect(formatIntroducedDate("2022-06-16")).toBe("Jun 16, 2022");
    });

    it("formats November 1 correctly", () => {
      expect(formatIntroducedDate("2023-11-01")).toBe("Nov 1, 2023");
    });

    it("formats October 30 correctly", () => {
      expect(formatIntroducedDate("2023-10-30")).toBe("Oct 30, 2023");
    });

    it("formats a May date correctly", () => {
      expect(formatIntroducedDate("2024-05-22")).toBe("May 22, 2024");
    });

    it("formats a January date correctly", () => {
      expect(formatIntroducedDate("2023-01-01")).toBe("Jan 1, 2023");
    });
  });

  describe("null and undefined handling", () => {
    it("returns null for null input", () => {
      expect(formatIntroducedDate(null)).toBeNull();
    });

    it("returns null for undefined input", () => {
      expect(formatIntroducedDate(undefined)).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(formatIntroducedDate("")).toBeNull();
    });
  });

  describe("invalid / unknown formats", () => {
    it("returns the raw value for prose text", () => {
      expect(formatIntroducedDate("UK (2023), US (2024), others planned")).toBe(
        "UK (2023), US (2024), others planned"
      );
    });

    it("returns the raw value for unrecognized patterns", () => {
      expect(formatIntroducedDate("unknown")).toBe("unknown");
    });

    it("trims whitespace from the value", () => {
      expect(formatIntroducedDate("  2021  ")).toBe("2021");
    });

    it("returns raw value for out-of-range month in YYYY-MM", () => {
      // Month 13 is invalid — fall through to unknown-format branch
      expect(formatIntroducedDate("2021-13")).toBe("2021-13");
    });

    it("returns raw value for out-of-range day in YYYY-MM-DD", () => {
      // Day 32 is invalid — fall through to unknown-format branch
      expect(formatIntroducedDate("2021-01-32")).toBe("2021-01-32");
    });
  });
});

describe("formatDateShapedInteger (QUA-684)", () => {
  describe("recognized shapes", () => {
    it("formats 14-digit YYYYMMDDhhmmss with full timestamp", () => {
      // The exact value the QUA-684 issue cited from the openai render audit.
      expect(formatDateShapedInteger(20240601000000)).toBe(
        "Jun 1, 2024 00:00:00 UTC"
      );
      expect(formatDateShapedInteger(19991231235959)).toBe(
        "Dec 31, 1999 23:59:59 UTC"
      );
    });

    it("formats 12-digit YYYYMMDDhhmm with hours and minutes", () => {
      expect(formatDateShapedInteger(202406010000)).toBe(
        "Jun 1, 2024 00:00 UTC"
      );
      expect(formatDateShapedInteger(202312311800)).toBe(
        "Dec 31, 2023 18:00 UTC"
      );
    });

    it("formats 8-digit YYYYMMDD as date only", () => {
      expect(formatDateShapedInteger(20240601)).toBe("Jun 1, 2024");
      expect(formatDateShapedInteger(19501225)).toBe("Dec 25, 1950");
      expect(formatDateShapedInteger(20991231)).toBe("Dec 31, 2099");
    });
  });

  describe("rejects shapes that aren't dates", () => {
    it("rejects 9, 10, 11, 13 digit lengths (Unix epoch — too ambiguous)", () => {
      // 10 digit: ~2001-2033 epoch seconds, but also a plausible billion-scale
      // count. Skip per QUA-684 issue note.
      expect(formatDateShapedInteger(1700000000)).toBeNull();
      expect(formatDateShapedInteger(1700000000000)).toBeNull(); // 13-digit ms
      expect(formatDateShapedInteger(170000000)).toBeNull(); // 9-digit
      expect(formatDateShapedInteger(17000000000)).toBeNull(); // 11-digit
    });

    it("rejects years outside 1900-2099", () => {
      expect(formatDateShapedInteger(18991231)).toBeNull();
      expect(formatDateShapedInteger(21000101)).toBeNull();
    });

    it("rejects invalid month (00 or 13+)", () => {
      expect(formatDateShapedInteger(20240001)).toBeNull(); // month 00
      expect(formatDateShapedInteger(20241301)).toBeNull(); // month 13
    });

    it("rejects invalid day (00 or 32+)", () => {
      expect(formatDateShapedInteger(20240100)).toBeNull(); // day 00
      expect(formatDateShapedInteger(20240132)).toBeNull(); // day 32
    });

    it("rejects calendar-invalid dates (Feb 30, Feb 29 in non-leap years)", () => {
      expect(formatDateShapedInteger(20240230)).toBeNull(); // Feb 30
      expect(formatDateShapedInteger(20230229)).toBeNull(); // Feb 29 in non-leap year
      expect(formatDateShapedInteger(20240431)).toBeNull(); // Apr 31
    });

    it("accepts Feb 29 in leap years", () => {
      expect(formatDateShapedInteger(20240229)).toBe("Feb 29, 2024");
    });

    it("rejects invalid hour/minute/second in 12/14-digit shapes", () => {
      expect(formatDateShapedInteger(202406012400)).toBeNull(); // hour 24
      expect(formatDateShapedInteger(202406010060)).toBeNull(); // minute 60
      expect(formatDateShapedInteger(20240601235960)).toBeNull(); // second 60
    });

    it("rejects non-positive integers", () => {
      expect(formatDateShapedInteger(0)).toBeNull();
      expect(formatDateShapedInteger(-20240601)).toBeNull();
    });

    it("rejects non-finite and non-integer values", () => {
      expect(formatDateShapedInteger(NaN)).toBeNull();
      expect(formatDateShapedInteger(Infinity)).toBeNull();
      expect(formatDateShapedInteger(20240601.5)).toBeNull();
    });

    it("rejects plausible 8-digit magnitudes that don't form a calendar date", () => {
      // 19,000,000 → "19000000" — month 00, rejected.
      expect(formatDateShapedInteger(19000000)).toBeNull();
      // 20,240,000 → "20240000" — month 00, rejected.
      expect(formatDateShapedInteger(20240000)).toBeNull();
    });
  });
});

describe("sanitizeRawLargeNumbers + dates (QUA-684)", () => {
  it("rewrites 14-digit timestamps as dates, not magnitudes", () => {
    expect(sanitizeRawLargeNumbers("Last seen: 20240601000000")).toBe(
      "Last seen: Jun 1, 2024 00:00:00 UTC"
    );
  });

  it("rewrites 12-digit timestamps as dates", () => {
    expect(sanitizeRawLargeNumbers("Captured 202406010000")).toBe(
      "Captured Jun 1, 2024 00:00 UTC"
    );
  });

  it("preserves 10-digit financial magnitudes (compact form, not dates)", () => {
    expect(sanitizeRawLargeNumbers("Revenue: 1700000000")).toBe(
      "Revenue: 1.7B"
    );
  });

  it("8-digit dates are below the 10-digit sanitize threshold and stay raw", () => {
    // sanitizeRawLargeNumbers only fires on 10+ digit runs; 8-digit dates
    // are not its concern. They're handled by the cell renderer directly.
    expect(sanitizeRawLargeNumbers("Released 20240601")).toBe("Released 20240601");
  });
});
