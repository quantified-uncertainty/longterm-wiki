import { describe, it, expect } from "vitest";
import {
  getMatchStats,
  getTopUnmatched,
  getIdCollisions,
  getByFunder,
} from "../analysis.ts";
import type { RawGrant, SyncGrant } from "../types.ts";

function makeRawGrant(overrides: Partial<RawGrant> = {}): RawGrant {
  return {
    source: "test",
    funderId: "funder-1",
    granteeName: "Test Org",
    granteeId: null,
    name: "Test Grant",
    amount: 100_000,
    date: "2024-01-01",
    focusArea: null,
    description: null,
    ...overrides,
  };
}

function makeSyncGrant(overrides: Partial<SyncGrant> = {}): SyncGrant {
  return {
    id: "grant-1",
    organizationId: "org-1",
    granteeId: null,
    name: "Test Grant",
    amount: 100_000,
    currency: "USD",
    date: "2024-01-01",
    status: null,
    source: "test",
    notes: null,
    ...overrides,
  };
}

describe("getMatchStats", () => {
  it("returns zeros for empty input", () => {
    const stats = getMatchStats([]);
    expect(stats).toEqual({
      total: 0,
      matched: 0,
      unmatched: 0,
      matchRate: 0,
      uniqueGranteeNames: 0,
      matchedGranteeNames: 0,
    });
  });

  it("computes correct stats for a mix of matched and unmatched grants", () => {
    const grants = [
      makeRawGrant({ granteeName: "Org A", granteeId: "entity-1" }),
      makeRawGrant({ granteeName: "Org A", granteeId: "entity-1" }),
      makeRawGrant({ granteeName: "Org B", granteeId: null }),
      makeRawGrant({ granteeName: "Org C", granteeId: "entity-3" }),
    ];

    const stats = getMatchStats(grants);
    expect(stats.total).toBe(4);
    expect(stats.matched).toBe(3);
    expect(stats.unmatched).toBe(1);
    expect(stats.matchRate).toBe(0.75);
    expect(stats.uniqueGranteeNames).toBe(3);
    expect(stats.matchedGranteeNames).toBe(2);
  });

  it("returns matchRate of 1 when all grants are matched", () => {
    const grants = [
      makeRawGrant({ granteeId: "entity-1" }),
      makeRawGrant({ granteeId: "entity-2" }),
    ];
    const stats = getMatchStats(grants);
    expect(stats.matchRate).toBe(1);
    expect(stats.unmatched).toBe(0);
  });

  it("returns matchRate of 0 when no grants are matched", () => {
    const grants = [
      makeRawGrant({ granteeId: null }),
      makeRawGrant({ granteeId: null }),
    ];
    const stats = getMatchStats(grants);
    expect(stats.matchRate).toBe(0);
    expect(stats.matched).toBe(0);
  });
});

describe("getTopUnmatched", () => {
  it("returns empty array when all grants are matched", () => {
    const grants = [
      makeRawGrant({ granteeId: "entity-1" }),
    ];
    expect(getTopUnmatched(grants)).toEqual([]);
  });

  it("aggregates unmatched grants by grantee name, sorted by total amount", () => {
    const grants = [
      makeRawGrant({ granteeName: "Small Org", granteeId: null, amount: 10_000 }),
      makeRawGrant({ granteeName: "Big Org", granteeId: null, amount: 500_000 }),
      makeRawGrant({ granteeName: "Big Org", granteeId: null, amount: 300_000 }),
      makeRawGrant({ granteeName: "Medium Org", granteeId: null, amount: 200_000 }),
      // This one is matched, so should be excluded
      makeRawGrant({ granteeName: "Matched Org", granteeId: "entity-1", amount: 1_000_000 }),
    ];

    const result = getTopUnmatched(grants);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ name: "Big Org", totalAmountUSD: 800_000, count: 2 });
    expect(result[1]).toEqual({ name: "Medium Org", totalAmountUSD: 200_000, count: 1 });
    expect(result[2]).toEqual({ name: "Small Org", totalAmountUSD: 10_000, count: 1 });
  });

  it("respects the limit parameter", () => {
    const grants = [
      makeRawGrant({ granteeName: "A", granteeId: null, amount: 300 }),
      makeRawGrant({ granteeName: "B", granteeId: null, amount: 200 }),
      makeRawGrant({ granteeName: "C", granteeId: null, amount: 100 }),
    ];

    const result = getTopUnmatched(grants, 2);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("A");
    expect(result[1].name).toBe("B");
  });

  it("treats null amounts as 0", () => {
    const grants = [
      makeRawGrant({ granteeName: "No Amount", granteeId: null, amount: null }),
    ];
    const result = getTopUnmatched(grants);
    expect(result[0].totalAmountUSD).toBe(0);
    expect(result[0].count).toBe(1);
  });

  it("converts non-USD amounts to USD when aggregating", () => {
    const grants = [
      // GBP grant: 100,000 GBP = 127,000 USD
      makeRawGrant({ granteeName: "UK Org", granteeId: null, amount: 100_000, currency: "GBP" }),
      // USD grant: 100,000 USD
      makeRawGrant({ granteeName: "US Org", granteeId: null, amount: 100_000, currency: "USD" }),
    ];

    const result = getTopUnmatched(grants);
    expect(result).toHaveLength(2);
    // GBP org should rank higher after conversion
    expect(result[0].name).toBe("UK Org");
    expect(result[0].totalAmountUSD).toBe(127_000);
    expect(result[1].name).toBe("US Org");
    expect(result[1].totalAmountUSD).toBe(100_000);
  });

  it("defaults to USD when currency is not specified", () => {
    const grants = [
      makeRawGrant({ granteeName: "Default Org", granteeId: null, amount: 50_000 }),
    ];
    const result = getTopUnmatched(grants);
    expect(result[0].totalAmountUSD).toBe(50_000);
  });
});

describe("getIdCollisions", () => {
  it("returns zero collisions for unique IDs", () => {
    const grants = [
      makeSyncGrant({ id: "a" }),
      makeSyncGrant({ id: "b" }),
      makeSyncGrant({ id: "c" }),
    ];
    const result = getIdCollisions(grants);
    expect(result).toEqual({ uniqueIds: 3, collisions: 0 });
  });

  it("detects collisions for duplicate IDs", () => {
    const grants = [
      makeSyncGrant({ id: "a" }),
      makeSyncGrant({ id: "b" }),
      makeSyncGrant({ id: "a" }),
      makeSyncGrant({ id: "a" }),
    ];
    const result = getIdCollisions(grants);
    expect(result).toEqual({ uniqueIds: 2, collisions: 2 });
  });

  it("returns zeros for empty input", () => {
    expect(getIdCollisions([])).toEqual({ uniqueIds: 0, collisions: 0 });
  });
});

describe("getByFunder", () => {
  it("returns empty array for no grants", () => {
    expect(getByFunder([])).toEqual([]);
  });

  it("groups and counts grants by organizationId, sorted descending", () => {
    const grants = [
      makeSyncGrant({ organizationId: "org-a" }),
      makeSyncGrant({ organizationId: "org-b" }),
      makeSyncGrant({ organizationId: "org-a" }),
      makeSyncGrant({ organizationId: "org-a" }),
      makeSyncGrant({ organizationId: "org-b" }),
      makeSyncGrant({ organizationId: "org-c" }),
    ];

    const result = getByFunder(grants);
    expect(result).toEqual([
      { organizationId: "org-a", count: 3 },
      { organizationId: "org-b", count: 2 },
      { organizationId: "org-c", count: 1 },
    ]);
  });
});
