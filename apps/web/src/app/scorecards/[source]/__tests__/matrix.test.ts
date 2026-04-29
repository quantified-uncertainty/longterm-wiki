import { describe, it, expect } from "vitest";
import { buildOrgDimensionMatrix, type MatrixGrade } from "../matrix";

function grade(
  entityId: string,
  displayName: string,
  slug: string | null,
  dimensionSlug: string,
  dimensionLabel: string,
  scoreLetter: string | null = null,
  scoreNumeric: number | null = null,
  scoreRaw: string = "",
): MatrixGrade {
  return {
    entityId,
    entityDisplayName: displayName,
    entitySlug: slug,
    dimensionSlug,
    dimensionLabel,
    scoreLetter,
    scoreNumeric,
    scoreRaw,
  };
}

describe("buildOrgDimensionMatrix", () => {
  it("returns empty result for an empty grade list", () => {
    const result = buildOrgDimensionMatrix([]);
    expect(result.orgRows).toEqual([]);
    expect(result.dimensionOrder).toEqual([]);
    expect(result.hasOverall).toBe(false);
  });

  it("groups grades by entity and dimension", () => {
    const result = buildOrgDimensionMatrix([
      grade("e1", "Anthropic", "anthropic", "current-harms", "Current Harms", "B"),
      grade("e1", "Anthropic", "anthropic", "existential-safety", "Existential Safety", "C+"),
      grade("e2", "OpenAI", "openai", "current-harms", "Current Harms", "C"),
    ]);
    expect(result.orgRows).toHaveLength(2);
    expect(result.orgRows[0].displayName).toBe("Anthropic");
    expect(result.orgRows[0].cells["current-harms"]?.scoreLetter).toBe("B");
    expect(result.orgRows[0].cells["existential-safety"]?.scoreLetter).toBe("C+");
    expect(result.orgRows[1].displayName).toBe("OpenAI");
    expect(result.orgRows[1].cells["current-harms"]?.scoreLetter).toBe("C");
  });

  it("sorts orgs alphabetically by displayName", () => {
    const result = buildOrgDimensionMatrix([
      grade("e3", "xAI", null, "overall", "Overall"),
      grade("e1", "Anthropic", "anthropic", "overall", "Overall"),
      grade("e2", "OpenAI", "openai", "overall", "Overall"),
    ]);
    expect(result.orgRows.map((r) => r.displayName)).toEqual([
      "Anthropic",
      "OpenAI",
      "xAI",
    ]);
  });

  it("places `overall` as the leftmost dimension when present", () => {
    const result = buildOrgDimensionMatrix([
      grade("e1", "Anthropic", "a", "current-harms", "Current Harms"),
      grade("e1", "Anthropic", "a", "overall", "Overall"),
      grade("e1", "Anthropic", "a", "governance", "Governance"),
    ]);
    expect(result.dimensionOrder.map((d) => d.slug)).toEqual([
      "overall",
      "current-harms",
      "governance",
    ]);
    expect(result.hasOverall).toBe(true);
  });

  it("returns hasOverall=false when no overall dimension present", () => {
    const result = buildOrgDimensionMatrix([
      grade("e1", "Anthropic", "a", "governance", "Governance"),
      grade("e1", "Anthropic", "a", "current-harms", "Current Harms"),
    ]);
    expect(result.hasOverall).toBe(false);
    // Alphabetical order by label: "Current Harms" < "Governance"
    expect(result.dimensionOrder.map((d) => d.slug)).toEqual([
      "current-harms",
      "governance",
    ]);
  });

  it("handles entities without a slug (renders fallback in caller)", () => {
    const result = buildOrgDimensionMatrix([
      grade("e1", "Some Lab", null, "overall", "Overall", "B"),
    ]);
    expect(result.orgRows[0].slug).toBeNull();
    expect(result.orgRows[0].displayName).toBe("Some Lab");
  });

  it("last-write-wins on duplicate (entity, dimension) pairs", () => {
    // Caller is expected to filter to a single snapshot, but defensive
    // semantics: the second grade overwrites the first.
    const result = buildOrgDimensionMatrix([
      grade("e1", "Anthropic", "a", "overall", "Overall", "B"),
      grade("e1", "Anthropic", "a", "overall", "Overall", "A-"),
    ]);
    expect(result.orgRows[0].cells["overall"]?.scoreLetter).toBe("A-");
  });

  it("preserves dimension labels even when they differ from slug", () => {
    const result = buildOrgDimensionMatrix([
      grade("e1", "Anthropic", "a", "info-sharing", "Information Sharing"),
    ]);
    expect(result.dimensionOrder[0]).toEqual({
      slug: "info-sharing",
      label: "Information Sharing",
    });
  });
});
