import { describe, expect, it } from "vitest";
import { formatCompactCurrency, formatCompactNumber, formatIntroducedDate } from "../format-compact";

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
