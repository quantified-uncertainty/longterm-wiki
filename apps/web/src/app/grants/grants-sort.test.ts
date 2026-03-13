import { describe, expect, it } from "vitest";

import type { GrantRow } from "./grants-table";
import { getGrantSortValue, compareGrantRows } from "./grants-sort";

function makeRow(overrides: Partial<GrantRow> = {}): GrantRow {
  return {
    compositeKey: "g1-key",
    recordKey: "grant-key",
    name: "Research Grant",
    organizationId: "org1",
    organizationName: "Open Philanthropy",
    organizationSlug: null,
    organizationWikiPageId: null,
    recipient: null,
    recipientName: null,
    recipientSlug: null,
    recipientWikiPageId: null,
    program: null,
    amount: null,
    period: null,
    date: null,
    status: null,
    source: null,
    ...overrides,
  };
}

describe("getGrantSortValue", () => {
  it("returns lowercase name for 'name' key", () => {
    expect(getGrantSortValue(makeRow({ name: "AI Safety" }), "name")).toBe(
      "ai safety",
    );
  });

  it("returns lowercase organization name", () => {
    expect(
      getGrantSortValue(
        makeRow({ organizationName: "Open Philanthropy" }),
        "organization",
      ),
    ).toBe("open philanthropy");
  });

  it("returns lowercase recipient or null", () => {
    expect(
      getGrantSortValue(makeRow({ recipient: "MIT" }), "recipient"),
    ).toBe("mit");
    expect(
      getGrantSortValue(makeRow({ recipient: null }), "recipient"),
    ).toBe(null);
  });

  it("prefers recipientName over recipient for sorting", () => {
    expect(
      getGrantSortValue(
        makeRow({ recipient: "some-id", recipientName: "University of Oxford" }),
        "recipient",
      ),
    ).toBe("university of oxford");
  });

  it("returns lowercase program or null", () => {
    expect(
      getGrantSortValue(makeRow({ program: "AI Safety" }), "program"),
    ).toBe("ai safety");
    expect(getGrantSortValue(makeRow({ program: null }), "program")).toBe(null);
  });

  it("returns amount as number", () => {
    expect(getGrantSortValue(makeRow({ amount: 500000 }), "amount")).toBe(
      500000,
    );
    expect(getGrantSortValue(makeRow({ amount: null }), "amount")).toBe(null);
  });

  it("returns period as string", () => {
    expect(
      getGrantSortValue(makeRow({ period: "2023-2025" }), "period"),
    ).toBe("2023-2025");
    expect(getGrantSortValue(makeRow({ period: null }), "period")).toBe(null);
  });

  it("returns date as string", () => {
    expect(
      getGrantSortValue(makeRow({ date: "2024-01-15" }), "date"),
    ).toBe("2024-01-15");
    expect(getGrantSortValue(makeRow({ date: null }), "date")).toBe(null);
  });

  it("returns status as string", () => {
    expect(getGrantSortValue(makeRow({ status: "active" }), "status")).toBe(
      "active",
    );
    expect(getGrantSortValue(makeRow({ status: null }), "status")).toBe(null);
  });
});

describe("compareGrantRows", () => {
  describe("string sorting (name)", () => {
    it("sorts ascending by name", () => {
      const a = makeRow({ name: "AI Grant" });
      const b = makeRow({ name: "Biosecurity Grant" });
      expect(compareGrantRows(a, b, "name", "asc")).toBeLessThan(0);
    });

    it("sorts descending by name", () => {
      const a = makeRow({ name: "AI Grant" });
      const b = makeRow({ name: "Biosecurity Grant" });
      expect(compareGrantRows(a, b, "name", "desc")).toBeGreaterThan(0);
    });

    it("is case-insensitive for name", () => {
      const a = makeRow({ name: "ai grant" });
      const b = makeRow({ name: "AI Grant" });
      expect(compareGrantRows(a, b, "name", "asc")).toBe(0);
    });
  });

  describe("numeric sorting (amount)", () => {
    it("sorts ascending by amount", () => {
      const small = makeRow({ name: "A", amount: 10000 });
      const large = makeRow({ name: "B", amount: 5000000 });
      expect(compareGrantRows(small, large, "amount", "asc")).toBeLessThan(0);
    });

    it("sorts descending by amount", () => {
      const small = makeRow({ name: "A", amount: 10000 });
      const large = makeRow({ name: "B", amount: 5000000 });
      expect(compareGrantRows(small, large, "amount", "desc")).toBeGreaterThan(
        0,
      );
    });
  });

  describe("date sorting", () => {
    it("sorts date strings ascending (earlier first)", () => {
      const earlier = makeRow({ name: "A", date: "2022-03-01" });
      const later = makeRow({ name: "B", date: "2024-07-15" });
      expect(compareGrantRows(earlier, later, "date", "asc")).toBeLessThan(0);
    });

    it("sorts date strings descending (later first)", () => {
      const earlier = makeRow({ name: "A", date: "2022-03-01" });
      const later = makeRow({ name: "B", date: "2024-07-15" });
      expect(compareGrantRows(earlier, later, "date", "desc")).toBeGreaterThan(
        0,
      );
    });
  });

  describe("null handling", () => {
    it("puts nulls last in ascending order", () => {
      const withAmount = makeRow({ name: "A", amount: 100000 });
      const noAmount = makeRow({ name: "B", amount: null });
      expect(
        compareGrantRows(withAmount, noAmount, "amount", "asc"),
      ).toBeLessThan(0);
      expect(
        compareGrantRows(noAmount, withAmount, "amount", "asc"),
      ).toBeGreaterThan(0);
    });

    it("puts nulls last in descending order", () => {
      const withAmount = makeRow({ name: "A", amount: 100000 });
      const noAmount = makeRow({ name: "B", amount: null });
      expect(
        compareGrantRows(withAmount, noAmount, "amount", "desc"),
      ).toBeLessThan(0);
      expect(
        compareGrantRows(noAmount, withAmount, "amount", "desc"),
      ).toBeGreaterThan(0);
    });

    it("treats two nulls as equal", () => {
      const a = makeRow({ name: "A", amount: null });
      const b = makeRow({ name: "B", amount: null });
      expect(compareGrantRows(a, b, "amount", "asc")).toBe(0);
      expect(compareGrantRows(a, b, "amount", "desc")).toBe(0);
    });

    it("handles null recipient strings", () => {
      const withRecipient = makeRow({ name: "A", recipient: "MIT" });
      const noRecipient = makeRow({ name: "B", recipient: null });
      expect(
        compareGrantRows(withRecipient, noRecipient, "recipient", "asc"),
      ).toBeLessThan(0);
    });

    it("handles null date", () => {
      const withDate = makeRow({ name: "A", date: "2023-01-01" });
      const noDate = makeRow({ name: "B", date: null });
      expect(
        compareGrantRows(withDate, noDate, "date", "asc"),
      ).toBeLessThan(0);
      expect(
        compareGrantRows(noDate, withDate, "date", "desc"),
      ).toBeGreaterThan(0);
    });

    it("handles null status", () => {
      const withStatus = makeRow({ name: "A", status: "active" });
      const noStatus = makeRow({ name: "B", status: null });
      expect(
        compareGrantRows(withStatus, noStatus, "status", "asc"),
      ).toBeLessThan(0);
    });
  });

  describe("sorting an array", () => {
    it("sorts by amount descending with nulls last", () => {
      const rows = [
        makeRow({ compositeKey: "1", name: "Small", amount: 50000 }),
        makeRow({ compositeKey: "2", name: "None", amount: null }),
        makeRow({ compositeKey: "3", name: "Large", amount: 10000000 }),
        makeRow({ compositeKey: "4", name: "Medium", amount: 500000 }),
      ];

      const sorted = [...rows].sort((a, b) =>
        compareGrantRows(a, b, "amount", "desc"),
      );
      expect(sorted.map((r) => r.compositeKey)).toEqual(["3", "4", "1", "2"]);
    });

    it("sorts by date ascending with nulls last", () => {
      const rows = [
        makeRow({ compositeKey: "1", name: "C", date: "2024-06-01" }),
        makeRow({ compositeKey: "2", name: "A", date: null }),
        makeRow({ compositeKey: "3", name: "B", date: "2022-01-15" }),
      ];

      const sorted = [...rows].sort((a, b) =>
        compareGrantRows(a, b, "date", "asc"),
      );
      expect(sorted.map((r) => r.compositeKey)).toEqual(["3", "1", "2"]);
    });

    it("sorts organization names alphabetically", () => {
      const rows = [
        makeRow({
          compositeKey: "1",
          name: "G1",
          organizationName: "Open Philanthropy",
        }),
        makeRow({
          compositeKey: "2",
          name: "G2",
          organizationName: "Good Ventures",
        }),
        makeRow({
          compositeKey: "3",
          name: "G3",
          organizationName: "Anthropic",
        }),
      ];

      const sorted = [...rows].sort((a, b) =>
        compareGrantRows(a, b, "organization", "asc"),
      );
      expect(sorted.map((r) => r.organizationName)).toEqual([
        "Anthropic",
        "Good Ventures",
        "Open Philanthropy",
      ]);
    });
  });
});
