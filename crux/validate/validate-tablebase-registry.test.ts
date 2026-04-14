import { describe, it, expect } from "vitest";
import { runCheck } from "./validate-tablebase-registry.ts";

describe("validate-tablebase-registry (QUA-456)", () => {
  it("runs without crashing and returns a structured result", () => {
    const result = runCheck();
    expect(result).toHaveProperty("passed");
    expect(result).toHaveProperty("errors");
    expect(result).toHaveProperty("registryKeys");
    expect(result).toHaveProperty("routeFiles");
    expect(Array.isArray(result.errors)).toBe(true);
    expect(Array.isArray(result.registryKeys)).toBe(true);
  });

  it("current repo state passes (no drift)", () => {
    const result = runCheck();
    // If this fails, the registry has drifted from the route files.
    // Read the errors: they'll tell you exactly what's missing or stale.
    expect(result.errors, result.errors.join("\n")).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it("finds at least 20 registry entries (regression guard)", () => {
    // If this drops below 20, someone likely deleted registry entries by
    // accident. Adjust only if the deletion is deliberate.
    const result = runCheck();
    expect(result.registryKeys.length).toBeGreaterThanOrEqual(20);
  });

  it("finds the expected well-known registry keys", () => {
    const result = runCheck();
    const keys = new Set(result.registryKeys);
    // Sanity check that parsing picked up all the big-ticket entries.
    for (const key of [
      "grants",
      "personnel",
      "investments",
      "funding-rounds",
      "publications",
      "political-races",
    ]) {
      expect(keys, `missing registry key: ${key}`).toContain(key);
    }
  });

  it("checks at least one path per registry entry", () => {
    const result = runCheck();
    // Each registry entry contributes at least one path check (syncPath),
    // and most also contribute a deletePath check. The total should be
    // at least as many as there are entries.
    expect(result.checkedPaths).toBeGreaterThanOrEqual(result.registryKeys.length);
  });
});
