import { describe, it, expect } from "vitest";
import {
  computeOrgCoverage,
  computePersonCoverage,
  computeAiModelCoverage,
  computeLegislationCoverage,
  computeGenericCoverage,
} from "../coverage-score";

describe("computeOrgCoverage", () => {
  it("returns 1 for empty/minimal data", () => {
    expect(computeOrgCoverage({})).toBe(1);
    expect(computeOrgCoverage({ revenueNum: null, headcount: null })).toBe(1);
  });

  it("returns 2 for 2 signals", () => {
    expect(computeOrgCoverage({ revenueNum: 1e9, foundedDate: "2020" })).toBe(2);
  });

  it("returns 3 for 4+ signals", () => {
    expect(computeOrgCoverage({
      revenueNum: 1e9, headcount: 100, foundedDate: "2020", wikiPageId: "E42",
    })).toBe(3);
  });

  it("returns 4 for 6+ signals", () => {
    expect(computeOrgCoverage({
      revenueNum: 1e9, valuationNum: 10e9, headcount: 100,
      totalFundingNum: 5e6, foundedDate: "2020", peopleCount: 10, wikiPageId: "E42",
    })).toBe(4);
  });

  it("counts people thresholds correctly", () => {
    // 2 people = 0 signals from people
    expect(computeOrgCoverage({ peopleCount: 2 })).toBe(1);
    // 3 people = 1 signal, + foundedDate = 2 signals
    expect(computeOrgCoverage({ peopleCount: 3, foundedDate: "2020" })).toBe(2);
    // 10 people = 2 signals, + foundedDate = 3 signals (still score 2)
    expect(computeOrgCoverage({ peopleCount: 10, foundedDate: "2020" })).toBe(2);
  });
});

describe("computePersonCoverage", () => {
  it("returns 1 for name-only person", () => {
    expect(computePersonCoverage({})).toBe(1);
  });

  it("returns 2 for person with role + employer", () => {
    expect(computePersonCoverage({ role: "CEO", employerId: "org1" })).toBe(2);
  });

  it("returns 3 for person with 4+ signals", () => {
    expect(computePersonCoverage({
      role: "CEO", employerId: "org1", bornYear: 1980, wikiPageId: "E100",
    })).toBe(3);
  });

  it("returns 4 for person with 6+ signals", () => {
    expect(computePersonCoverage({
      role: "CEO", employerId: "org1", bornYear: 1980,
      careerHistoryCount: 5, publicationCount: 3, wikiPageId: "E100",
    })).toBe(4);
  });
});

describe("computeAiModelCoverage", () => {
  it("returns 1 for minimal model", () => {
    expect(computeAiModelCoverage({})).toBe(1);
  });

  it("returns 2 for model with 3 basic fields", () => {
    expect(computeAiModelCoverage({
      developer: "anthropic", releaseDate: "2025-01", contextWindow: 200000,
    })).toBe(2);
  });

  it("returns 4 for well-documented model", () => {
    expect(computeAiModelCoverage({
      developer: "anthropic", releaseDate: "2025-01", inputPrice: 3,
      contextWindow: 200000, parameterCount: "175B", safetyLevel: "ASL-2",
      benchmarkCount: 3, wikiId: "E200",
    })).toBe(4);
  });
});

describe("computeLegislationCoverage", () => {
  it("returns 1 for minimal legislation", () => {
    expect(computeLegislationCoverage({})).toBe(1);
  });

  it("returns 3 for legislation with moderate data", () => {
    expect(computeLegislationCoverage({
      introduced: "2025-01", policyStatus: "enacted",
      jurisdiction: "California", billNumber: "SB 1047",
      description: "AI safety bill",
    })).toBe(3);
  });

  it("returns 4 for well-documented legislation", () => {
    expect(computeLegislationCoverage({
      introduced: "2025-01", policyStatus: "enacted", author: "Wiener",
      jurisdiction: "California", billNumber: "SB 1047",
      fullTextUrl: "https://...", description: "AI safety", tags: ["ai-safety"],
      wikiId: "E300",
    })).toBe(4);
  });
});

describe("computeGenericCoverage", () => {
  it("returns 1 for empty", () => {
    expect(computeGenericCoverage({})).toBe(1);
  });

  it("returns 2 for entity with description + tags", () => {
    expect(computeGenericCoverage({ description: "A thing", tags: ["tag1"] })).toBe(2);
  });

  it("returns 4 for entity with rich data", () => {
    expect(computeGenericCoverage({
      description: "A thing", tags: ["a"], wikiId: "E1", filledFieldCount: 3,
    })).toBe(4);
  });
});
