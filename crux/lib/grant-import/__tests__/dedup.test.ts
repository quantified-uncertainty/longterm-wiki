import { describe, it, expect } from "vitest";
import {
  normalizeGranteeName,
  extractYearMonth,
  amountsMatch,
  dedupeKey,
  detectDuplicates,
  chooseBestGrant,
  deduplicateGrants,
} from "../dedup.ts";
import type { RawGrant } from "../types.ts";
import type { DuplicateGroup } from "../dedup.ts";

// Helper to create a minimal RawGrant
function makeGrant(overrides: Partial<RawGrant> = {}): RawGrant {
  return {
    source: "test-source",
    funderId: "funder-1",
    granteeName: "Test Organization",
    granteeId: null,
    name: "Test Grant",
    amount: 100000,
    date: "2024-06-15",
    focusArea: null,
    description: null,
    sourceUrl: null,
    ...overrides,
  };
}

describe("normalizeGranteeName", () => {
  it("lowercases input", () => {
    expect(normalizeGranteeName("ACME Corporation")).not.toContain("ACME");
    expect(normalizeGranteeName("ACME Corporation")).toBe("acme");
  });

  it("strips Inc., Ltd., LLC, Corp., etc.", () => {
    expect(normalizeGranteeName("Acme Inc.")).toBe("acme");
    expect(normalizeGranteeName("Acme Inc")).toBe("acme");
    expect(normalizeGranteeName("Acme Ltd.")).toBe("acme");
    expect(normalizeGranteeName("Acme LLC")).toBe("acme");
    expect(normalizeGranteeName("Acme Corp.")).toBe("acme");
    expect(normalizeGranteeName("Acme Corporation")).toBe("acme");
  });

  it("strips Foundation, Fund, Institute, etc.", () => {
    expect(normalizeGranteeName("Open Philanthropy Foundation")).toBe("open philanthropy");
    expect(normalizeGranteeName("EA Funds")).toBe("ea");
    expect(normalizeGranteeName("Future of Life Institute")).toBe("future life");
  });

  it("strips articles and prepositions", () => {
    expect(normalizeGranteeName("The Center for AI Safety")).toBe("ai safety");
  });

  it("strips punctuation", () => {
    expect(normalizeGranteeName("Acme, Inc.")).toBe("acme");
    expect(normalizeGranteeName("Some-Org (International)")).toBe("someorg international");
  });

  it("collapses whitespace", () => {
    expect(normalizeGranteeName("  Acme   Corp  ")).toBe("acme");
  });

  it("handles empty string", () => {
    expect(normalizeGranteeName("")).toBe("");
  });

  it("handles names that are entirely stripped", () => {
    // "The" + "Foundation" both get stripped
    expect(normalizeGranteeName("The Foundation")).toBe("");
  });
});

describe("extractYearMonth", () => {
  it("extracts YYYY-MM from YYYY-MM-DD", () => {
    expect(extractYearMonth("2024-06-15")).toBe("2024-06");
  });

  it("extracts from YYYY/MM/DD", () => {
    expect(extractYearMonth("2024/06/15")).toBe("2024-06");
  });

  it("pads single-digit months", () => {
    expect(extractYearMonth("2024-6-15")).toBe("2024-06");
  });

  it("returns empty for null", () => {
    expect(extractYearMonth(null)).toBe("");
  });

  it("returns empty for unparseable strings", () => {
    expect(extractYearMonth("not a date")).toBe("");
  });

  it("handles YYYY-MM without day", () => {
    expect(extractYearMonth("2024-06")).toBe("2024-06");
  });
});

describe("amountsMatch", () => {
  it("returns true for identical amounts", () => {
    expect(amountsMatch(100000, 100000)).toBe(true);
  });

  it("returns true for amounts within 5% tolerance", () => {
    // 100000 vs 104000 = 4% difference
    expect(amountsMatch(100000, 104000)).toBe(true);
  });

  it("returns false for amounts outside 5% tolerance", () => {
    // 100000 vs 110000 = 10% difference
    expect(amountsMatch(100000, 110000)).toBe(false);
  });

  it("returns true for both null", () => {
    expect(amountsMatch(null, null)).toBe(true);
  });

  it("returns false for one null one non-null", () => {
    expect(amountsMatch(null, 100000)).toBe(false);
    expect(amountsMatch(100000, null)).toBe(false);
  });

  it("returns true for both zero", () => {
    expect(amountsMatch(0, 0)).toBe(true);
  });

  it("handles custom tolerance", () => {
    // 100000 vs 120000 = 20% difference, within 25% tolerance
    expect(amountsMatch(100000, 120000, 0.25)).toBe(true);
    // But not within 10% tolerance
    expect(amountsMatch(100000, 120000, 0.1)).toBe(false);
  });

  it("is symmetric", () => {
    expect(amountsMatch(100000, 104000)).toBe(amountsMatch(104000, 100000));
    expect(amountsMatch(100000, 110000)).toBe(amountsMatch(110000, 100000));
  });
});

describe("dedupeKey", () => {
  it("generates consistent keys for similar grants", () => {
    const grant1 = makeGrant({
      granteeName: "Acme Inc.",
      amount: 100000,
      date: "2024-06-15",
    });
    const grant2 = makeGrant({
      granteeName: "Acme, Inc",
      amount: 100000,
      date: "2024-06-20",
    });
    expect(dedupeKey(grant1)).toBe(dedupeKey(grant2));
  });

  it("generates different keys for different grantees", () => {
    const grant1 = makeGrant({ granteeName: "Acme Inc." });
    const grant2 = makeGrant({ granteeName: "Beta Corp." });
    expect(dedupeKey(grant1)).not.toBe(dedupeKey(grant2));
  });

  it("generates different keys for different amounts", () => {
    const grant1 = makeGrant({ amount: 100000 });
    const grant2 = makeGrant({ amount: 200000 });
    expect(dedupeKey(grant1)).not.toBe(dedupeKey(grant2));
  });

  it("generates different keys for different months", () => {
    const grant1 = makeGrant({ date: "2024-06-15" });
    const grant2 = makeGrant({ date: "2024-07-15" });
    expect(dedupeKey(grant1)).not.toBe(dedupeKey(grant2));
  });

  it("handles null amount", () => {
    const grant = makeGrant({ amount: null });
    expect(dedupeKey(grant)).toContain("null");
  });

  it("handles null date", () => {
    const grant = makeGrant({ date: null });
    const key = dedupeKey(grant);
    expect(key).toBeDefined();
  });
});

describe("detectDuplicates", () => {
  it("detects duplicates across different sources", () => {
    const grants = [
      makeGrant({
        source: "sff",
        granteeName: "Machine Intelligence Research Institute",
        amount: 500000,
        date: "2024-03-15",
      }),
      makeGrant({
        source: "ea-funds",
        granteeName: "Machine Intelligence Research Institute",
        amount: 500000,
        date: "2024-03-20",
      }),
    ];

    const groups = detectDuplicates(grants);
    expect(groups.length).toBe(1);
    expect(groups[0].grants.length).toBe(2);
    expect(groups[0].confidence).toBeGreaterThan(0);
  });

  it("does not flag grants from the same source", () => {
    const grants = [
      makeGrant({
        source: "sff",
        granteeName: "MIRI",
        amount: 500000,
        date: "2024-03-15",
      }),
      makeGrant({
        source: "sff",
        granteeName: "MIRI",
        amount: 500000,
        date: "2024-03-20",
      }),
    ];

    const groups = detectDuplicates(grants);
    expect(groups.length).toBe(0);
  });

  it("does not flag grants with very different amounts", () => {
    const grants = [
      makeGrant({
        source: "sff",
        granteeName: "MIRI",
        amount: 500000,
        date: "2024-03-15",
      }),
      makeGrant({
        source: "ea-funds",
        granteeName: "MIRI",
        amount: 50000,
        date: "2024-03-15",
      }),
    ];

    const groups = detectDuplicates(grants);
    expect(groups.length).toBe(0);
  });

  it("handles amounts within 5% tolerance", () => {
    const grants = [
      makeGrant({
        source: "sff",
        granteeName: "Acme Research",
        amount: 100000,
        date: "2024-06-15",
      }),
      makeGrant({
        source: "ea-funds",
        granteeName: "Acme Research",
        amount: 100500, // 0.5% difference — same bucket
        date: "2024-06-20",
      }),
    ];

    const groups = detectDuplicates(grants);
    expect(groups.length).toBe(1);
  });

  it("handles grants with different name formats", () => {
    const grants = [
      makeGrant({
        source: "sff",
        granteeName: "Center for AI Safety, Inc.",
        amount: 200000,
        date: "2024-01-10",
      }),
      makeGrant({
        source: "coefficient-giving",
        granteeName: "The Center for AI Safety",
        amount: 200000,
        date: "2024-01-15",
      }),
    ];

    const groups = detectDuplicates(grants);
    expect(groups.length).toBe(1);
  });

  it("does not flag grants with different months", () => {
    const grants = [
      makeGrant({
        source: "sff",
        granteeName: "MIRI",
        amount: 500000,
        date: "2024-03-15",
      }),
      makeGrant({
        source: "ea-funds",
        granteeName: "MIRI",
        amount: 500000,
        date: "2024-06-15",
      }),
    ];

    const groups = detectDuplicates(grants);
    expect(groups.length).toBe(0);
  });

  it("returns empty for single grants", () => {
    const grants = [makeGrant()];
    expect(detectDuplicates(grants)).toEqual([]);
  });

  it("returns empty for empty input", () => {
    expect(detectDuplicates([])).toEqual([]);
  });

  it("handles multiple duplicate groups", () => {
    const grants = [
      // Group 1
      makeGrant({ source: "sff", granteeName: "Org A", amount: 100000, date: "2024-01-15" }),
      makeGrant({ source: "ea-funds", granteeName: "Org A", amount: 100000, date: "2024-01-20" }),
      // Group 2
      makeGrant({ source: "sff", granteeName: "Org B", amount: 200000, date: "2024-06-15" }),
      makeGrant({ source: "coefficient-giving", granteeName: "Org B", amount: 200000, date: "2024-06-10" }),
      // No duplicate
      makeGrant({ source: "manifund", granteeName: "Org C", amount: 50000, date: "2024-03-01" }),
    ];

    const groups = detectDuplicates(grants);
    expect(groups.length).toBe(2);
  });

  it("sorts groups by confidence descending", () => {
    const grants = [
      // High confidence: exact amounts, different sources
      makeGrant({ source: "sff", granteeName: "Org A", amount: 100000, date: "2024-01-15", description: "desc" }),
      makeGrant({ source: "ea-funds", granteeName: "Org A", amount: 100000, date: "2024-01-15" }),
      // Lower confidence: approximate amounts (204000 vs 200000 = 2%, within 5% tolerance)
      makeGrant({ source: "sff", granteeName: "Org B", amount: 200000, date: "2024-06-15" }),
      makeGrant({ source: "coefficient-giving", granteeName: "Org B", amount: 204000, date: "2024-06-10" }),
    ];

    const groups = detectDuplicates(grants);
    expect(groups.length).toBe(2);
    expect(groups[0].confidence).toBeGreaterThanOrEqual(groups[1].confidence);
  });
});

describe("chooseBestGrant", () => {
  it("prefers grant with description", () => {
    const group: DuplicateGroup = {
      key: "test",
      grants: [
        makeGrant({ source: "sff", description: null }),
        makeGrant({ source: "ea-funds", description: "This is a detailed description of the grant" }),
      ],
      confidence: 0.8,
    };

    const best = chooseBestGrant(group);
    expect(best.source).toBe("ea-funds");
  });

  it("prefers grant with more detail fields", () => {
    const group: DuplicateGroup = {
      key: "test",
      grants: [
        makeGrant({
          source: "sff",
          description: null,
          focusArea: null,
          sourceUrl: null,
        }),
        makeGrant({
          source: "coefficient-giving",
          description: "A grant for research",
          focusArea: "AI Safety",
          sourceUrl: "https://example.com/grant/123",
        }),
      ],
      confidence: 0.8,
    };

    const best = chooseBestGrant(group);
    expect(best.source).toBe("coefficient-giving");
  });

  it("prefers grant with matched entity", () => {
    const group: DuplicateGroup = {
      key: "test",
      grants: [
        makeGrant({ source: "sff", granteeId: null }),
        makeGrant({ source: "ea-funds", granteeId: "entity-123" }),
      ],
      confidence: 0.8,
    };

    const best = chooseBestGrant(group);
    expect(best.source).toBe("ea-funds");
  });

  it("handles single grant", () => {
    const grant = makeGrant();
    const group: DuplicateGroup = {
      key: "test",
      grants: [grant],
      confidence: 0,
    };
    expect(chooseBestGrant(group)).toBe(grant);
  });
});

describe("deduplicateGrants", () => {
  it("removes duplicates and keeps the best", () => {
    const grants = [
      makeGrant({
        source: "sff",
        granteeName: "MIRI",
        amount: 500000,
        date: "2024-03-15",
        description: null,
      }),
      makeGrant({
        source: "ea-funds",
        granteeName: "MIRI",
        amount: 500000,
        date: "2024-03-20",
        description: "Grant for alignment research",
      }),
      // Unrelated grant
      makeGrant({
        source: "manifund",
        granteeName: "Other Org",
        amount: 10000,
        date: "2024-01-01",
      }),
    ];

    const { deduplicated, removed } = deduplicateGrants(grants);
    expect(removed).toBe(1);
    expect(deduplicated.length).toBe(2);
    // The ea-funds grant should be kept (has description)
    expect(deduplicated.some(g => g.source === "ea-funds" && g.granteeName === "MIRI")).toBe(true);
    // The unrelated grant should be kept
    expect(deduplicated.some(g => g.granteeName === "Other Org")).toBe(true);
  });

  it("returns all grants when no duplicates", () => {
    const grants = [
      makeGrant({ source: "sff", granteeName: "Org A", amount: 100000, date: "2024-01-15" }),
      makeGrant({ source: "ea-funds", granteeName: "Org B", amount: 200000, date: "2024-06-15" }),
      makeGrant({ source: "manifund", granteeName: "Org C", amount: 50000, date: "2024-03-01" }),
    ];

    const { deduplicated, removed } = deduplicateGrants(grants);
    expect(removed).toBe(0);
    expect(deduplicated.length).toBe(3);
  });

  it("handles empty input", () => {
    const { deduplicated, removed } = deduplicateGrants([]);
    expect(deduplicated).toEqual([]);
    expect(removed).toBe(0);
  });

  it("handles triple duplicates across three sources", () => {
    const grants = [
      makeGrant({
        source: "sff",
        granteeName: "Acme Research Institute",
        amount: 500000,
        date: "2024-03-15",
        description: null,
        focusArea: null,
      }),
      makeGrant({
        source: "ea-funds",
        granteeName: "Acme Research Institute",
        amount: 500000,
        date: "2024-03-18",
        description: "Grant for alignment research",
        focusArea: null,
      }),
      makeGrant({
        source: "coefficient-giving",
        granteeName: "The Acme Research Institute, Inc.",
        amount: 500000,
        date: "2024-03-15",
        description: "Alignment work",
        focusArea: "AI Safety",
        sourceUrl: "https://example.com/grant",
      }),
    ];

    const { deduplicated, removed } = deduplicateGrants(grants);
    // Should keep only the best one (coefficient-giving has most detail)
    expect(removed).toBe(2);
    expect(deduplicated.length).toBe(1);
    expect(deduplicated[0].source).toBe("coefficient-giving");
  });
});
