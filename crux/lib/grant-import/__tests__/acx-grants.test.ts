import { describe, it, expect } from "vitest";
import { parseACXGrants, ACX_GRANTS_DATA } from "../sources/acx-grants.ts";
import type { EntityMatcher } from "../types.ts";

function makeMockMatcher(): EntityMatcher {
  const nameMap = new Map<string, { stableId: string; slug: string; name: string }>();
  nameMap.set("rethink priorities", { stableId: "rp123", slug: "rethink-priorities", name: "Rethink Priorities" });
  nameMap.set("1day-sooner", { stableId: "1ds456", slug: "1day-sooner", name: "1DaySooner" });
  return {
    allNames: nameMap,
    match: (name: string) => nameMap.get(name.toLowerCase().trim()) || null,
  };
}

describe("ACX Grants data integrity", () => {
  it("has entries for all three rounds", () => {
    const rounds = new Set(ACX_GRANTS_DATA.map((g) => g.round));
    expect(rounds.has("2021")).toBe(true);
    expect(rounds.has("2024")).toBe(true);
    expect(rounds.has("2025")).toBe(true);
  });

  it("has at least 25 grants per round", () => {
    const byCounts: Record<string, number> = {};
    for (const g of ACX_GRANTS_DATA) {
      byCounts[g.round] = (byCounts[g.round] || 0) + 1;
    }
    expect(byCounts["2021"]).toBeGreaterThanOrEqual(25);
    expect(byCounts["2024"]).toBeGreaterThanOrEqual(25);
    expect(byCounts["2025"]).toBeGreaterThanOrEqual(25);
  });

  it("has positive amounts for all grants", () => {
    for (const g of ACX_GRANTS_DATA) {
      expect(g.amount).toBeGreaterThan(0);
    }
  });

  it("has non-empty recipients and descriptions", () => {
    for (const g of ACX_GRANTS_DATA) {
      expect(g.recipient.length).toBeGreaterThan(0);
      expect(g.description.length).toBeGreaterThan(0);
    }
  });

  it("has grant amounts in reasonable range ($1K-$200K)", () => {
    for (const g of ACX_GRANTS_DATA) {
      expect(g.amount).toBeGreaterThanOrEqual(1000);
      expect(g.amount).toBeLessThanOrEqual(200000);
    }
  });
});

describe("parseACXGrants", () => {
  const matcher = makeMockMatcher();

  it("converts all entries to RawGrant format", () => {
    const grants = parseACXGrants(ACX_GRANTS_DATA, matcher);
    expect(grants).toHaveLength(ACX_GRANTS_DATA.length);
  });

  it("sets correct source and funderId", () => {
    const grants = parseACXGrants(ACX_GRANTS_DATA, matcher);
    for (const g of grants) {
      expect(g.source).toBe("acx-grants");
      expect(g.funderId).toBeDefined();
    }
  });

  it("uses round year as date", () => {
    const grants = parseACXGrants(ACX_GRANTS_DATA, matcher);
    const g2021 = grants.find((g) => g.granteeName === "Pedro Silva");
    expect(g2021?.date).toBe("2021");

    const g2024 = grants.find((g) => g.granteeName === "Marcin Kowrygo");
    expect(g2024?.date).toBe("2024");

    const g2025 = grants.find((g) => g.granteeName === "Kasey Markel");
    expect(g2025?.date).toBe("2025");
  });

  it("sets correct sourceUrl per round", () => {
    const grants = parseACXGrants(ACX_GRANTS_DATA, matcher);
    const g2021 = grants.find((g) => g.granteeName === "Pedro Silva");
    expect(g2021?.sourceUrl).toBe("https://www.astralcodexten.com/p/acx-grants-results");

    const g2024 = grants.find((g) => g.granteeName === "Marcin Kowrygo");
    expect(g2024?.sourceUrl).toBe("https://www.astralcodexten.com/p/acx-grants-results-2024");

    const g2025 = grants.find((g) => g.granteeName === "Kasey Markel");
    expect(g2025?.sourceUrl).toBe("https://www.astralcodexten.com/p/acx-grants-results-2025");
  });

  it("truncates long descriptions to 500 chars", () => {
    const longDesc = "A".repeat(600);
    const grants = parseACXGrants(
      [{ recipient: "Test", amount: 1000, description: longDesc, round: "2021" }],
      matcher,
    );
    expect(grants[0].name.length).toBeLessThanOrEqual(500);
  });

  it("preserves grant amounts", () => {
    const grants = parseACXGrants(ACX_GRANTS_DATA, matcher);
    const pSilva = grants.find((g) => g.granteeName === "Pedro Silva");
    expect(pSilva?.amount).toBe(60000);

    const oxfen = grants.find((g) => g.granteeName === "Oxfendazole Development Group");
    expect(oxfen?.amount).toBe(150000);
  });

  it("includes ACX round in description", () => {
    const grants = parseACXGrants(ACX_GRANTS_DATA, matcher);
    const g = grants[0];
    expect(g.description).toContain("ACX Grants");
  });
});
