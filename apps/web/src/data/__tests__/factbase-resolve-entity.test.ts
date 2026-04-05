import { describe, it, expect } from "vitest";
import { getFactBaseFacts, getFactBaseLatest, getKBRecords } from "../factbase";

/**
 * Integration test: Anthropic valuation fact must be resolvable
 * via both stableId and slug. Catches regressions where slug resolution
 * fails (e.g., during ISR when database.json isn't loaded).
 *
 * Context: E815 (Anthropic Stakeholders) table broke on production because
 * the component used slug-based lookup which failed during ISR.
 */
describe("resolveEntityKey — Anthropic valuation lookup", () => {
  it("finds valuation via stableId (sid_mK9pX3rQ7n)", () => {
    const fact = getFactBaseLatest("sid_mK9pX3rQ7n", "valuation");
    expect(fact).toBeDefined();
    expect(fact!.value.type).toBe("number");
    if (fact!.value.type === "number") {
      expect(fact!.value.value).toBeGreaterThan(0);
    }
  });

  it("finds valuation via slug (anthropic)", () => {
    const fact = getFactBaseLatest("anthropic", "valuation");
    expect(fact).toBeDefined();
    expect(fact!.value.type).toBe("number");
  });

  it("finds valuation via bare 10-char ID (mK9pX3rQ7n)", () => {
    // Bare IDs without sid_ prefix should be auto-prefixed as fallback
    const facts = getFactBaseFacts("mK9pX3rQ7n", "valuation");
    expect(facts.length).toBeGreaterThan(0);
  });

  it("returns equity-positions records for anthropic", () => {
    // The stakeholders table also needs equity records.
    // Records require PG merge at build time — may be empty in some test envs.
    const records = getKBRecords("sid_mK9pX3rQ7n", "equity-positions");
    expect(Array.isArray(records)).toBe(true);
    // If records exist, verify they have the expected shape
    if (records.length > 0) {
      expect(records[0]).toHaveProperty("fields");
      expect(records[0].fields).toHaveProperty("holder");
    }
  });
});
