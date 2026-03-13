import { describe, it, expect } from "vitest";
import { extractAllCareers } from "../extract.ts";

describe("extractAllCareers", () => {
  it("extracts career entries from KB data", () => {
    const result = extractAllCareers();

    // Should have a non-trivial number of entries
    expect(result.entries.length).toBeGreaterThan(30);

    // Stats should be consistent
    expect(result.stats.totalAfterDedup).toBe(result.entries.length);
    expect(result.stats.totalBeforeDedup).toBeGreaterThanOrEqual(
      result.stats.totalAfterDedup,
    );
    expect(result.stats.uniquePersons).toBeGreaterThan(10);

    // Every entry should have required fields
    for (const entry of result.entries) {
      expect(entry.id).toHaveLength(10);
      expect(entry.personId).toBeTruthy();
      expect(entry.organizationId).toBeTruthy();
      expect(entry.role).toBeTruthy();
      expect(["kb-record", "kb-fact", "experts-yaml"]).toContain(entry.origin);
    }
  });

  it("produces deterministic IDs across runs", () => {
    const result1 = extractAllCareers();
    const result2 = extractAllCareers();

    const ids1 = result1.entries.map((e) => e.id).sort();
    const ids2 = result2.entries.map((e) => e.id).sort();

    expect(ids1).toEqual(ids2);
  });

  it("deduplicates entries across sources", () => {
    const result = extractAllCareers();

    // KB records should dominate — verify dedup removed some
    expect(result.stats.totalBeforeDedup).toBeGreaterThan(
      result.stats.totalAfterDedup,
    );
  });

  it("resolves known org slugs to stableIds", () => {
    const result = extractAllCareers();

    // Find Dario Amodei's Anthropic entry (should have stableId, not slug)
    const anthropicEntries = result.entries.filter(
      (e) => e.organizationId === "mK9pX3rQ7n", // Anthropic's stableId
    );
    expect(anthropicEntries.length).toBeGreaterThan(0);
  });

  it("marks founders correctly", () => {
    const result = extractAllCareers();

    const founders = result.entries.filter((e) => e.isFounder);
    expect(founders.length).toBeGreaterThan(0);

    // All founder entries should have "founder" in the role
    for (const entry of founders) {
      expect(entry.role.toLowerCase()).toContain("founder");
    }
  });
});
