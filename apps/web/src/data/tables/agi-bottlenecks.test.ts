import { describe, it, expect } from "vitest";
import {
  agiBottlenecks,
  AGI_BOTTLENECK_CATEGORIES,
} from "./agi-bottlenecks";

describe("agi-bottlenecks data", () => {
  it("has 8-15 rows (kept tight to match snapshot cadence)", () => {
    expect(agiBottlenecks.length).toBeGreaterThanOrEqual(8);
    expect(agiBottlenecks.length).toBeLessThanOrEqual(15);
  });

  it("has unique row ids", () => {
    const ids = agiBottlenecks.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every row uses a known category", () => {
    const known = new Set<string>(AGI_BOTTLENECK_CATEGORIES);
    for (const b of agiBottlenecks) {
      expect(known.has(b.category), `unknown category "${b.category}" on row ${b.id}`).toBe(true);
    }
  });

  it("every row has non-empty required free-text fields", () => {
    for (const b of agiBottlenecks) {
      expect(b.name, b.id).toBeTruthy();
      expect(b.description, b.id).toBeTruthy();
      expect(b.notes, b.id).toBeTruthy();
      expect(b.tightness.note, `${b.id}.tightness.note`).toBeTruthy();
      expect(b.trajectory.note, `${b.id}.trajectory.note`).toBeTruthy();
      expect(b.timeToRelieve.note, `${b.id}.timeToRelieve.note`).toBeTruthy();
      expect(b.geographicConcentration.note, `${b.id}.geographicConcentration.note`).toBeTruthy();
    }
  });

  it("every row has at least one controller listed", () => {
    for (const b of agiBottlenecks) {
      expect(b.controllers.length, `${b.id} has no controllers`).toBeGreaterThan(0);
    }
  });

  it("tightness levels are drawn from the documented set", () => {
    const allowed = new Set(["BINDING", "TIGHT", "MODERATE", "SLACK"]);
    for (const b of agiBottlenecks) {
      expect(allowed.has(b.tightness.level), `${b.id}: ${b.tightness.level}`).toBe(true);
    }
  });

  it("trajectory directions are drawn from the documented set", () => {
    const allowed = new Set(["tightening", "stable", "loosening", "mixed"]);
    for (const b of agiBottlenecks) {
      expect(allowed.has(b.trajectory.direction), `${b.id}: ${b.trajectory.direction}`).toBe(true);
    }
  });

  it("time-to-relieve horizons are drawn from the documented set", () => {
    const allowed = new Set(["short", "medium", "long", "very-long"]);
    for (const b of agiBottlenecks) {
      expect(allowed.has(b.timeToRelieve.horizon), `${b.id}: ${b.timeToRelieve.horizon}`).toBe(true);
    }
  });

  it("cost-to-expand levels are drawn from the documented set", () => {
    const allowed = new Set(["LOW", "MEDIUM", "HIGH", "VERY_HIGH", "N/A"]);
    for (const b of agiBottlenecks) {
      expect(allowed.has(b.costToExpand.level), `${b.id}: ${b.costToExpand.level}`).toBe(true);
    }
  });

  it("geographic concentration levels are drawn from the documented set", () => {
    const allowed = new Set(["GLOBAL", "DISTRIBUTED", "REGIONAL", "CONCENTRATED", "SINGLE_POINT"]);
    for (const b of agiBottlenecks) {
      expect(allowed.has(b.geographicConcentration.level), `${b.id}: ${b.geographicConcentration.level}`).toBe(true);
    }
  });
});
