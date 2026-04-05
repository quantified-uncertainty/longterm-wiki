import { describe, it, expect } from "vitest";
import { getFactBaseFacts, getFactBaseLatest, getKBRecords } from "../factbase";
import { getIdRegistry } from "../tablebase";

/**
 * Integration tests: FactBase entity lookups must work via stableId AND slug.
 *
 * Catches regressions where resolveEntityKey() fails to map slugs → stableIds,
 * causing silent data loss (e.g., E815 Anthropic Stakeholders table broke on
 * production because slug resolution failed during Vercel ISR).
 *
 * These tests verify the top entities by fact count — if slug resolution breaks,
 * at least one of these will fail.
 */

/** Top entities by fact count — covers the most important data. */
const TOP_ENTITIES = [
  { stableId: "sid_mK9pX3rQ7n", slug: "anthropic", property: "valuation" },
  { stableId: "sid_1LcLlMGLbw", slug: "openai", property: "valuation" },
  { stableId: "sid_OwXl35e7bg", slug: "givewell", property: "revenue" },
  { stableId: "sid_y4bieqSeag", slug: "cais", property: "founded-date" },
  { stableId: "sid_d9sWZtyVwg", slug: "fli", property: "founded-date" },
];

describe("resolveEntityKey — top entities accessible via stableId and slug", () => {
  for (const { stableId, slug, property } of TOP_ENTITIES) {
    it(`${slug}: finds facts via stableId (${stableId})`, () => {
      const facts = getFactBaseFacts(stableId, property);
      expect(facts.length).toBeGreaterThan(0);
    });

    it(`${slug}: finds facts via slug`, () => {
      const facts = getFactBaseFacts(slug, property);
      expect(facts.length).toBeGreaterThan(0);
    });

    it(`${slug}: stableId and slug resolve to same facts`, () => {
      const bySid = getFactBaseFacts(stableId, property);
      const bySlug = getFactBaseFacts(slug, property);
      expect(bySid.length).toBe(bySlug.length);
      if (bySid.length > 0) {
        expect(bySid[0].id).toBe(bySlug[0].id);
      }
    });
  }
});

describe("resolveEntityKey — Anthropic stakeholders table dependencies", () => {
  it("finds valuation via stableId with correct type", () => {
    const fact = getFactBaseLatest("sid_mK9pX3rQ7n", "valuation");
    expect(fact).toBeDefined();
    expect(fact!.value.type).toBe("number");
    if (fact!.value.type === "number") {
      expect(fact!.value.value).toBeGreaterThan(0);
    }
  });

  it("finds valuation via bare 10-char ID (mK9pX3rQ7n)", () => {
    const facts = getFactBaseFacts("mK9pX3rQ7n", "valuation");
    expect(facts.length).toBeGreaterThan(0);
  });

  it("returns equity-positions records", () => {
    const records = getKBRecords("sid_mK9pX3rQ7n", "equity-positions");
    expect(Array.isArray(records)).toBe(true);
    if (records.length > 0) {
      expect(records[0]).toHaveProperty("fields");
      expect(records[0].fields).toHaveProperty("holder");
    }
  });
});

describe("resolveEntityKey — idRegistry consistency", () => {
  it("all top entity slugs are in stableIdBySlug", () => {
    const registry = getIdRegistry();
    for (const { stableId, slug } of TOP_ENTITIES) {
      const resolved = registry.stableIdBySlug?.[slug];
      expect(resolved, `slug "${slug}" not found in stableIdBySlug`).toBe(stableId);
    }
  });

  it("all top entity stableIds are in stableIdToSlug", () => {
    const registry = getIdRegistry();
    for (const { stableId, slug } of TOP_ENTITIES) {
      const resolved = registry.stableIdToSlug?.[stableId];
      expect(resolved, `stableId "${stableId}" not found in stableIdToSlug`).toBe(slug);
    }
  });
});
