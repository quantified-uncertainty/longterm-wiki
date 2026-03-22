import { describe, it, expect } from "vitest";
import { RESEARCH_AREAS, type ResearchAreaSeed } from "./research-areas-seed.ts";

const VALID_CLUSTERS = [
  "alignment-training",
  "interpretability",
  "evaluation",
  "ai-control",
  "scalable-oversight",
  "governance",
  "capabilities-research",
  "information-integrity",
  "biosecurity",
];

const VALID_STATUSES = ["active", "emerging", "mature", "declining", "archived"];

describe("research-areas-seed", () => {
  it("has at least 40 research areas", () => {
    expect(RESEARCH_AREAS.length).toBeGreaterThanOrEqual(40);
  });

  it("has no duplicate IDs", () => {
    const ids = RESEARCH_AREAS.map((a) => a.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it("all clusters are valid", () => {
    for (const area of RESEARCH_AREAS) {
      expect(VALID_CLUSTERS).toContain(area.cluster);
    }
  });

  it("all statuses are valid", () => {
    for (const area of RESEARCH_AREAS) {
      expect(VALID_STATUSES).toContain(area.status);
    }
  });

  it("all parentAreaIds reference existing areas", () => {
    const ids = new Set(RESEARCH_AREAS.map((a) => a.id));
    for (const area of RESEARCH_AREAS) {
      if (area.parentAreaId) {
        expect(ids.has(area.parentAreaId)).toBe(true);
      }
    }
  });

  it("no circular parent references", () => {
    const parentMap = new Map<string, string>();
    for (const area of RESEARCH_AREAS) {
      if (area.parentAreaId) {
        parentMap.set(area.id, area.parentAreaId);
      }
    }

    for (const area of RESEARCH_AREAS) {
      const visited = new Set<string>();
      let current: string | undefined = area.id;
      while (current && parentMap.has(current)) {
        if (visited.has(current)) {
          throw new Error(`Circular parent reference detected: ${area.id}`);
        }
        visited.add(current);
        current = parentMap.get(current);
      }
    }
  });

  it("every cluster has at least 2 areas", () => {
    const clusterCounts = new Map<string, number>();
    for (const area of RESEARCH_AREAS) {
      clusterCounts.set(area.cluster, (clusterCounts.get(area.cluster) ?? 0) + 1);
    }
    for (const [cluster, count] of clusterCounts) {
      expect(count).toBeGreaterThanOrEqual(2);
    }
  });

  it("all IDs are valid slugs", () => {
    for (const area of RESEARCH_AREAS) {
      expect(area.id).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    }
  });

  it("all titles are non-empty", () => {
    for (const area of RESEARCH_AREAS) {
      expect(area.title.length).toBeGreaterThan(0);
    }
  });

  it("all descriptions are non-empty", () => {
    for (const area of RESEARCH_AREAS) {
      expect(area.description.length).toBeGreaterThan(10);
    }
  });

  it("preserves existing 9 areas from YAML", () => {
    const existingIds = [
      "rlhf",
      "interpretability",
      "mech-interp",
      "evals",
      "red-teaming",
      "ai-control",
      "scalable-oversight",
      "corrigibility",
      "value-learning",
    ];
    const seedIds = new Set(RESEARCH_AREAS.map((a) => a.id));
    for (const id of existingIds) {
      expect(seedIds.has(id)).toBe(true);
    }
  });
});
