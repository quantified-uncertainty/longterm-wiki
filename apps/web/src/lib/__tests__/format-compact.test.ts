import { describe, expect, it } from "vitest";
import { formatIntroducedDate } from "../format-compact";

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
