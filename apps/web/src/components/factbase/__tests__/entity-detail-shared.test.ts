import { describe, expect, it } from "vitest";

import type { FactBaseRecordEntry } from "@/data/factbase";

import {
  field,
  getPersonRecordName,
  getPropertyLabel,
  getRecordDisplayName,
  sortByDateField,
} from "../entity-detail-shared";

function makeEntry(overrides: Partial<FactBaseRecordEntry> = {}): FactBaseRecordEntry {
  return {
    key: "example-key",
    schema: "test-schema",
    ownerEntityId: "owner",
    fields: {},
    ...overrides,
  };
}

describe("field", () => {
  it("returns the string value when set", () => {
    const item = makeEntry({ fields: { name: "Series A" } });
    expect(field(item, "name")).toBe("Series A");
  });

  it("returns undefined when value is null", () => {
    const item = makeEntry({ fields: { name: null } });
    expect(field(item, "name")).toBeUndefined();
  });

  it("returns undefined when value is missing", () => {
    expect(field(makeEntry(), "name")).toBeUndefined();
  });

  it("coerces non-string values to string", () => {
    const item = makeEntry({ fields: { count: 42, flag: true } });
    expect(field(item, "count")).toBe("42");
    expect(field(item, "flag")).toBe("true");
  });
});

describe("getRecordDisplayName", () => {
  it("uses the explicit name field when set", () => {
    const item = makeEntry({ key: "series-a", fields: { name: "Series A Round" } });
    expect(getRecordDisplayName(item)).toBe("Series A Round");
  });

  it("falls back to title-cased key when name is missing", () => {
    const item = makeEntry({ key: "series-a-round" });
    expect(getRecordDisplayName(item)).toBe("Series A Round");
  });

  it("falls back when name is explicitly null", () => {
    const item = makeEntry({ key: "model-3", fields: { name: null } });
    expect(getRecordDisplayName(item)).toBe("Model 3");
  });

  it("falls back when name is an empty string (truthy semantics)", () => {
    const item = makeEntry({ key: "round-x", fields: { name: "" } });
    expect(getRecordDisplayName(item)).toBe("Round X");
  });

  it("falls back when name is 0 or false", () => {
    expect(getRecordDisplayName(makeEntry({ key: "round-y", fields: { name: 0 } }))).toBe("Round Y");
    expect(getRecordDisplayName(makeEntry({ key: "round-z", fields: { name: false } }))).toBe("Round Z");
  });

  it("falls back when name is an array or object (no '[object Object]' / 'A,B' leak)", () => {
    expect(getRecordDisplayName(makeEntry({ key: "round-q", fields: { name: ["A", "B"] } }))).toBe("Round Q");
    expect(getRecordDisplayName(makeEntry({ key: "round-w", fields: { name: { a: 1 } } }))).toBe("Round W");
  });

  it("handles snake_case keys", () => {
    const item = makeEntry({ key: "claude_3_opus" });
    expect(getRecordDisplayName(item)).toBe("Claude 3 Opus");
  });

  it("returns empty-derived label for empty key with no name", () => {
    const item = makeEntry({ key: "" });
    expect(getRecordDisplayName(item)).toBe("");
  });
});

describe("getPersonRecordName", () => {
  it("prefers the linked entity's name", () => {
    const item = makeEntry({
      key: "alice-smith",
      displayName: "Alice (alt)",
      fields: { display_name: "Alice (older alt)" },
    });
    expect(getPersonRecordName(item, { name: "Alice Smith" })).toBe("Alice Smith");
  });

  it("falls back to displayName when entity is null", () => {
    const item = makeEntry({ key: "bob", displayName: "Bob Jones" });
    expect(getPersonRecordName(item, null)).toBe("Bob Jones");
  });

  it("falls back to displayName when entity is undefined", () => {
    const item = makeEntry({ key: "bob", displayName: "Bob Jones" });
    expect(getPersonRecordName(item)).toBe("Bob Jones");
  });

  it("falls back to display_name field when displayName is unset", () => {
    const item = makeEntry({ key: "carol", fields: { display_name: "Carol Doe" } });
    expect(getPersonRecordName(item)).toBe("Carol Doe");
  });

  it("falls back to title-cased key when nothing else is set", () => {
    const item = makeEntry({ key: "dave-eggers" });
    expect(getPersonRecordName(item)).toBe("Dave Eggers");
  });

  it("falls through empty-string entity name to next rung", () => {
    // Defensive: an entity with an empty-string name shouldn't be picked.
    const item = makeEntry({ key: "ed", displayName: "Ed (alt)" });
    expect(getPersonRecordName(item, { name: "" })).toBe("Ed (alt)");
  });

  it("falls through empty displayName to display_name field", () => {
    const item = makeEntry({ key: "fern", displayName: "", fields: { display_name: "Fern Doe" } });
    expect(getPersonRecordName(item)).toBe("Fern Doe");
  });

  it("rejects array/object display_name (no garbage labels)", () => {
    const item = makeEntry({ key: "gabe", fields: { display_name: ["A", "B"] } });
    expect(getPersonRecordName(item)).toBe("Gabe");
  });
});

describe("getPropertyLabel", () => {
  it("uses the property's name when set", () => {
    expect(getPropertyLabel({ name: "Headcount" }, "headcount")).toBe("Headcount");
  });

  it("falls back to title-cased property ID when prop is undefined", () => {
    expect(getPropertyLabel(undefined, "total-funding")).toBe("Total Funding");
  });

  it("falls back when prop is null", () => {
    expect(getPropertyLabel(null, "founded-date")).toBe("Founded Date");
  });

  it("falls back when prop has no name", () => {
    expect(getPropertyLabel({ name: null }, "context-window")).toBe("Context Window");
  });

  it("falls back when prop has empty-string name (truthy semantics)", () => {
    expect(getPropertyLabel({ name: "" }, "valuation")).toBe("Valuation");
  });

  it("handles snake_case property IDs", () => {
    expect(getPropertyLabel(undefined, "developed_by")).toBe("Developed By");
  });
});

describe("sortByDateField", () => {
  it("sorts items by a date field newest-first", () => {
    const items = [
      makeEntry({ key: "a", fields: { date: "2023-01-01" } }),
      makeEntry({ key: "b", fields: { date: "2024-06-15" } }),
      makeEntry({ key: "c", fields: { date: "2024-01-01" } }),
    ];
    expect(sortByDateField(items, "date").map((i) => i.key)).toEqual(["b", "c", "a"]);
  });

  it("places items with missing date fields at the end", () => {
    const items = [
      makeEntry({ key: "a", fields: { date: "2024-01-01" } }),
      makeEntry({ key: "b", fields: {} }),
      makeEntry({ key: "c", fields: { date: "2025-06-01" } }),
    ];
    // empty strings sort lexicographically below years, so "b" lands last.
    expect(sortByDateField(items, "date").map((i) => i.key)).toEqual(["c", "a", "b"]);
  });

  it("does not mutate the input array", () => {
    const items = [
      makeEntry({ key: "a", fields: { date: "2023" } }),
      makeEntry({ key: "b", fields: { date: "2024" } }),
    ];
    const original = items.map((i) => i.key);
    sortByDateField(items, "date");
    expect(items.map((i) => i.key)).toEqual(original);
  });
});
