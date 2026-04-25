import { describe, it, expect } from "vitest";
import {
  rowsToCellsForVersion,
  activeDomains,
} from "@/app/frontier-safety-frameworks/matrix-aggregation";
import type { ThresholdRow } from "@/app/frontier-safety-frameworks/frameworks-data";

function makeRow(over: Partial<ThresholdRow>): ThresholdRow {
  return {
    id: over.id ?? "sid_test12345",
    versionId: over.versionId ?? "v1",
    riskDomainCanonical: over.riskDomainCanonical ?? "cbrn",
    riskDomainLabel: over.riskDomainLabel ?? "CBRN",
    tierLabel: over.tierLabel ?? "T1",
    tierSortOrder: over.tierSortOrder ?? 1,
    triggerDescription: over.triggerDescription ?? "trigger",
    sourceQuote: over.sourceQuote ?? "quote",
    sourcePageHint: over.sourcePageHint ?? null,
    commitmentLanguage: over.commitmentLanguage ?? null,
    humanReviewed: over.humanReviewed ?? false,
  };
}

describe("rowsToCellsForVersion", () => {
  it("returns the most-severe tier per domain", () => {
    const rows = [
      makeRow({ riskDomainCanonical: "cbrn", tierLabel: "Low", tierSortOrder: 1 }),
      makeRow({ riskDomainCanonical: "cbrn", tierLabel: "Critical", tierSortOrder: 4 }),
      makeRow({ riskDomainCanonical: "cbrn", tierLabel: "Medium", tierSortOrder: 2 }),
    ];
    const cells = rowsToCellsForVersion(rows);
    expect(cells.cbrn?.tierLabel).toBe("Critical");
    expect(cells.cbrn?.tierSortOrder).toBe(4);
    expect(cells.cbrn?.count).toBe(3);
  });

  it("groups rows by canonical domain", () => {
    const rows = [
      makeRow({ riskDomainCanonical: "cbrn", tierSortOrder: 3 }),
      makeRow({ riskDomainCanonical: "cyber", tierSortOrder: 2 }),
      makeRow({ riskDomainCanonical: "ai_rd", tierSortOrder: 4 }),
    ];
    const cells = rowsToCellsForVersion(rows);
    expect(cells.cbrn?.tierSortOrder).toBe(3);
    expect(cells.cyber?.tierSortOrder).toBe(2);
    expect(cells.ai_rd?.tierSortOrder).toBe(4);
    expect(Object.keys(cells)).toHaveLength(3);
  });

  it("prefers a reviewed row over an unreviewed row at the same tier", () => {
    const rows = [
      makeRow({ tierLabel: "Tier-3 unreviewed", tierSortOrder: 3, humanReviewed: false }),
      makeRow({ tierLabel: "Tier-3 reviewed", tierSortOrder: 3, humanReviewed: true }),
    ];
    const cells = rowsToCellsForVersion(rows);
    expect(cells.cbrn?.tierLabel).toBe("Tier-3 reviewed");
    expect(cells.cbrn?.reviewed).toBe(true);
  });

  it("does not downgrade tier when a later row has lower severity", () => {
    const rows = [
      makeRow({ tierLabel: "Severe", tierSortOrder: 5 }),
      makeRow({ tierLabel: "Low", tierSortOrder: 1 }),
    ];
    const cells = rowsToCellsForVersion(rows);
    expect(cells.cbrn?.tierLabel).toBe("Severe");
    expect(cells.cbrn?.tierSortOrder).toBe(5);
  });

  it("returns an empty object for no rows", () => {
    expect(rowsToCellsForVersion([])).toEqual({});
  });
});

describe("activeDomains", () => {
  it("returns canonical-order union across all versions", () => {
    const v1 = rowsToCellsForVersion([
      makeRow({ riskDomainCanonical: "cyber", tierSortOrder: 2 }),
    ]);
    const v2 = rowsToCellsForVersion([
      makeRow({ riskDomainCanonical: "cbrn", tierSortOrder: 3 }),
      makeRow({ riskDomainCanonical: "ai_rd", tierSortOrder: 4 }),
    ]);
    // Canonical order is cbrn before cyber before ai_rd.
    expect(activeDomains([v1, v2])).toEqual(["cbrn", "cyber", "ai_rd"]);
  });

  it("returns an empty array when no version has any cells", () => {
    expect(activeDomains([])).toEqual([]);
    expect(activeDomains([{}])).toEqual([]);
  });
});
