import { describe, it, expect } from "vitest";
import { scoreSearchMatch, filterAndRankBySearch } from "../explore-search";
import type { ExploreItem } from "@/data";

/** Helper to create a minimal ExploreItem for testing. */
function makeItem(overrides: Partial<ExploreItem> & { id: string; title: string }): ExploreItem {
  return {
    numericId: "E1",
    type: "concept",
    description: null,
    tags: [],
    clusters: [],
    wordCount: 1000,
    quality: 50,
    readerImportance: 50,
    researchImportance: null,
    tacticalValue: null,
    backlinkCount: null,
    category: null,
    riskCategory: null,
    lastUpdated: null,
    dateCreated: null,
    ...overrides,
  };
}

describe("scoreSearchMatch", () => {
  it("scores exact title match highest (1000)", () => {
    const item = makeItem({ id: "anthropic", title: "Anthropic" });
    expect(scoreSearchMatch(item, "Anthropic")).toBe(1000);
    expect(scoreSearchMatch(item, "anthropic")).toBe(1000);
    expect(scoreSearchMatch(item, "ANTHROPIC")).toBe(1000);
  });

  it("scores title-starts-with-query+space as 100", () => {
    const item = makeItem({ id: "anthropic-ipo", title: "Anthropic IPO" });
    expect(scoreSearchMatch(item, "Anthropic")).toBe(100);
  });

  it("scores title-starts-with-query (no space) as 90", () => {
    const item = makeItem({ id: "anthropic-ipo", title: "Anthropicxyz" });
    expect(scoreSearchMatch(item, "Anthropic")).toBe(90);
  });

  it("scores word-boundary match in title as 10", () => {
    const item = makeItem({
      id: "pentagon-anthropic",
      title: "Pentagon Anthropic Contract",
    });
    expect(scoreSearchMatch(item, "Anthropic")).toBe(10);
  });

  it("scores substring match in title as 5", () => {
    const item = makeItem({
      id: "some-page",
      title: "Pre-Anthropic Era",
    });
    // "anthropic" after hyphen — includes(" anthropic") would need space, but
    // "Pre-Anthropic" contains "anthropic" as substring
    expect(scoreSearchMatch(item, "Anthropic")).toBe(5);
  });

  it("scores exact tag match as 2", () => {
    const item = makeItem({
      id: "some-page",
      title: "AI Safety Overview",
      tags: ["anthropic", "safety"],
    });
    expect(scoreSearchMatch(item, "Anthropic")).toBe(2);
  });

  it("scores description match as 1", () => {
    const item = makeItem({
      id: "some-page",
      title: "AI Safety",
      description: "Founded by Anthropic researchers",
    });
    expect(scoreSearchMatch(item, "Anthropic")).toBe(1);
  });

  it("scores partial tag match as 1", () => {
    const item = makeItem({
      id: "some-page",
      title: "Safety Research",
      tags: ["anthropic-related"],
    });
    expect(scoreSearchMatch(item, "Anthropic")).toBe(1);
  });

  it("returns 0 for no match", () => {
    const item = makeItem({
      id: "openai",
      title: "OpenAI",
      description: "AI company",
      tags: ["ai"],
    });
    expect(scoreSearchMatch(item, "Anthropic")).toBe(0);
  });

  it("returns 0 for empty query", () => {
    const item = makeItem({ id: "anthropic", title: "Anthropic" });
    expect(scoreSearchMatch(item, "")).toBe(0);
    expect(scoreSearchMatch(item, "  ")).toBe(0);
  });
});

describe("filterAndRankBySearch", () => {
  const items: ExploreItem[] = [
    makeItem({
      id: "ai-alignment",
      title: "AI Alignment",
      numericId: "E1",
      description: "Comprehensive review of AI alignment approaches",
      tags: ["alignment", "anthropic"],
      recommendedScore: 95,
    }),
    makeItem({
      id: "anthropic",
      title: "Anthropic",
      numericId: "E2",
      description: "AI safety company",
      tags: ["ai-company"],
      recommendedScore: 80,
    }),
    makeItem({
      id: "anthropic-pentagon",
      title: "Anthropic-Pentagon Partnership",
      numericId: "E3",
      description: "Analysis of Anthropic defense contract",
      tags: ["defense"],
      recommendedScore: 60,
    }),
    makeItem({
      id: "structured-access",
      title: "Structured Access / API-Only",
      numericId: "E4",
      description: "Structured access deployment by Anthropic and others",
      tags: ["deployment-safety"],
      recommendedScore: 70,
    }),
    makeItem({
      id: "openai",
      title: "OpenAI",
      numericId: "E5",
      description: "AI research company",
      tags: ["ai-company"],
      recommendedScore: 85,
    }),
  ];

  it("returns all items for empty query", () => {
    const result = filterAndRankBySearch(items, "");
    expect(result).toEqual(items);
  });

  it("ranks exact title match first for 'Anthropic'", () => {
    const result = filterAndRankBySearch(items, "Anthropic");
    expect(result[0].id).toBe("anthropic");
    expect(result[0].title).toBe("Anthropic");
  });

  it("ranks title-prefix match second for 'Anthropic'", () => {
    const result = filterAndRankBySearch(items, "Anthropic");
    // "Anthropic-Pentagon Partnership" starts with "Anthropic" (no space after)
    expect(result[1].id).toBe("anthropic-pentagon");
  });

  it("excludes items that don't match at all", () => {
    const result = filterAndRankBySearch(items, "Anthropic");
    const ids = result.map((r) => r.id);
    expect(ids).not.toContain("openai");
  });

  it("includes items matching via description", () => {
    const result = filterAndRankBySearch(items, "Anthropic");
    const ids = result.map((r) => r.id);
    expect(ids).toContain("structured-access");
  });

  it("includes items matching via tags", () => {
    const result = filterAndRankBySearch(items, "Anthropic");
    const ids = result.map((r) => r.id);
    expect(ids).toContain("ai-alignment");
  });

  it("ensures exact match ranks above high-recommendedScore partial match", () => {
    // This is the specific regression test: "Anthropic" (recommendedScore=80)
    // must rank above "AI Alignment" (recommendedScore=95, tag match only)
    const result = filterAndRankBySearch(items, "Anthropic");
    const anthropicIdx = result.findIndex((r) => r.id === "anthropic");
    const alignmentIdx = result.findIndex((r) => r.id === "ai-alignment");
    expect(anthropicIdx).toBeLessThan(alignmentIdx);
  });

  it("handles case-insensitive matching", () => {
    const result = filterAndRankBySearch(items, "anthropic");
    expect(result[0].id).toBe("anthropic");
  });

  it("handles query with leading/trailing whitespace", () => {
    const result = filterAndRankBySearch(items, "  Anthropic  ");
    expect(result[0].id).toBe("anthropic");
  });
});
