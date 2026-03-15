import { describe, it, expect, beforeAll } from "vitest";
import type { Graph } from "../src/graph";
import { loadTestKB } from "./test-helpers";

describe("graph", () => {
  let graph: Graph;
  let idOf: (filename: string) => string;

  beforeAll(async () => {
    ({ graph, idOf } = await loadTestKB());
  });

  describe("getEntity", () => {
    it("returns the correct entity for a valid slug", () => {
      const entity = graph.getEntity(idOf("anthropic"));
      expect(entity).toBeDefined();
      expect(entity!.id).toBe("mK9pX3rQ7n");
      expect(entity!.name).toBe("Anthropic");
      expect(entity!.type).toBe("organization");
    });

    it("returns undefined for a missing entity", () => {
      const entity = graph.getEntity("nonexistent-org");
      expect(entity).toBeUndefined();
    });
  });

  describe("getAllEntities", () => {
    it("returns all entities in the graph", () => {
      const entities = graph.getAllEntities();
      expect(entities.length).toBeGreaterThanOrEqual(360);
    });
  });

  describe("getFacts", () => {
    it("returns all facts for an entity", () => {
      const facts = graph.getFacts(idOf("anthropic"));
      expect(facts).toHaveLength(52);
    });

    it("returns empty array for an entity with no facts", () => {
      const facts = graph.getFacts("nonexistent");
      expect(facts).toEqual([]);
    });

    it("filters by property", () => {
      const revenueFacts = graph.getFacts(idOf("anthropic"), {
        property: "revenue",
      });
      expect(revenueFacts).toHaveLength(9);
      for (const fact of revenueFacts) {
        expect(fact.propertyId).toBe("revenue");
      }
    });

    it("filters by current (no validEnd)", () => {
      // Jan Leike has 2 employed-by facts: one with validEnd (OpenAI), one without (Anthropic)
      const currentFacts = graph.getFacts(idOf("jan-leike"), {
        property: "employed-by",
        current: true,
      });
      expect(currentFacts).toHaveLength(1);
      expect(currentFacts[0].value).toEqual({
        type: "ref",
        value: graph.getEntity(idOf("anthropic"))!.id,
      });
    });

    it("returns both current and ended facts without current filter", () => {
      const allFacts = graph.getFacts(idOf("jan-leike"), {
        property: "employed-by",
      });
      expect(allFacts).toHaveLength(3);
    });

    it("can combine property and current filters", () => {
      // All Jan Leike's employed-by facts that are current
      const facts = graph.getFacts(idOf("jan-leike"), {
        property: "employed-by",
        current: true,
      });
      expect(facts).toHaveLength(1);
      expect(facts[0].validEnd).toBeUndefined();
    });
  });

  describe("getLatest", () => {
    it("returns the most recent fact by asOf for a time series", () => {
      const latest = graph.getLatest(idOf("anthropic"), "revenue");
      expect(latest).toBeDefined();
      // The most recent revenue fact is asOf: 2026-03 with value 19e9
      expect(latest!.asOf).toBe("2026-03");
      expect(latest!.value).toEqual({ type: "number", value: 19e9 });
    });

    it("returns undefined for a missing property", () => {
      const latest = graph.getLatest(idOf("anthropic"), "nonexistent-property");
      expect(latest).toBeUndefined();
    });

    it("returns undefined for a missing entity", () => {
      const latest = graph.getLatest("nonexistent", "revenue");
      expect(latest).toBeUndefined();
    });

    it("returns the only fact when there is just one", () => {
      const latest = graph.getLatest(idOf("anthropic"), "headquarters");
      expect(latest).toBeDefined();
      expect(latest!.value).toEqual({
        type: "text",
        value: "San Francisco, CA",
      });
    });
  });

  describe("getByProperty", () => {
    it("returns facts across entities for a given property", () => {
      const revMap = graph.getByProperty("revenue");
      // Multiple entities have revenue facts after migration
      expect(revMap.size).toBeGreaterThanOrEqual(2);
      expect(revMap.has(graph.getEntity(idOf("anthropic"))!.id)).toBe(true);
      expect(revMap.has(graph.getEntity(idOf("openai"))!.id)).toBe(true);
    });

    it("returns facts from multiple entities", () => {
      const roleMap = graph.getByProperty("role");
      // All 20 people have role facts
      expect(roleMap.size).toBe(20);
      expect(roleMap.has(graph.getEntity(idOf("dario-amodei"))!.id)).toBe(true);
      expect(roleMap.has(graph.getEntity(idOf("jan-leike"))!.id)).toBe(true);
      expect(roleMap.has(graph.getEntity(idOf("sam-altman"))!.id)).toBe(true);
    });

    it("returns latest fact per entity with latest:true", () => {
      const revMap = graph.getByProperty("revenue", { latest: true });
      expect(revMap.size).toBeGreaterThanOrEqual(2);
      const anthropicRev = revMap.get(graph.getEntity(idOf("anthropic"))!.id);
      expect(anthropicRev).toBeDefined();
      expect(anthropicRev!.asOf).toBe("2026-03");
    });

    it("returns empty map for unused property", () => {
      const map = graph.getByProperty("launched-date");
      expect(map.size).toBe(0);
    });
  });

  describe("getByType", () => {
    it("returns entities of a given type", () => {
      const orgs = graph.getByType("organization");
      expect(orgs.length).toBeGreaterThanOrEqual(15);
      // Spot-check key organizations by name
      const orgNames = new Set(orgs.map((o) => o.name));
      expect(orgNames.has("Anthropic")).toBe(true);
      expect(orgNames.has("OpenAI")).toBe(true);
      expect(orgNames.has("Google DeepMind")).toBe(true);
      expect(orgNames.has("Chan Zuckerberg Initiative")).toBe(true);
      expect(orgNames.has("Coefficient Giving")).toBe(true);
      expect(orgNames.has("Manifund")).toBe(true);
    });

    it("returns multiple entities of the same type", () => {
      const people = graph.getByType("person");
      expect(people.length).toBeGreaterThanOrEqual(21);
      // Spot-check key people by name
      const names = new Set(people.map((p) => p.name));
      expect(names.has("Dario Amodei")).toBe(true);
      expect(names.has("Sam Altman")).toBe(true);
      expect(names.has("Eliezer Yudkowsky")).toBe(true);
      expect(names.has("Jaan Tallinn")).toBe(true);
      expect(names.has("Dustin Moskovitz")).toBe(true);
    });

    it("returns empty array for unknown type", () => {
      const entities = graph.getByType("product");
      expect(entities).toHaveLength(0);
    });
  });

  describe("getRelated", () => {
    it("returns referenced entity IDs from ref facts", () => {
      const related = graph.getRelated(idOf("jan-leike"), "employed-by");
      expect(related).toContain(graph.getEntity(idOf("openai"))!.id);
      expect(related).toContain(graph.getEntity(idOf("anthropic"))!.id);
      expect(related).toContain(graph.getEntity(idOf("deepmind"))!.id);
      expect(related).toHaveLength(3);
    });

    it("returns referenced entity IDs from multiple ref facts", () => {
      const related = graph.getRelated(idOf("dario-amodei"), "employed-by");
      expect(related).toContain(graph.getEntity(idOf("anthropic"))!.id);
      expect(related.length).toBeGreaterThanOrEqual(1);
    });

    it("returns empty array when no facts match", () => {
      const related = graph.getRelated(idOf("anthropic"), "employed-by");
      expect(related).toEqual([]);
    });

    it("returns empty array for nonexistent entity", () => {
      const related = graph.getRelated("nonexistent", "employed-by");
      expect(related).toEqual([]);
    });
  });

  describe("property and schema queries", () => {
    it("getProperty returns correct property", () => {
      const prop = graph.getProperty("headquarters");
      expect(prop).toBeDefined();
      expect(prop!.name).toBe("Headquarters");
      expect(prop!.dataType).toBe("text");
    });

    it("getProperty returns undefined for missing property", () => {
      expect(graph.getProperty("nonexistent")).toBeUndefined();
    });

    it("getSchema returns correct schema", () => {
      const schema = graph.getSchema("organization");
      expect(schema).toBeDefined();
      expect(schema!.name).toBe("Organization");
    });

    it("getSchema returns undefined for missing schema", () => {
      expect(graph.getSchema("nonexistent")).toBeUndefined();
    });
  });
});
