import { describe, expect, it } from "vitest";
import {
  filterVisibleFacets,
  formatFacetTextContent,
} from "../filter-shared";

describe("formatFacetTextContent", () => {
  it("returns just the label when count is undefined", () => {
    expect(formatFacetTextContent("All")).toBe("All");
  });

  it("returns 'label (count)' with a real space separator", () => {
    // Closes QUA-918 — string contains the space text node, not just CSS margin.
    expect(formatFacetTextContent("Enacted", 18)).toBe("Enacted (18)");
  });

  it("renders a count of 0 (callers may rely on this for raw access)", () => {
    expect(formatFacetTextContent("Vetoed", 0)).toBe("Vetoed (0)");
  });

  it("preserves spaces inside the label", () => {
    expect(formatFacetTextContent("Convertible Note", 3)).toBe(
      "Convertible Note (3)",
    );
  });

  it("handles big counts unchanged", () => {
    expect(formatFacetTextContent("Models", 12345)).toBe("Models (12345)");
  });
});

describe("filterVisibleFacets", () => {
  const items = [
    { key: "a", label: "A", count: 5 },
    { key: "b", label: "B", count: 0 },
    { key: "c", label: "C", count: 10 },
    { key: "d", label: "D" }, // no count
  ];

  it("drops facets with count === 0 by default", () => {
    const result = filterVisibleFacets(items, {});
    expect(result.map((i) => i.key)).toEqual(["a", "c", "d"]);
  });

  it("keeps facets with no count", () => {
    const result = filterVisibleFacets(items, {});
    expect(result).toContainEqual({ key: "d", label: "D" });
  });

  it("drops tautology facets when hideTautologyFacets is set and total matches", () => {
    const result = filterVisibleFacets(items, {
      total: 10,
      hideTautologyFacets: true,
    });
    expect(result.map((i) => i.key)).toEqual(["a", "d"]);
    expect(result.find((i) => i.key === "c")).toBeUndefined();
  });

  it("does NOT drop tautology facets when hideTautologyFacets is false", () => {
    const result = filterVisibleFacets(items, {
      total: 10,
      hideTautologyFacets: false,
    });
    expect(result.map((i) => i.key)).toEqual(["a", "c", "d"]);
  });

  it("does nothing tautology-related when total is unset, even if flag is true", () => {
    const result = filterVisibleFacets(items, { hideTautologyFacets: true });
    expect(result.map((i) => i.key)).toEqual(["a", "c", "d"]);
  });

  it("returns empty array when all items are filtered out", () => {
    const all5 = [
      { key: "x", label: "X", count: 5 },
      { key: "y", label: "Y", count: 5 },
    ];
    expect(
      filterVisibleFacets(all5, { total: 5, hideTautologyFacets: true }),
    ).toEqual([]);
  });

  it("handles empty input", () => {
    expect(filterVisibleFacets([], {})).toEqual([]);
  });
});
