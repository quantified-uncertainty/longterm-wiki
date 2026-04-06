import { describe, it, expect } from "vitest";
import {
  computeOrgCoverage,
  computePersonCoverage,
  computeAiModelCoverage,
  computeLegislationCoverage,
  computeGenericCoverage,
  computeProjectCoverage,
  computeBenchmarkCoverage,
  computeGrantCoverage,
  computeFundingProgramCoverage,
  computeFundingRoundCoverage,
  computeDivisionCoverage,
  computePublicationCoverage,
} from "@/components/coverage/coverage-score";

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

  it("returns 3 for entity with description + tags + wikiId", () => {
    expect(computeGenericCoverage({
      description: "A thing", tags: ["a"], wikiId: "E1",
    })).toBe(3);
  });

  it("returns 4 for entity with all signals maxed", () => {
    expect(computeGenericCoverage({
      description: "A thing", tags: ["a"], wikiId: "E1", filledFieldCount: 3,
    })).toBe(4);
  });

  it("caps filledFieldCount at 2", () => {
    // filledFieldCount=5 should contribute at most 2 signals
    expect(computeGenericCoverage({ filledFieldCount: 5 })).toBe(2);
  });
});

describe("computeProjectCoverage", () => {
  it("returns 1 for empty", () => {
    expect(computeProjectCoverage({})).toBe(1);
  });

  it("returns 2 for project with status + org", () => {
    expect(computeProjectCoverage({ status: "active", orgName: "MIRI" })).toBe(2);
  });

  it("returns 3 for project with 3+ fields", () => {
    expect(computeProjectCoverage({
      description: "A tool", status: "active", website: "https://...",
    })).toBe(3);
  });

  it("returns 4 for comprehensive project", () => {
    expect(computeProjectCoverage({
      description: "A tool", status: "active", website: "https://...",
      orgName: "MIRI", clusters: ["alignment"], wikiId: "E100",
    })).toBe(4);
  });
});

describe("computeBenchmarkCoverage", () => {
  it("returns 1 for empty", () => {
    expect(computeBenchmarkCoverage({})).toBe(1);
  });

  it("returns 2 for benchmark with category + description", () => {
    expect(computeBenchmarkCoverage({ category: "coding", description: "A test" })).toBe(2);
  });

  it("returns 3 for benchmark with 4+ signals", () => {
    expect(computeBenchmarkCoverage({
      category: "coding", description: "A test", maintainer: "OpenAI",
      introducedDate: "2023-01",
    })).toBe(3);
  });

  it("returns 4 for comprehensive benchmark", () => {
    expect(computeBenchmarkCoverage({
      category: "coding", scoringMethod: "accuracy", introducedDate: "2023-01",
      maintainer: "OpenAI", description: "A test", modelsCount: 10, wikiId: "E100",
    })).toBe(4);
  });

  it("uses modelsCount thresholds: 3+ and 10+", () => {
    expect(computeBenchmarkCoverage({ modelsCount: 2 })).toBe(1);
    expect(computeBenchmarkCoverage({ modelsCount: 3, category: "math" })).toBe(2);
    expect(computeBenchmarkCoverage({ modelsCount: 10, category: "math" })).toBe(2);
  });
});

describe("computeGrantCoverage", () => {
  it("returns 1 for empty", () => {
    expect(computeGrantCoverage({})).toBe(1);
  });

  it("returns 2 for grant with amount + recipient", () => {
    expect(computeGrantCoverage({ amount: 100000, recipient: "MIRI" })).toBe(2);
  });

  it("returns 3 for grant with 3+ fields", () => {
    expect(computeGrantCoverage({ amount: 100000, recipient: "MIRI", date: "2024-01" })).toBe(3);
  });

  it("returns 4 for comprehensive grant", () => {
    expect(computeGrantCoverage({
      amount: 100000, recipient: "MIRI", date: "2024-01",
      program: "AI Safety", status: "awarded", source: "https://...",
    })).toBe(4);
  });
});

describe("computeFundingProgramCoverage", () => {
  it("returns 1 for empty", () => {
    expect(computeFundingProgramCoverage({})).toBe(1);
  });

  it("returns 3 for program with budget + type + deadline", () => {
    expect(computeFundingProgramCoverage({
      totalBudget: 1e6, programType: "grant-round", deadline: "2025-06",
    })).toBe(3);
  });

  it("returns 4 for comprehensive program", () => {
    expect(computeFundingProgramCoverage({
      totalBudget: 1e6, programType: "grant-round", deadline: "2025-06",
      status: "open", description: "AI safety grants", applicationUrl: "https://...",
    })).toBe(4);
  });
});

describe("computeFundingRoundCoverage", () => {
  it("returns 1 for empty", () => {
    expect(computeFundingRoundCoverage({})).toBe(1);
  });

  it("returns 2 for round with raised + date", () => {
    expect(computeFundingRoundCoverage({ raised: 2e9, date: "2023-10" })).toBe(2);
  });

  it("returns 4 for comprehensive round", () => {
    expect(computeFundingRoundCoverage({
      raised: 2e9, valuation: 18e9, date: "2023-10",
      instrument: "equity", leadInvestorName: "Google",
    })).toBe(4);
  });
});

describe("computeDivisionCoverage", () => {
  it("returns 1 for empty", () => {
    expect(computeDivisionCoverage({})).toBe(1);
  });

  it("returns 2 for division with type + status", () => {
    expect(computeDivisionCoverage({ divisionType: "lab", status: "active" })).toBe(2);
  });

  it("returns 4 for comprehensive division", () => {
    expect(computeDivisionCoverage({
      divisionType: "lab", status: "active", hasData: true, href: "/divisions/x",
    })).toBe(4);
  });
});

describe("computePublicationCoverage", () => {
  it("returns 1 for empty", () => {
    expect(computePublicationCoverage({})).toBe(1);
  });

  it("returns 2 for publication with credibility + type", () => {
    expect(computePublicationCoverage({ credibility: 8, type: "academic_journal" })).toBe(2);
  });

  it("returns 4 for comprehensive publication", () => {
    expect(computePublicationCoverage({
      credibility: 9, peerReviewed: true, resourceCount: 10, pageCount: 5, type: "academic_journal",
    })).toBe(4);
  });
});
