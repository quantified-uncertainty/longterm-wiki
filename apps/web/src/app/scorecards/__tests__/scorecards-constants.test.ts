import { describe, it, expect } from "vitest";
import {
  SCORECARD_SOURCES,
  getScorecardSourceMeta,
  formatScoreCell,
  DIMENSION_OVERALL,
} from "../scorecards-constants";

describe("scorecards-constants", () => {
  it("declares exactly five known scorecard sources", () => {
    expect(SCORECARD_SOURCES).toHaveLength(5);
    const sources = SCORECARD_SOURCES.map((s) => s.source).sort();
    expect(sources).toEqual([
      "ailabwatch",
      "fli_index",
      "fmti",
      "saferai",
      "seoul_tracker",
    ]);
  });

  it("getScorecardSourceMeta returns the array record by source key", () => {
    for (const meta of SCORECARD_SOURCES) {
      expect(getScorecardSourceMeta(meta.source)).toBe(meta);
    }
  });

  it("returns null for unknown sources", () => {
    expect(getScorecardSourceMeta("unknown-source")).toBeNull();
    expect(getScorecardSourceMeta("")).toBeNull();
  });

  it("DIMENSION_OVERALL is a stable slug", () => {
    expect(DIMENSION_OVERALL).toBe("overall");
  });

  describe("formatScoreCell", () => {
    it("prefers letter grade when present", () => {
      expect(
        formatScoreCell({ scoreLetter: "C+", scoreNumeric: 70, scoreRaw: "70%" }),
      ).toBe("C+");
    });
    it("falls back to numeric when no letter", () => {
      expect(
        formatScoreCell({ scoreLetter: null, scoreNumeric: 84, scoreRaw: "84.5" }),
      ).toBe("84");
    });
    it("falls back to raw string when neither numeric nor letter", () => {
      expect(
        formatScoreCell({ scoreLetter: null, scoreNumeric: null, scoreRaw: "Fulfilled" }),
      ).toBe("Fulfilled");
    });
    it("handles 0 numeric scores correctly (not falsy-coerced)", () => {
      expect(
        formatScoreCell({ scoreLetter: null, scoreNumeric: 0, scoreRaw: "should-not-show" }),
      ).toBe("0");
    });
  });

  it("each source has a non-empty home URL and description", () => {
    for (const meta of SCORECARD_SOURCES) {
      expect(meta.homeUrl).toMatch(/^https?:\/\//);
      expect(meta.description.length).toBeGreaterThan(20);
      expect(meta.shortLabel.length).toBeGreaterThan(0);
      expect(meta.publisher.length).toBeGreaterThan(0);
    }
  });

  it("AI Lab Watch is flagged as no longer maintained", () => {
    const meta = getScorecardSourceMeta("ailabwatch");
    expect(meta?.active).toBe(false);
  });

  it("active sources are flagged as active", () => {
    for (const slug of ["fli_index", "saferai", "fmti", "seoul_tracker"]) {
      const meta = getScorecardSourceMeta(slug);
      expect(meta?.active).toBe(true);
    }
  });
});
