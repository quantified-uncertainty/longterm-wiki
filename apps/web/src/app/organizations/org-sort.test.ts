import { describe, expect, it } from "vitest";

import type { OrgRow } from "./organizations-table";
import { getOrgSortValue, compareOrgRows } from "./org-sort";

function makeRow(overrides: Partial<OrgRow> = {}): OrgRow {
  return {
    id: "o1",
    slug: "org-1",
    name: "Acme Corp",
    numericId: null,
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
