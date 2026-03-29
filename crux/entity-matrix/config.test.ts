import { describe, expect, it } from "vitest";
import {
  scoreCount,
  scoreBoolean,
  scorePercentage,
  scoreEnum,
  scoreDimension,
  DIMENSIONS,
  DIMENSION_GROUPS,
  ENTITY_TYPES,
} from "./config.ts";

// ============================================================================
// SCORING FUNCTIONS
// ============================================================================

describe("scoreCount", () => {
  const thresholds = { yellow: 10, green: 50 };

  it("returns 0 for zero or negative", () => {
    expect(scoreCount(0, thresholds)).toBe(0);
    expect(scoreCount(-1, thresholds)).toBe(0);
    expect(scoreCount(-100, thresholds)).toBe(0);
  });

  it("returns 30 for values below yellow threshold", () => {
    expect(scoreCount(1, thresholds)).toBe(30);
    expect(scoreCount(9, thresholds)).toBe(30);
  });

  it("returns 60 for values between yellow and green", () => {
    expect(scoreCount(10, thresholds)).toBe(60);
    expect(scoreCount(49, thresholds)).toBe(60);
  });

  it("returns 100 for values at or above green threshold", () => {
    expect(scoreCount(50, thresholds)).toBe(100);
    expect(scoreCount(999, thresholds)).toBe(100);
  });
});

describe("scoreBoolean", () => {
  it("returns 80 for true", () => {
    expect(scoreBoolean(true)).toBe(80);
  });

  it("returns 0 for false", () => {
    expect(scoreBoolean(false)).toBe(0);
  });
});

describe("scorePercentage", () => {
  it("passes through values in 0-100 range", () => {
    expect(scorePercentage(0)).toBe(0);
    expect(scorePercentage(50)).toBe(50);
    expect(scorePercentage(100)).toBe(100);
  });

  it("clamps values outside range", () => {
    expect(scorePercentage(-10)).toBe(0);
    expect(scorePercentage(150)).toBe(100);
  });

  it("rounds to nearest integer", () => {
    expect(scorePercentage(33.7)).toBe(34);
    expect(scorePercentage(66.2)).toBe(66);
  });
});

describe("scoreEnum", () => {
  const mapping = { none: 0, basic: 50, rich: 100 };

  it("returns mapped value for known keys", () => {
    expect(scoreEnum("none", mapping)).toBe(0);
    expect(scoreEnum("basic", mapping)).toBe(50);
    expect(scoreEnum("rich", mapping)).toBe(100);
  });

  it("returns 0 for unknown keys", () => {
    expect(scoreEnum("unknown", mapping)).toBe(0);
    expect(scoreEnum("", mapping)).toBe(0);
  });
});

describe("scoreDimension", () => {
  // Data Foundation
  it("scores yaml_entity_count as count", () => {
    expect(scoreDimension("yaml_entity_count", 0)).toBe(0);
    expect(scoreDimension("yaml_entity_count", 5)).toBe(30);
    expect(scoreDimension("yaml_entity_count", 25)).toBe(60);
    expect(scoreDimension("yaml_entity_count", 100)).toBe(100);
  });

  it("scores db_table_exists as boolean", () => {
    expect(scoreDimension("db_table_exists", true)).toBe(80);
    expect(scoreDimension("db_table_exists", false)).toBe(0);
  });

  it("scores field_completeness as percentage", () => {
    expect(scoreDimension("field_completeness", 75)).toBe(75);
    expect(scoreDimension("field_completeness", 0)).toBe(0);
  });

  it("scores zod_schema as enum", () => {
    expect(scoreDimension("zod_schema", "none")).toBe(0);
    expect(scoreDimension("zod_schema", "generic")).toBe(40);
    expect(scoreDimension("zod_schema", "specialized")).toBe(100);
  });

  // API
  it("scores api_filtering as enum", () => {
    expect(scoreDimension("api_filtering", "none")).toBe(0);
    expect(scoreDimension("api_filtering", "basic")).toBe(50);
    expect(scoreDimension("api_filtering", "rich")).toBe(100);
  });

  // Content
  it("scores content_freshness inversely (lower days = higher score)", () => {
    expect(scoreDimension("content_freshness", 0)).toBe(0);
    expect(scoreDimension("content_freshness", 10)).toBe(100);
    expect(scoreDimension("content_freshness", 60)).toBe(70);
    expect(scoreDimension("content_freshness", 120)).toBe(40);
    expect(scoreDimension("content_freshness", 365)).toBe(15);
  });

  it("returns 0 for unknown dimension", () => {
    expect(scoreDimension("nonexistent_dimension", 42)).toBe(0);
  });
});

// ============================================================================
// CONFIGURATION INTEGRITY
// ============================================================================

describe("DIMENSIONS configuration", () => {
  it("has no duplicate IDs", () => {
    const ids = DIMENSIONS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all reference valid dimension groups", () => {
    const validGroups = new Set(DIMENSION_GROUPS.map((g) => g.id));
    for (const dim of DIMENSIONS) {
      expect(validGroups.has(dim.group)).toBe(true);
    }
  });

  it("all have importance between 1 and 10", () => {
    for (const dim of DIMENSIONS) {
      expect(dim.importance).toBeGreaterThanOrEqual(1);
      expect(dim.importance).toBeLessThanOrEqual(10);
    }
  });
});

describe("DIMENSION_GROUPS configuration", () => {
  it("has no duplicate IDs", () => {
    const ids = DIMENSION_GROUPS.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all groups are referenced by at least one dimension", () => {
    const usedGroups = new Set(DIMENSIONS.map((d) => d.group));
    for (const group of DIMENSION_GROUPS) {
      expect(usedGroups.has(group.id)).toBe(true);
    }
  });
});

describe("ENTITY_TYPES configuration", () => {
  it("has no duplicate IDs", () => {
    const ids = ENTITY_TYPES.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all have valid tier", () => {
    for (const et of ENTITY_TYPES) {
      expect(["canonical", "sub-entity"]).toContain(et.tier);
    }
  });

  it("canonical types have labels", () => {
    for (const et of ENTITY_TYPES.filter((e) => e.tier === "canonical")) {
      expect(et.label.length).toBeGreaterThan(0);
    }
  });

  it("sub-entities with directoryRoute have profileRoute", () => {
    for (const et of ENTITY_TYPES.filter(
      (e) => e.tier === "sub-entity" && e.directoryRoute,
    )) {
      expect(et.profileRoute).toBeDefined();
    }
  });

  it("countsAsType references a valid entity type ID", () => {
    const allIds = new Set(ENTITY_TYPES.map((e) => e.id));
    for (const et of ENTITY_TYPES.filter((e) => e.countsAsType)) {
      expect(allIds.has(et.countsAsType!)).toBe(true);
    }
  });
});
