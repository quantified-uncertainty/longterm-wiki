import { describe, expect, it } from "vitest";

import type { PersonRow } from "./people-table";
import { isPersonMeaningful, partitionPersonRows } from "./people-filter";

function makeRow(overrides: Partial<PersonRow> = {}): PersonRow {
  return {
    id: "p1",
    slug: "person-1",
    name: "Test Person",
    wikiId: null,
    wikiPageId: null,
    role: null,
    employerId: null,
    employerName: null,
    employerSlug: null,
    bornYear: null,
    netWorthNum: null,
    positionCount: 0,
    topics: [],
    publicationCount: 0,
    careerHistoryCount: 0,
    searchText: "",
    ...overrides,
  };
}

describe("isPersonMeaningful", () => {
  it("returns false for a completely empty person", () => {
    expect(isPersonMeaningful(makeRow())).toBe(false);
  });

  it("returns false for a publication-only person", () => {
    expect(isPersonMeaningful(makeRow({ publicationCount: 5 }))).toBe(false);
  });

  it("returns true for a person with a role", () => {
    expect(isPersonMeaningful(makeRow({ role: "CEO" }))).toBe(true);
  });

  it("returns true for a person with an employer name", () => {
    expect(
      isPersonMeaningful(makeRow({ employerName: "Anthropic" })),
    ).toBe(true);
  });

  it("returns true for a person with an employer ID but no employer name", () => {
    expect(
      isPersonMeaningful(makeRow({ employerId: "org-123" })),
    ).toBe(true);
  });

  it("returns true for a person with a wiki page", () => {
    expect(isPersonMeaningful(makeRow({ wikiPageId: "E42" }))).toBe(true);
  });

  it("returns true for a person with career history", () => {
    expect(isPersonMeaningful(makeRow({ careerHistoryCount: 2 }))).toBe(true);
  });

  it("returns true for a person with expert positions", () => {
    expect(isPersonMeaningful(makeRow({ positionCount: 1 }))).toBe(true);
  });

  it("returns true when multiple criteria are met", () => {
    expect(
      isPersonMeaningful(
        makeRow({ role: "CTO", employerName: "DeepMind", careerHistoryCount: 3 }),
      ),
    ).toBe(true);
  });

  it("returns false for person with only bornYear and publications", () => {
    expect(
      isPersonMeaningful(makeRow({ bornYear: 1985, publicationCount: 10 })),
    ).toBe(false);
  });

  it("returns false for person with only netWorth", () => {
    expect(isPersonMeaningful(makeRow({ netWorthNum: 1e9 }))).toBe(false);
  });
});

describe("partitionPersonRows", () => {
  it("returns empty arrays for empty input", () => {
    const { meaningful, stubs } = partitionPersonRows([]);
    expect(meaningful).toEqual([]);
    expect(stubs).toEqual([]);
  });

  it("separates meaningful from stub entries", () => {
    const rows = [
      makeRow({ id: "a", name: "Alice", role: "CEO" }),
      makeRow({ id: "b", name: "Bob", publicationCount: 3 }),
      makeRow({ id: "c", name: "Charlie", careerHistoryCount: 1 }),
      makeRow({ id: "d", name: "Diana" }),
    ];
    const { meaningful, stubs } = partitionPersonRows(rows);
    expect(meaningful.map((r) => r.id)).toEqual(["a", "c"]);
    expect(stubs.map((r) => r.id)).toEqual(["b", "d"]);
  });

  it("places all rows in meaningful when all have data", () => {
    const rows = [
      makeRow({ id: "a", role: "Engineer" }),
      makeRow({ id: "b", wikiPageId: "E100" }),
    ];
    const { meaningful, stubs } = partitionPersonRows(rows);
    expect(meaningful).toHaveLength(2);
    expect(stubs).toHaveLength(0);
  });

  it("places all rows in stubs when none have data", () => {
    const rows = [
      makeRow({ id: "a", publicationCount: 2 }),
      makeRow({ id: "b" }),
    ];
    const { meaningful, stubs } = partitionPersonRows(rows);
    expect(meaningful).toHaveLength(0);
    expect(stubs).toHaveLength(2);
  });
});
