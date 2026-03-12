import { describe, it, expect } from "vitest";
import { parseGiveWellAmount, parseGiveWellDate } from "../sources/givewell.ts";

describe("parseGiveWellAmount", () => {
  it("parses simple dollar amount", () => {
    expect(parseGiveWellAmount("$2,500,000")).toBe(2500000);
  });

  it("parses amount without dollar sign", () => {
    expect(parseGiveWellAmount("2500000")).toBe(2500000);
  });

  it("parses M suffix", () => {
    expect(parseGiveWellAmount("$2.5M")).toBe(2500000);
  });

  it("parses K suffix", () => {
    expect(parseGiveWellAmount("$500K")).toBe(500000);
  });

  it("parses lowercase m suffix", () => {
    expect(parseGiveWellAmount("2.5m")).toBe(2500000);
  });

  it("parses lowercase k suffix", () => {
    expect(parseGiveWellAmount("500k")).toBe(500000);
  });

  it("returns null for empty string", () => {
    expect(parseGiveWellAmount("")).toBeNull();
  });

  it("returns null for non-numeric string", () => {
    expect(parseGiveWellAmount("TBD")).toBeNull();
  });

  it("handles whitespace", () => {
    expect(parseGiveWellAmount("  $1,000  ")).toBe(1000);
  });

  it("handles amount with spaces in commas", () => {
    expect(parseGiveWellAmount("$1, 000, 000")).toBe(1000000);
  });
});

describe("parseGiveWellDate", () => {
  it("parses ISO date YYYY-MM-DD", () => {
    expect(parseGiveWellDate("2023-05-15")).toBe("2023-05-15");
  });

  it("parses ISO date YYYY-MM", () => {
    expect(parseGiveWellDate("2023-05")).toBe("2023-05");
  });

  it("parses year only", () => {
    expect(parseGiveWellDate("2023")).toBe("2023");
  });

  it("parses Month Year format", () => {
    expect(parseGiveWellDate("November 2021")).toBe("2021-11");
  });

  it("parses January", () => {
    expect(parseGiveWellDate("January 2024")).toBe("2024-01");
  });

  it("parses December", () => {
    expect(parseGiveWellDate("December 2020")).toBe("2020-12");
  });

  it("parses MM/DD/YYYY format", () => {
    expect(parseGiveWellDate("3/15/2023")).toBe("2023-03-15");
  });

  it("parses padded MM/DD/YYYY format", () => {
    expect(parseGiveWellDate("03/15/2023")).toBe("2023-03-15");
  });

  it("returns null for empty string", () => {
    expect(parseGiveWellDate("")).toBeNull();
  });

  it("returns null for unrecognized format", () => {
    expect(parseGiveWellDate("some random text")).toBeNull();
  });

  it("handles whitespace", () => {
    expect(parseGiveWellDate("  2023-05  ")).toBe("2023-05");
  });
});
