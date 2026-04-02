import { describe, it, expect } from "vitest";
import {
  computeFreshness,
  freshnessSortKey,
  type Freshness,
} from "./freshness";

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86400000).toISOString();
}

describe("computeFreshness", () => {
  it("returns 'static' for static update frequency", () => {
    expect(computeFreshness(daysAgo(1000), "static")).toBe("static");
    expect(computeFreshness(null, "static")).toBe("static");
  });

  it("returns 'unknown' when lastSnapshotAt is null", () => {
    expect(computeFreshness(null, "quarterly")).toBe("unknown");
  });

  it("returns 'unknown' when updateFrequency is null", () => {
    expect(computeFreshness(daysAgo(5), null)).toBe("unknown");
  });

  it("returns 'unknown' for unrecognized frequency", () => {
    expect(computeFreshness(daysAgo(5), "biweekly")).toBe("unknown");
  });

  describe("weekly (7 days)", () => {
    it("returns 'fresh' within 80% of period (< 5.6d)", () => {
      expect(computeFreshness(daysAgo(0), "weekly")).toBe("fresh");
      expect(computeFreshness(daysAgo(3), "weekly")).toBe("fresh");
      expect(computeFreshness(daysAgo(5), "weekly")).toBe("fresh");
    });

    it("returns 'due' between 80% and 120% of period (5.6d - 8.4d)", () => {
      expect(computeFreshness(daysAgo(6), "weekly")).toBe("due");
      expect(computeFreshness(daysAgo(7), "weekly")).toBe("due");
      expect(computeFreshness(daysAgo(8), "weekly")).toBe("due");
    });

    it("returns 'overdue' beyond 120% of period (> 8.4d)", () => {
      expect(computeFreshness(daysAgo(9), "weekly")).toBe("overdue");
      expect(computeFreshness(daysAgo(30), "weekly")).toBe("overdue");
    });
  });

  describe("quarterly (90 days)", () => {
    it("returns 'fresh' within 80% of period (< 72d)", () => {
      expect(computeFreshness(daysAgo(0), "quarterly")).toBe("fresh");
      expect(computeFreshness(daysAgo(50), "quarterly")).toBe("fresh");
      expect(computeFreshness(daysAgo(71), "quarterly")).toBe("fresh");
    });

    it("returns 'due' between 80% and 120% of period (72d - 108d)", () => {
      expect(computeFreshness(daysAgo(72), "quarterly")).toBe("due");
      expect(computeFreshness(daysAgo(90), "quarterly")).toBe("due");
      expect(computeFreshness(daysAgo(107), "quarterly")).toBe("due");
    });

    it("returns 'overdue' beyond 120% of period (> 108d)", () => {
      expect(computeFreshness(daysAgo(109), "quarterly")).toBe("overdue");
      expect(computeFreshness(daysAgo(200), "quarterly")).toBe("overdue");
    });
  });

  describe("annual (365 days)", () => {
    it("returns 'fresh' within 292d", () => {
      expect(computeFreshness(daysAgo(100), "annual")).toBe("fresh");
      expect(computeFreshness(daysAgo(291), "annual")).toBe("fresh");
    });

    it("returns 'due' between 292d and 438d", () => {
      expect(computeFreshness(daysAgo(300), "annual")).toBe("due");
      expect(computeFreshness(daysAgo(365), "annual")).toBe("due");
    });

    it("returns 'overdue' beyond 438d", () => {
      expect(computeFreshness(daysAgo(439), "annual")).toBe("overdue");
    });
  });
});

describe("freshnessSortKey", () => {
  it("sorts overdue before due before unknown before static before fresh", () => {
    const order: Freshness[] = ["overdue", "due", "unknown", "static", "fresh"];
    const sorted = [...order].sort(
      (a, b) => freshnessSortKey(a) - freshnessSortKey(b),
    );
    expect(sorted).toEqual(order);
  });
});
