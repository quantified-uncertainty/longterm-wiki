import { describe, it, expect } from "vitest";
import {
  SCORECARD_SOURCES,
  SCORECARD_SOURCE_LOOKUP,
  getScorecardSourceMeta,
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

  it("lookup returns the same record as the array exposes", () => {
    for (const meta of SCORECARD_SOURCES) {
      expect(SCORECARD_SOURCE_LOOKUP[meta.source]).toBe(meta);
      expect(getScorecardSourceMeta(meta.source)).toBe(meta);
    }
  });

  it("returns null for unknown sources", () => {
    expect(getScorecardSourceMeta("unknown-source")).toBeNull();
    expect(getScorecardSourceMeta("")).toBeNull();
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
