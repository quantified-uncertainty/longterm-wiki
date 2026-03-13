import { describe, expect, it } from "vitest";

import type { PersonRow } from "./people-table";
import {
  getPersonSortValue,
  comparePersonRows,
  type PeopleSortKey,
} from "./people-sort";

function makeRow(overrides: Partial<PersonRow> = {}): PersonRow {
  return {
    id: "p1",
    slug: "person-1",
    name: "Alice",
    numericId: null,
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

describe("getPersonSortValue", () => {
  it("returns lowercase name for 'name' key", () => {
    const row = makeRow({ name: "Bob Smith" });
    expect(getPersonSortValue(row, "name")).toBe("bob smith");
  });

  it("returns lowercase role or null", () => {
    expect(getPersonSortValue(makeRow({ role: "CEO" }), "role")).toBe("ceo");
    expect(getPersonSortValue(makeRow({ role: null }), "role")).toBe(null);
  });

  it("returns lowercase employer name or null", () => {
    expect(
      getPersonSortValue(makeRow({ employerName: "OpenAI" }), "employer"),
    ).toBe("openai");
    expect(
      getPersonSortValue(makeRow({ employerName: null }), "employer"),
    ).toBe(null);
  });

  it("returns bornYear directly", () => {
    expect(getPersonSortValue(makeRow({ bornYear: 1990 }), "bornYear")).toBe(
      1990,
    );
    expect(getPersonSortValue(makeRow({ bornYear: null }), "bornYear")).toBe(
      null,
    );
  });

  it("returns netWorthNum directly", () => {
    expect(
      getPersonSortValue(makeRow({ netWorthNum: 1e9 }), "netWorth"),
    ).toBe(1e9);
  });

  it("returns positionCount or null when zero", () => {
    expect(
      getPersonSortValue(makeRow({ positionCount: 3 }), "positions"),
    ).toBe(3);
    expect(
      getPersonSortValue(makeRow({ positionCount: 0 }), "positions"),
    ).toBe(null);
  });

  it("returns publicationCount or null when zero", () => {
    expect(
      getPersonSortValue(makeRow({ publicationCount: 5 }), "publications"),
    ).toBe(5);
    expect(
      getPersonSortValue(makeRow({ publicationCount: 0 }), "publications"),
    ).toBe(null);
  });

  it("returns careerHistoryCount or null when zero", () => {
    expect(
      getPersonSortValue(makeRow({ careerHistoryCount: 0 }), "careerHistory"),
    ).toBe(null);
    expect(
      getPersonSortValue(makeRow({ careerHistoryCount: 7 }), "careerHistory"),
    ).toBe(7);
  });
});

describe("comparePersonRows", () => {
  describe("string sorting (name)", () => {
    it("sorts ascending by name", () => {
      const alice = makeRow({ name: "Alice" });
      const bob = makeRow({ name: "Bob" });
      expect(comparePersonRows(alice, bob, "name", "asc")).toBeLessThan(0);
      expect(comparePersonRows(bob, alice, "name", "asc")).toBeGreaterThan(0);
    });

    it("sorts descending by name", () => {
      const alice = makeRow({ name: "Alice" });
      const bob = makeRow({ name: "Bob" });
      expect(comparePersonRows(alice, bob, "name", "desc")).toBeGreaterThan(0);
      expect(comparePersonRows(bob, alice, "name", "desc")).toBeLessThan(0);
    });

    it("is case-insensitive", () => {
      const lower = makeRow({ name: "alice" });
      const upper = makeRow({ name: "Alice" });
      expect(comparePersonRows(lower, upper, "name", "asc")).toBe(0);
    });
  });

  describe("numeric sorting (bornYear)", () => {
    it("sorts ascending by bornYear", () => {
      const older = makeRow({ name: "A", bornYear: 1960 });
      const younger = makeRow({ name: "B", bornYear: 1990 });
      expect(comparePersonRows(older, younger, "bornYear", "asc")).toBeLessThan(
        0,
      );
    });

    it("sorts descending by bornYear", () => {
      const older = makeRow({ name: "A", bornYear: 1960 });
      const younger = makeRow({ name: "B", bornYear: 1990 });
      expect(
        comparePersonRows(older, younger, "bornYear", "desc"),
      ).toBeGreaterThan(0);
    });
  });

  describe("numeric sorting (netWorth)", () => {
    it("sorts ascending by net worth", () => {
      const poor = makeRow({ name: "A", netWorthNum: 1e6 });
      const rich = makeRow({ name: "B", netWorthNum: 1e9 });
      expect(comparePersonRows(poor, rich, "netWorth", "asc")).toBeLessThan(0);
    });

    it("sorts descending by net worth", () => {
      const poor = makeRow({ name: "A", netWorthNum: 1e6 });
      const rich = makeRow({ name: "B", netWorthNum: 1e9 });
      expect(comparePersonRows(poor, rich, "netWorth", "desc")).toBeGreaterThan(
        0,
      );
    });
  });

  describe("null handling", () => {
    it("puts nulls last in ascending order", () => {
      const withValue = makeRow({ name: "A", bornYear: 1990 });
      const withNull = makeRow({ name: "B", bornYear: null });
      expect(
        comparePersonRows(withValue, withNull, "bornYear", "asc"),
      ).toBeLessThan(0);
      expect(
        comparePersonRows(withNull, withValue, "bornYear", "asc"),
      ).toBeGreaterThan(0);
    });

    it("puts nulls last in descending order", () => {
      const withValue = makeRow({ name: "A", bornYear: 1990 });
      const withNull = makeRow({ name: "B", bornYear: null });
      expect(
        comparePersonRows(withValue, withNull, "bornYear", "desc"),
      ).toBeLessThan(0);
      expect(
        comparePersonRows(withNull, withValue, "bornYear", "desc"),
      ).toBeGreaterThan(0);
    });

    it("treats two nulls as equal", () => {
      const a = makeRow({ name: "A", bornYear: null });
      const b = makeRow({ name: "B", bornYear: null });
      expect(comparePersonRows(a, b, "bornYear", "asc")).toBe(0);
      expect(comparePersonRows(a, b, "bornYear", "desc")).toBe(0);
    });

    it("handles null strings (role, employer)", () => {
      const withRole = makeRow({ name: "A", role: "Engineer" });
      const noRole = makeRow({ name: "B", role: null });
      expect(comparePersonRows(withRole, noRole, "role", "asc")).toBeLessThan(
        0,
      );
      expect(comparePersonRows(noRole, withRole, "role", "asc")).toBeGreaterThan(
        0,
      );
    });
  });

  describe("sorting an array", () => {
    it("sorts a mixed array with nulls last", () => {
      const rows = [
        makeRow({ id: "1", name: "Charlie", bornYear: null }),
        makeRow({ id: "2", name: "Alice", bornYear: 1980 }),
        makeRow({ id: "3", name: "Bob", bornYear: 1970 }),
      ];

      const sorted = [...rows].sort((a, b) =>
        comparePersonRows(a, b, "bornYear", "asc"),
      );
      expect(sorted.map((r) => r.id)).toEqual(["3", "2", "1"]);
    });

    it("sorts descending with nulls last", () => {
      const rows = [
        makeRow({ id: "1", name: "Charlie", bornYear: null }),
        makeRow({ id: "2", name: "Alice", bornYear: 1980 }),
        makeRow({ id: "3", name: "Bob", bornYear: 1970 }),
      ];

      const sorted = [...rows].sort((a, b) =>
        comparePersonRows(a, b, "bornYear", "desc"),
      );
      expect(sorted.map((r) => r.id)).toEqual(["2", "3", "1"]);
    });

    it("sorts names alphabetically", () => {
      const rows = [
        makeRow({ id: "1", name: "Charlie" }),
        makeRow({ id: "2", name: "Alice" }),
        makeRow({ id: "3", name: "Bob" }),
      ];

      const sorted = [...rows].sort((a, b) =>
        comparePersonRows(a, b, "name", "asc"),
      );
      expect(sorted.map((r) => r.name)).toEqual(["Alice", "Bob", "Charlie"]);
    });
  });
});
