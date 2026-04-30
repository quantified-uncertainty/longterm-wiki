import { describe, it, expect } from "vitest";
import {
  SCORECARD_SOURCES,
  getScorecardSourceMeta,
  formatScoreCell,
  isCodeLikeGrade,
  gradeCellFontClass,
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

  describe("isCodeLikeGrade", () => {
    it.each([
      "A", "A+", "A-",
      "B", "B+", "B-",
      "C", "C+", "C-",
      "D", "D+", "D-",
      "F",
    ])("treats letter grade %s as code-like", (grade) => {
      expect(isCodeLikeGrade(grade)).toBe(true);
    });

    it.each([
      "84", "0", "100", "84.5", "75/100", "75%", "1.0",
    ])("treats numeric/scored value %s as code-like", (value) => {
      expect(isCodeLikeGrade(value)).toBe(true);
    });

    it.each([
      "Weak", "Very Weak", "Fulfilled", "Partial", "Unfulfilled",
      "Moderate", "Strong",
    ])("treats prose verdict %s as NOT code-like", (verdict) => {
      expect(isCodeLikeGrade(verdict)).toBe(false);
    });

    it("treats empty/whitespace as not code-like", () => {
      expect(isCodeLikeGrade("")).toBe(false);
      expect(isCodeLikeGrade("   ")).toBe(false);
    });

    it("trims surrounding whitespace before classifying", () => {
      expect(isCodeLikeGrade("  C+  ")).toBe(true);
      expect(isCodeLikeGrade("  Fulfilled  ")).toBe(false);
    });

    it("does not match alphabetic strings starting beyond F", () => {
      // "Good" starts with G — must not be classified as a letter grade.
      expect(isCodeLikeGrade("Good")).toBe(false);
      expect(isCodeLikeGrade("Great")).toBe(false);
    });

    it("does not match multi-character letter codes that aren't grades", () => {
      // Real verdict labels we've seen on prod scorecards.
      expect(isCodeLikeGrade("Acceptable")).toBe(false);
      expect(isCodeLikeGrade("Bad")).toBe(false);
    });

    it("does not match lowercase letter grades", () => {
      // Actual scorecards publish "C+", never "c+". Rejecting lowercase
      // keeps single-letter article ("a") and other prose out.
      expect(isCodeLikeGrade("a")).toBe(false);
      expect(isCodeLikeGrade("b+")).toBe(false);
      expect(isCodeLikeGrade("f")).toBe(false);
    });

    it("does not match prose that starts with a digit", () => {
      // Critical: regex must be anchored to end-of-string so a leading
      // digit doesn't trick us into rendering prose in monospace.
      expect(isCodeLikeGrade("5 stars met")).toBe(false);
      expect(isCodeLikeGrade("100% achieved")).toBe(false);
      expect(isCodeLikeGrade("75 of 100")).toBe(false);
      expect(isCodeLikeGrade("1.0xfoo")).toBe(false);
      expect(isCodeLikeGrade("42 things")).toBe(false);
    });

    it("does not match malformed numeric shapes", () => {
      // Trailing letters, mixed forms — must not classify as code.
      expect(isCodeLikeGrade("84%foo")).toBe(false);
      expect(isCodeLikeGrade("75/")).toBe(false);
      expect(isCodeLikeGrade(".5")).toBe(false);
      expect(isCodeLikeGrade("1..0")).toBe(false);
    });
  });

  describe("gradeCellFontClass", () => {
    it("returns mono+tabular-nums for letter grades", () => {
      expect(gradeCellFontClass("C+")).toBe("font-mono tabular-nums");
    });

    it("returns mono+tabular-nums for numeric values", () => {
      expect(gradeCellFontClass("84")).toBe("font-mono tabular-nums");
    });

    it("returns empty string for prose verdicts", () => {
      expect(gradeCellFontClass("Weak")).toBe("");
      expect(gradeCellFontClass("Fulfilled")).toBe("");
      expect(gradeCellFontClass("Very Weak")).toBe("");
    });

    it("returns empty for blank input", () => {
      expect(gradeCellFontClass("")).toBe("");
    });
  });
});
