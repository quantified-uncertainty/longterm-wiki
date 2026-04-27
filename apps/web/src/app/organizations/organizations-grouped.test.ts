import { describe, it, expect } from "vitest";
import { bucketOrgs, splitFeatured } from "./organizations-grouped";
import type { OrgRow } from "./organizations-table";

function org(partial: Partial<OrgRow> & Pick<OrgRow, "id" | "name">): OrgRow {
  return {
    slug: partial.id,
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
    completionScore: 1,
    verdictString: null,
    searchText: "",
    ...partial,
  };
}

// Minimal column shape that matches what splitFeatured needs.
const HEADCOUNT_COL = {
  key: "headcount",
  label: "Headcount",
  render: (r: OrgRow) => r.headcount,
  has: (r: OrgRow) => r.headcount != null,
};
const VALUATION_COL = {
  key: "valuation",
  label: "Valuation",
  render: (r: OrgRow) => r.valuationNum,
  has: (r: OrgRow) => r.valuationNum != null,
};
const FOUNDED_COL = {
  key: "founded",
  label: "Founded",
  render: (r: OrgRow) => r.foundedDate,
  has: (r: OrgRow) => Boolean(r.foundedDate),
};
const cols = [HEADCOUNT_COL, VALUATION_COL, FOUNDED_COL];

describe("bucketOrgs", () => {
  it("groups rows by orgType", () => {
    const rows = [
      org({ id: "a", name: "Anthropic", orgType: "frontier-lab" }),
      org({ id: "b", name: "OpenAI", orgType: "frontier-lab" }),
      org({ id: "c", name: "OP", orgType: "funder" }),
    ];
    const map = bucketOrgs(rows);
    expect(map.get("frontier-lab")?.map((r) => r.id)).toEqual(["a", "b"]);
    expect(map.get("funder")?.map((r) => r.id)).toEqual(["c"]);
  });

  it("folds unknown / 'other' orgTypes into the generic catchall", () => {
    const rows = [
      org({ id: "x", name: "X", orgType: "weird-new-type" }),
      org({ id: "y", name: "Y", orgType: null }),
      org({ id: "z", name: "Z", orgType: "other" }),
    ];
    const map = bucketOrgs(rows);
    expect(map.has("weird-new-type")).toBe(false);
    expect(map.get("generic")?.map((r) => r.id).sort()).toEqual(["x", "y", "z"]);
  });
});

describe("splitFeatured", () => {
  it("ranks orgs with rendered-column data above orgs without it", () => {
    const rows = [
      org({ id: "rich", name: "Rich", headcount: 100, valuationNum: 1e9, foundedDate: "2020" }),
      org({ id: "thin", name: "Thin" }), // no rendered cells
      org({ id: "ok", name: "Ok", headcount: 10 }),
    ];
    const { featured, trailing } = splitFeatured(rows, cols);
    // Rich (3 cells) > Ok (1 cell) > Thin (0 cells)
    expect(featured.map((r) => r.id)).toEqual(["rich", "ok"]);
    expect(trailing.map((r) => r.id)).toEqual(["thin"]);
  });

  it("treats description as a partial signal (boost over a totally empty row)", () => {
    const rows = [
      org({ id: "desc", name: "Desc", description: "We do alignment research." }),
      org({ id: "blank", name: "Blank" }),
    ];
    const { featured, trailing } = splitFeatured(rows, cols);
    expect(featured.map((r) => r.id)).toEqual(["desc"]);
    expect(trailing.map((r) => r.id)).toEqual(["blank"]);
  });

  it("falls back to top 4 when nothing has rendered data", () => {
    const rows = [
      org({ id: "a", name: "Aardvark", completionScore: 1 }),
      org({ id: "b", name: "Beaver", completionScore: 2 }),
      org({ id: "c", name: "Coyote", completionScore: 1 }),
      org({ id: "d", name: "Dingo", completionScore: 2 }),
      org({ id: "e", name: "Elk", completionScore: 1 }),
    ];
    const { featured, trailing } = splitFeatured(rows, cols);
    expect(featured).toHaveLength(4);
    // Top 4 by completionScore (then name)
    expect(featured[0].completionScore).toBe(2);
    expect(trailing).toHaveLength(1);
  });

  it("caps featured at 10 and ties break by completionScore then name", () => {
    const rows = Array.from({ length: 15 }, (_, i) =>
      org({
        id: `o${i}`,
        name: `O${i.toString().padStart(2, "0")}`,
        headcount: 10,
        valuationNum: 1e9,
        foundedDate: "2020",
        completionScore: 4,
      }),
    );
    const { featured, trailing } = splitFeatured(rows, cols);
    expect(featured).toHaveLength(10);
    expect(trailing).toHaveLength(5);
    // Names alphabetical when scores tie
    expect(featured.map((r) => r.id).slice(0, 3)).toEqual(["o0", "o1", "o2"]);
  });

  it("handles empty input", () => {
    const { featured, trailing } = splitFeatured([], cols);
    expect(featured).toEqual([]);
    expect(trailing).toEqual([]);
  });

  it("handles single-org input", () => {
    const rows = [org({ id: "only", name: "Only", headcount: 5 })];
    const { featured, trailing } = splitFeatured(rows, cols);
    expect(featured.map((r) => r.id)).toEqual(["only"]);
    expect(trailing).toEqual([]);
  });
});
