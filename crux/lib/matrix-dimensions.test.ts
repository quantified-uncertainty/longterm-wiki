import { describe, it, expect } from "vitest";
import {
  scanInfraDimensions,
  scanAllInfraDimensions,
  type InfraDimensions,
} from "./matrix-dimensions.ts";

describe("scanInfraDimensions", () => {
  it("person scores >= 70%", () => {
    const dims = scanInfraDimensions("person");
    expect(dims.infraScore).toBeGreaterThanOrEqual(70);
  });

  it("organization scores >= 70%", () => {
    const dims = scanInfraDimensions("organization");
    expect(dims.infraScore).toBeGreaterThanOrEqual(70);
  });

  it("risk scores >= 70%", () => {
    const dims = scanInfraDimensions("risk");
    expect(dims.infraScore).toBeGreaterThanOrEqual(70);
  });

  it("infraScore is correctly computed as (trueCount / 7) * 100", () => {
    const dims = scanInfraDimensions("person");
    const trueCount = [
      dims.hasZodSchema,
      dims.hasBuildPipeline,
      dims.hasTypeGuard,
      dims.hasOntologyEntry,
      dims.hasDirectoryPage,
      dims.hasProfilePage,
      dims.hasTestFiles,
    ].filter(Boolean).length;

    expect(dims.infraScore).toBe(Math.round((trueCount / 7) * 100));
  });

  it("returns boolean values for all dimension flags", () => {
    const dims = scanInfraDimensions("organization");
    expect(typeof dims.hasZodSchema).toBe("boolean");
    expect(typeof dims.hasBuildPipeline).toBe("boolean");
    expect(typeof dims.hasTypeGuard).toBe("boolean");
    expect(typeof dims.hasOntologyEntry).toBe("boolean");
    expect(typeof dims.hasDirectoryPage).toBe("boolean");
    expect(typeof dims.hasProfilePage).toBe("boolean");
    expect(typeof dims.hasTestFiles).toBe("boolean");
    expect(typeof dims.infraScore).toBe("number");
  });
});

describe("scanAllInfraDimensions", () => {
  it("returns results for all canonical entity types", () => {
    const all = scanAllInfraDimensions();
    // The canonical list has at least 25 entity types
    expect(all.size).toBeGreaterThanOrEqual(25);
    // Spot-check known types
    expect(all.has("person")).toBe(true);
    expect(all.has("organization")).toBe(true);
    expect(all.has("risk")).toBe(true);
    expect(all.has("policy")).toBe(true);
    expect(all.has("ai-model")).toBe(true);
    expect(all.has("benchmark")).toBe(true);
    expect(all.has("approach")).toBe(true);
    expect(all.has("concept")).toBe(true);
  });

  it("every entry has a valid infraScore between 0 and 100", () => {
    const all = scanAllInfraDimensions();
    for (const [_type, dims] of all) {
      expect(dims.infraScore).toBeGreaterThanOrEqual(0);
      expect(dims.infraScore).toBeLessThanOrEqual(100);
    }
  });

  it("infraScore is consistent with boolean flag counts for all types", () => {
    const all = scanAllInfraDimensions();
    for (const [_type, dims] of all) {
      const trueCount = [
        dims.hasZodSchema,
        dims.hasBuildPipeline,
        dims.hasTypeGuard,
        dims.hasOntologyEntry,
        dims.hasDirectoryPage,
        dims.hasProfilePage,
        dims.hasTestFiles,
      ].filter(Boolean).length;
      expect(dims.infraScore).toBe(Math.round((trueCount / 7) * 100));
    }
  });
});
