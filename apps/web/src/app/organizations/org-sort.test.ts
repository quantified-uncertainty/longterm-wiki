import { describe, expect, it } from "vitest";

import type { OrgRow } from "./organizations-table";
import { getOrgSortValue, compareOrgRows } from "./org-sort";
import { computeOrgCoverage, getOrgSignals } from "@/components/coverage/coverage-score";

function makeRow(overrides: Partial<OrgRow> = {}): OrgRow {
  return {
    id: "o1",
    slug: "org-1",
    name: "Acme Corp",
    description: null,
    wikiId: null,
    orgType: null,
    wikiPageId: null,
    revenue: null,
    revenueNum: null,
    revenueDate: null,
    valuation: null,
    valuationNum: null,
    valuationDate: null,
    headcount: null,
    headcountDate: null,
    totalFunding: null,
    totalFundingNum: null,
    foundedDate: null,
    peopleCount: null,
    grantsGivenCount: null,
    completionScore: 1,
    verdictString: null,
    searchText: "",
    ...overrides,
  };
}

describe("getOrgSortValue", () => {
  it("returns lowercase name for 'name' key", () => {
    expect(getOrgSortValue(makeRow({ name: "OpenAI" }), "name")).toBe("openai");
  });

  it("returns orgType or empty string when null", () => {
    expect(
      getOrgSortValue(makeRow({ orgType: "frontier-lab" }), "orgType"),
    ).toBe("frontier-lab");
    expect(getOrgSortValue(makeRow({ orgType: null }), "orgType")).toBe("");
  });

  it("returns revenueNum", () => {
    expect(getOrgSortValue(makeRow({ revenueNum: 5e9 }), "revenue")).toBe(5e9);
    expect(getOrgSortValue(makeRow({ revenueNum: null }), "revenue")).toBe(
      null,
    );
  });

  it("returns valuationNum", () => {
    expect(
      getOrgSortValue(makeRow({ valuationNum: 100e9 }), "valuation"),
    ).toBe(100e9);
  });

  it("returns headcount", () => {
    expect(getOrgSortValue(makeRow({ headcount: 5000 }), "headcount")).toBe(
      5000,
    );
  });

  it("returns totalFundingNum", () => {
    expect(
      getOrgSortValue(makeRow({ totalFundingNum: 2e9 }), "totalFunding"),
    ).toBe(2e9);
  });

  it("returns foundedDate as string", () => {
    expect(
      getOrgSortValue(makeRow({ foundedDate: "2015-12-11" }), "founded"),
    ).toBe("2015-12-11");
    expect(getOrgSortValue(makeRow({ foundedDate: null }), "founded")).toBe(
      null,
    );
  });
});

describe("compareOrgRows", () => {
  describe("string sorting (name)", () => {
    it("sorts ascending by name", () => {
      const a = makeRow({ name: "Anthropic" });
      const b = makeRow({ name: "OpenAI" });
      expect(compareOrgRows(a, b, "name", "asc")).toBeLessThan(0);
    });

    it("sorts descending by name", () => {
      const a = makeRow({ name: "Anthropic" });
      const b = makeRow({ name: "OpenAI" });
      expect(compareOrgRows(a, b, "name", "desc")).toBeGreaterThan(0);
    });
  });

  describe("numeric sorting (revenue)", () => {
    it("sorts ascending by revenue", () => {
      const low = makeRow({ name: "A", revenueNum: 1e9 });
      const high = makeRow({ name: "B", revenueNum: 10e9 });
      expect(compareOrgRows(low, high, "revenue", "asc")).toBeLessThan(0);
    });

    it("sorts descending by revenue", () => {
      const low = makeRow({ name: "A", revenueNum: 1e9 });
      const high = makeRow({ name: "B", revenueNum: 10e9 });
      expect(compareOrgRows(low, high, "revenue", "desc")).toBeGreaterThan(0);
    });
  });

  describe("date sorting (founded)", () => {
    it("sorts date strings ascending (earlier first)", () => {
      const older = makeRow({ name: "A", foundedDate: "2010-01-01" });
      const newer = makeRow({ name: "B", foundedDate: "2020-06-15" });
      expect(compareOrgRows(older, newer, "founded", "asc")).toBeLessThan(0);
    });

    it("sorts date strings descending (newer first)", () => {
      const older = makeRow({ name: "A", foundedDate: "2010-01-01" });
      const newer = makeRow({ name: "B", foundedDate: "2020-06-15" });
      expect(compareOrgRows(older, newer, "founded", "desc")).toBeGreaterThan(0);
    });
  });

  describe("null handling", () => {
    it("puts nulls last in ascending order", () => {
      const withValue = makeRow({ name: "A", revenueNum: 5e9 });
      const withNull = makeRow({ name: "B", revenueNum: null });
      expect(compareOrgRows(withValue, withNull, "revenue", "asc")).toBeLessThan(
        0,
      );
      expect(
        compareOrgRows(withNull, withValue, "revenue", "asc"),
      ).toBeGreaterThan(0);
    });

    it("puts nulls last in descending order", () => {
      const withValue = makeRow({ name: "A", revenueNum: 5e9 });
      const withNull = makeRow({ name: "B", revenueNum: null });
      expect(
        compareOrgRows(withValue, withNull, "revenue", "desc"),
      ).toBeLessThan(0);
      expect(
        compareOrgRows(withNull, withValue, "revenue", "desc"),
      ).toBeGreaterThan(0);
    });

    it("treats two nulls as equal", () => {
      const a = makeRow({ name: "A", revenueNum: null });
      const b = makeRow({ name: "B", revenueNum: null });
      expect(compareOrgRows(a, b, "revenue", "asc")).toBe(0);
    });

    it("handles null foundedDate", () => {
      const withDate = makeRow({ name: "A", foundedDate: "2015-01-01" });
      const noDate = makeRow({ name: "B", foundedDate: null });
      expect(compareOrgRows(withDate, noDate, "founded", "asc")).toBeLessThan(
        0,
      );
    });
  });

  describe("orgType sorting", () => {
    it("sorts orgType as string", () => {
      const a = makeRow({ name: "A", orgType: "academic" });
      const b = makeRow({ name: "B", orgType: "startup" });
      expect(compareOrgRows(a, b, "orgType", "asc")).toBeLessThan(0);
    });

    it("treats null orgType as empty string (not null)", () => {
      // orgType maps null to "" (not null), so it should sort normally
      const withType = makeRow({ name: "A", orgType: "frontier-lab" });
      const noType = makeRow({ name: "B", orgType: null });
      // "" sorts before "frontier-lab"
      expect(compareOrgRows(noType, withType, "orgType", "asc")).toBeLessThan(
        0,
      );
    });
  });

  describe("peopleCount sorting", () => {
    it("sorts by peopleCount ascending", () => {
      const low = makeRow({ name: "A", peopleCount: 5 });
      const high = makeRow({ name: "B", peopleCount: 50 });
      expect(compareOrgRows(low, high, "peopleCount", "asc")).toBeLessThan(0);
    });

    it("puts null peopleCount last in ascending order", () => {
      const withCount = makeRow({ name: "A", peopleCount: 5 });
      const noCount = makeRow({ name: "B", peopleCount: null });
      expect(compareOrgRows(withCount, noCount, "peopleCount", "asc")).toBeLessThan(0);
    });
  });

  describe("grantsGiven sorting", () => {
    it("returns grantsGivenCount via getOrgSortValue", () => {
      expect(
        getOrgSortValue(makeRow({ grantsGivenCount: 27 }), "grantsGiven"),
      ).toBe(27);
      expect(
        getOrgSortValue(makeRow({ grantsGivenCount: null }), "grantsGiven"),
      ).toBe(null);
      expect(
        getOrgSortValue(makeRow({ grantsGivenCount: 0 }), "grantsGiven"),
      ).toBe(0);
    });

    it("sorts by grantsGivenCount ascending", () => {
      const low = makeRow({ name: "A", grantsGivenCount: 3 });
      const high = makeRow({ name: "B", grantsGivenCount: 100 });
      expect(compareOrgRows(low, high, "grantsGiven", "asc")).toBeLessThan(0);
    });

    it("sorts by grantsGivenCount descending (funders first)", () => {
      const nonFunder = makeRow({ name: "A", grantsGivenCount: 0 });
      const funder = makeRow({ name: "B", grantsGivenCount: 50 });
      expect(compareOrgRows(funder, nonFunder, "grantsGiven", "desc")).toBeLessThan(0);
    });

    it("puts null grantsGivenCount last in ascending order", () => {
      const withCount = makeRow({ name: "A", grantsGivenCount: 5 });
      const noCount = makeRow({ name: "B", grantsGivenCount: null });
      expect(
        compareOrgRows(withCount, noCount, "grantsGiven", "asc"),
      ).toBeLessThan(0);
    });

    it("treats 0 as a real value (sorted before positive counts in asc)", () => {
      const zero = makeRow({ name: "A", grantsGivenCount: 0 });
      const some = makeRow({ name: "B", grantsGivenCount: 5 });
      expect(compareOrgRows(zero, some, "grantsGiven", "asc")).toBeLessThan(0);
    });
  });

  describe("completionScore sorting", () => {
    it("sorts by completionScore descending", () => {
      const low = makeRow({ name: "A", completionScore: 1 });
      const high = makeRow({ name: "B", completionScore: 4 });
      expect(compareOrgRows(low, high, "completionScore", "desc")).toBeGreaterThan(0);
    });

    it("sorts by completionScore ascending", () => {
      const low = makeRow({ name: "A", completionScore: 1 });
      const high = makeRow({ name: "B", completionScore: 4 });
      expect(compareOrgRows(low, high, "completionScore", "asc")).toBeLessThan(0);
    });
  });

  describe("sorting an array", () => {
    it("sorts by revenue descending with nulls last", () => {
      const rows = [
        makeRow({ id: "1", name: "Small", revenueNum: 1e9 }),
        makeRow({ id: "2", name: "NoRev", revenueNum: null }),
        makeRow({ id: "3", name: "Big", revenueNum: 50e9 }),
      ];

      const sorted = [...rows].sort((a, b) =>
        compareOrgRows(a, b, "revenue", "desc"),
      );
      expect(sorted.map((r) => r.id)).toEqual(["3", "1", "2"]);
    });

    it("sorts names alphabetically ascending", () => {
      const rows = [
        makeRow({ id: "1", name: "OpenAI" }),
        makeRow({ id: "2", name: "Anthropic" }),
        makeRow({ id: "3", name: "DeepMind" }),
      ];

      const sorted = [...rows].sort((a, b) =>
        compareOrgRows(a, b, "name", "asc"),
      );
      expect(sorted.map((r) => r.name)).toEqual([
        "Anthropic",
        "DeepMind",
        "OpenAI",
      ]);
    });
  });
});

describe("computeOrgCoverage", () => {
  it("returns 1 for name-only org (no data)", () => {
    expect(computeOrgCoverage({})).toBe(1);
    expect(computeOrgCoverage({ revenueNum: null, headcount: null })).toBe(1);
  });

  it("returns 2 for 2 signals (e.g. revenue + founded)", () => {
    expect(computeOrgCoverage({ revenueNum: 1e9, foundedDate: "2020" })).toBe(2);
    expect(computeOrgCoverage({ headcount: 100, foundedDate: "2020" })).toBe(2);
  });

  it("returns 3 for 4+ signals", () => {
    expect(computeOrgCoverage({
      revenueNum: 1e9, headcount: 100, foundedDate: "2020", wikiPageId: "E42",
    })).toBe(3);
  });

  it("returns 4 for 6+ signals (rich org)", () => {
    expect(computeOrgCoverage({
      revenueNum: 1e9, valuationNum: 10e9, headcount: 100,
      totalFundingNum: 5e6, foundedDate: "2020", peopleCount: 10, wikiPageId: "E42",
    })).toBe(4);
  });

  it("counts people thresholds: 10+ gives 1 signal", () => {
    expect(computeOrgCoverage({ peopleCount: 2 })).toBe(1);
    // 3 people below threshold (10), foundedDate = 1 signal → score 1
    expect(computeOrgCoverage({ peopleCount: 3, foundedDate: "2020" })).toBe(1);
    // 10 people = 1 signal, foundedDate = 1 signal → 2 signals → score 2
    expect(computeOrgCoverage({ peopleCount: 10, foundedDate: "2020" })).toBe(2);
  });

  // QUA-867 item D — orgs evaluated by external scorecards earn coverage
  // signals even when their financial metadata is sparse. A frontier lab
  // rated by every scorecard but missing revenue/valuation/headcount used
  // to score 1 ("stub") despite being one of the most-evaluated entities
  // in the wiki.
  describe("externalScorecardCount signal (QUA-867)", () => {
    it("does not credit zero scorecards", () => {
      expect(computeOrgCoverage({ externalScorecardCount: 0 })).toBe(1);
      expect(computeOrgCoverage({ externalScorecardCount: null })).toBe(1);
    });

    it("1 scorecard adds one signal", () => {
      // Alone it's just 1 signal — score stays 1.
      expect(computeOrgCoverage({ externalScorecardCount: 1 })).toBe(1);
      // With foundedDate (1 signal) + 1 scorecard = 2 signals → score 2.
      expect(
        computeOrgCoverage({
          externalScorecardCount: 1,
          foundedDate: "2020",
        }),
      ).toBe(2);
    });

    it("2 scorecards stays at 1 signal (in-between band)", () => {
      // 2 scorecards = 1 signal (≥1 only). With foundedDate = 2 signals → 2.
      // The ≥3 tier is for "frontier-lab" coverage, not just "more than one."
      expect(computeOrgCoverage({ externalScorecardCount: 2 })).toBe(1);
      expect(
        computeOrgCoverage({
          externalScorecardCount: 2,
          foundedDate: "2020",
        }),
      ).toBe(2);
    });

    it("3+ scorecards adds two signals (frontier-lab tier)", () => {
      // 3 scorecards = 2 signals (≥1 + ≥3) → score 2.
      expect(computeOrgCoverage({ externalScorecardCount: 3 })).toBe(2);
      // 5 scorecards = 2 signals + foundedDate = 3 → score 3.
      expect(
        computeOrgCoverage({
          externalScorecardCount: 5,
          foundedDate: "2020",
        }),
      ).toBe(3);
    });

    it("rescues a frontier lab with no financial metadata", () => {
      // Exactly the case the audit flagged: no revenue / valuation /
      // headcount / total-funding, but rated by all 5 scorecards. Used to
      // score 1 (stub). Now scores 3 (5 scorecards = 2, foundedDate = 1,
      // wikiPageId = 1 → 4 signals).
      expect(
        computeOrgCoverage({
          externalScorecardCount: 5,
          foundedDate: "2021",
          wikiPageId: "E1234",
        }),
      ).toBe(3);
    });
  });
});

// QUA-867 item D — getOrgSignals feeds the coverage popover on the org
// profile. Untested before this PR; new external-scorecard branch
// requires explicit coverage so a regression doesn't silently mis-label.
describe("getOrgSignals", () => {
  it("returns no scorecard signal when count is 0 or null", () => {
    expect(getOrgSignals({})).not.toContain("0 external scorecards");
    expect(getOrgSignals({ externalScorecardCount: 0 })).not.toContain(
      "external scorecard",
    );
    expect(getOrgSignals({ externalScorecardCount: null })).not.toContain(
      "external scorecard",
    );
  });

  it("uses the singular form for exactly 1 scorecard", () => {
    const signals = getOrgSignals({ externalScorecardCount: 1 });
    expect(signals).toContain("1 external scorecard");
    expect(signals).not.toContain("1 external scorecards");
  });

  it("uses the plural form for 2+ scorecards", () => {
    expect(getOrgSignals({ externalScorecardCount: 2 })).toContain(
      "2 external scorecards",
    );
    expect(getOrgSignals({ externalScorecardCount: 5 })).toContain(
      "5 external scorecards",
    );
  });

  it("includes the standard signals alongside scorecard count", () => {
    const signals = getOrgSignals({
      revenueNum: 1e9,
      foundedDate: "2020",
      wikiPageId: "E42",
      externalScorecardCount: 3,
    });
    expect(signals).toEqual([
      "Revenue",
      "Founded date",
      "Wiki page",
      "3 external scorecards",
    ]);
  });
});
