import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { loadKB } from "../src/loader";
import type { Graph } from "../src/graph";

const DATA_DIR = path.resolve(__dirname, "../data");

describe("graph", () => {
  let graph: Graph;

  beforeAll(async () => {
    graph = await loadKB(DATA_DIR);
  });

  describe("getEntity", () => {
    it("returns the correct entity for a valid slug", () => {
      const entity = graph.getEntity("anthropic");
      expect(entity).toBeDefined();
      expect(entity!.slug).toBe("anthropic");
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
      const facts = graph.getFacts("anthropic");
      expect(facts).toHaveLength(52);
    });

    it("returns empty array for an entity with no facts", () => {
      const facts = graph.getFacts("nonexistent");
      expect(facts).toEqual([]);
    });

    it("filters by property", () => {
      const revenueFacts = graph.getFacts("anthropic", {
        property: "revenue",
      });
      expect(revenueFacts).toHaveLength(9);
      for (const fact of revenueFacts) {
        expect(fact.propertyId).toBe("revenue");
      }
    });

    it("filters by current (no validEnd)", () => {
      // Jan Leike has 2 employed-by facts: one with validEnd (OpenAI), one without (Anthropic)
      const currentFacts = graph.getFacts("jan-leike", {
        property: "employed-by",
        current: true,
      });
      expect(currentFacts).toHaveLength(1);
      expect(currentFacts[0].value).toEqual({
        type: "ref",
        value: graph.getEntity("anthropic")!.id,
      });
    });

    it("returns both current and ended facts without current filter", () => {
      const allFacts = graph.getFacts("jan-leike", {
        property: "employed-by",
      });
      expect(allFacts).toHaveLength(3);
    });

    it("can combine property and current filters", () => {
      // All Jan Leike's employed-by facts that are current
      const facts = graph.getFacts("jan-leike", {
        property: "employed-by",
        current: true,
      });
      expect(facts).toHaveLength(1);
      expect(facts[0].validEnd).toBeUndefined();
    });
  });

  describe("getLatest", () => {
    it("returns the most recent fact by asOf for a time series", () => {
      const latest = graph.getLatest("anthropic", "revenue");
      expect(latest).toBeDefined();
      // The most recent revenue fact is asOf: 2026-03 with value 19e9
      expect(latest!.asOf).toBe("2026-03");
      expect(latest!.value).toEqual({ type: "number", value: 19e9 });
    });

    it("returns undefined for a missing property", () => {
      const latest = graph.getLatest("anthropic", "nonexistent-property");
      expect(latest).toBeUndefined();
    });

    it("returns undefined for a missing entity", () => {
      const latest = graph.getLatest("nonexistent", "revenue");
      expect(latest).toBeUndefined();
    });

    it("returns the only fact when there is just one", () => {
      const latest = graph.getLatest("anthropic", "headquarters");
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
      expect(revMap.has(graph.getEntity("anthropic")!.id)).toBe(true);
      expect(revMap.has(graph.getEntity("openai")!.id)).toBe(true);
    });

    it("returns facts from multiple entities", () => {
      const roleMap = graph.getByProperty("role");
      // All 20 people have role facts
      expect(roleMap.size).toBe(20);
      expect(roleMap.has(graph.getEntity("dario-amodei")!.id)).toBe(true);
      expect(roleMap.has(graph.getEntity("jan-leike")!.id)).toBe(true);
      expect(roleMap.has(graph.getEntity("sam-altman")!.id)).toBe(true);
    });

    it("returns latest fact per entity with latest:true", () => {
      const revMap = graph.getByProperty("revenue", { latest: true });
      expect(revMap.size).toBeGreaterThanOrEqual(2);
      const anthropicRev = revMap.get(graph.getEntity("anthropic")!.id);
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
      // Spot-check key organizations by slug
      const orgSlugs = new Set(orgs.map((o) => o.slug));
      expect(orgSlugs.has("anthropic")).toBe(true);
      expect(orgSlugs.has("openai")).toBe(true);
      expect(orgSlugs.has("deepmind")).toBe(true);
      expect(orgSlugs.has("chan-zuckerberg-initiative")).toBe(true);
      expect(orgSlugs.has("coefficient-giving")).toBe(true);
      expect(orgSlugs.has("manifund")).toBe(true);
    });

    it("returns multiple entities of the same type", () => {
      const people = graph.getByType("person");
      expect(people.length).toBeGreaterThanOrEqual(21);
      // Spot-check key people by slug
      const slugs = new Set(people.map((p) => p.slug));
      expect(slugs.has("dario-amodei")).toBe(true);
      expect(slugs.has("sam-altman")).toBe(true);
      expect(slugs.has("eliezer-yudkowsky")).toBe(true);
      expect(slugs.has("jaan-tallinn")).toBe(true);
      expect(slugs.has("dustin-moskovitz")).toBe(true);
    });

    it("returns empty array for unknown type", () => {
      const entities = graph.getByType("product");
      expect(entities).toHaveLength(0);
    });
  });

  describe("getRelated", () => {
    it("returns referenced entity IDs from ref facts", () => {
      const related = graph.getRelated("jan-leike", "employed-by");
      expect(related).toContain(graph.getEntity("openai")!.id);
      expect(related).toContain(graph.getEntity("anthropic")!.id);
      expect(related).toContain(graph.getEntity("deepmind")!.id);
      expect(related).toHaveLength(3);
    });

    it("returns referenced entity IDs from multiple ref facts", () => {
      const related = graph.getRelated("dario-amodei", "employed-by");
      expect(related).toContain(graph.getEntity("anthropic")!.id);
      expect(related.length).toBeGreaterThanOrEqual(1);
    });

    it("returns empty array when no facts match", () => {
      const related = graph.getRelated("anthropic", "employed-by");
      expect(related).toEqual([]);
    });

    it("returns empty array for nonexistent entity", () => {
      const related = graph.getRelated("nonexistent", "employed-by");
      expect(related).toEqual([]);
    });
  });

  describe("getRecords", () => {
    it("returns record entries with keys and fields", () => {
      const rounds = graph.getRecords("anthropic", "funding-rounds");
      expect(rounds.length).toBeGreaterThan(0);

      // Each entry has a key, schema, and fields
      for (const entry of rounds) {
        expect(typeof entry.key).toBe("string");
        expect(typeof entry.fields).toBe("object");
        expect(entry.schema).toBe("funding-round");
      }
    });

    it("returns correct data for a specific record entry", () => {
      const people = graph.getRecords("anthropic", "key-persons");
      const darioCeo = people.find((p) => p.key === "dario-amodei");
      expect(darioCeo).toBeDefined();
      expect(darioCeo!.fields.person).toBe("dario-amodei");
      expect(darioCeo!.fields.title).toBe("CEO");
      expect(darioCeo!.fields.start).toBe("2021-01");
      expect(darioCeo!.fields.is_founder).toBe(true);
    });

    it("returns empty array for missing collection", () => {
      const records = graph.getRecords("anthropic", "nonexistent");
      expect(records).toEqual([]);
    });

    it("returns empty array for entity without records", () => {
      const records = graph.getRecords("jan-leike", "key-persons");
      expect(records).toEqual([]);
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
