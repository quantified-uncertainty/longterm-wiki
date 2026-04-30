import { describe, it, expect, beforeAll } from "vitest";
import { extractAllCareers } from "../extract.ts";

describe("extractAllCareers", () => {
  // extractAllCareers reads ~550 YAML files and takes ~3s per call.
  // Share a single result across tests so the suite completes within CI time limits.
  let result: ReturnType<typeof extractAllCareers>;

  beforeAll(() => {
    result = extractAllCareers();
  }, 10000);

  it("extracts career entries from KB data", () => {
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

  it("produces deterministic IDs across runs", { timeout: 10000 }, () => {
    // Call a second time to verify output is stable across invocations.
    const result2 = extractAllCareers();

    const ids1 = result.entries.map((e) => e.id).sort();
    const ids2 = result2.entries.map((e) => e.id).sort();

    expect(ids1).toEqual(ids2);
  });

  it("deduplication does not increase entry count", () => {
    // Dedup should never increase the count (no duplicates introduced)
    // kb-record origin was removed when records migrated to PostgreSQL
    expect(result.stats.totalBeforeDedup).toBeGreaterThanOrEqual(
      result.stats.totalAfterDedup,
    );
  });

  it("resolves known org slugs to stableIds", () => {
    // Find Dario Amodei's Anthropic entry (should have stableId, not slug)
    const anthropicEntries = result.entries.filter(
      (e) => e.organizationId === "sid_mK9pX3rQ7n", // Anthropic's stableId
    );
    expect(anthropicEntries.length).toBeGreaterThan(0);
  });

  it("marks founders correctly", () => {
    const founders = result.entries.filter((e) => e.isFounder);
    expect(founders.length).toBeGreaterThan(0);

    // All founder entries should have "founder" in the role
    for (const entry of founders) {
      expect(entry.role.toLowerCase()).toContain("founder");
    }
  });
});
