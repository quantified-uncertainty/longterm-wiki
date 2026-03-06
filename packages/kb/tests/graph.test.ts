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

  describe("getThing", () => {
    it("returns the correct thing for a valid ID", () => {
      const thing = graph.getThing("anthropic");
      expect(thing).toBeDefined();
      expect(thing!.id).toBe("anthropic");
      expect(thing!.name).toBe("Anthropic");
      expect(thing!.type).toBe("organization");
    });

    it("returns undefined for a missing thing", () => {
      const thing = graph.getThing("nonexistent-org");
      expect(thing).toBeUndefined();
    });
  });

  describe("getAllThings", () => {
    it("returns all things in the graph", () => {
      const things = graph.getAllThings();
      expect(things).toHaveLength(5);
    });
  });

  describe("getFacts", () => {
    it("returns all facts for a thing", () => {
      const facts = graph.getFacts("anthropic");
      // 9 revenue + 4 valuation + 3 total-funding + 3 headcount + 1 founded-date
      // + 1 headquarters + 1 legal-structure + 2 gross-margin + 2 cash-burn
      // + 2 enterprise-market-share + 1 coding-market-share + 1 monthly-active-users
      // + 1 business-customers + 1 api-calls-monthly + 1 product-revenue
      // + 1 safety-level + 1 safety-researcher-count + 1 interpretability-team-size = 36
      expect(facts).toHaveLength(36);
    });

    it("returns empty array for a thing with no facts", () => {
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
        value: "anthropic",
      });
    });

    it("returns both current and ended facts without current filter", () => {
      const allFacts = graph.getFacts("jan-leike", {
        property: "employed-by",
      });
      expect(allFacts).toHaveLength(2);
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

    it("returns undefined for a missing thing", () => {
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
      // Anthropic and OpenAI both have revenue facts
      expect(revMap.size).toBe(2);
      expect(revMap.has("anthropic")).toBe(true);
      expect(revMap.has("openai")).toBe(true);
    });

    it("returns facts from multiple entities", () => {
      const roleMap = graph.getByProperty("role");
      // Dario, Jan, and Sam all have role facts
      expect(roleMap.size).toBe(3);
      expect(roleMap.has("dario-amodei")).toBe(true);
      expect(roleMap.has("jan-leike")).toBe(true);
      expect(roleMap.has("sam-altman")).toBe(true);
    });

    it("returns latest fact per entity with latest:true", () => {
      const revMap = graph.getByProperty("revenue", { latest: true });
      expect(revMap.size).toBe(2);
      const anthropicRev = revMap.get("anthropic");
      expect(anthropicRev).toBeDefined();
      expect(anthropicRev!.asOf).toBe("2026-03");
    });

    it("returns empty map for unused property", () => {
      const map = graph.getByProperty("launched-date");
      expect(map.size).toBe(0);
    });
  });

  describe("getByType", () => {
    it("returns things of a given type", () => {
      const orgs = graph.getByType("organization");
      expect(orgs).toHaveLength(2);
      const orgIds = orgs.map((o) => o.id).sort();
      expect(orgIds).toEqual(["anthropic", "openai"]);
    });

    it("returns multiple things of the same type", () => {
      const people = graph.getByType("person");
      expect(people).toHaveLength(3);
      const ids = people.map((p) => p.id).sort();
      expect(ids).toEqual(["dario-amodei", "jan-leike", "sam-altman"]);
    });

    it("returns empty array for unknown type", () => {
      const things = graph.getByType("product");
      expect(things).toHaveLength(0);
    });
  });

  describe("getRelated", () => {
    it("returns referenced thing IDs from ref facts", () => {
      const related = graph.getRelated("jan-leike", "employed-by");
      expect(related).toContain("openai");
      expect(related).toContain("anthropic");
      expect(related).toHaveLength(2);
    });

    it("returns referenced thing IDs from a single ref fact", () => {
      const related = graph.getRelated("dario-amodei", "employed-by");
      expect(related).toEqual(["anthropic"]);
    });

    it("returns empty array when no facts match", () => {
      const related = graph.getRelated("anthropic", "employed-by");
      expect(related).toEqual([]);
    });

    it("returns empty array for nonexistent thing", () => {
      const related = graph.getRelated("nonexistent", "employed-by");
      expect(related).toEqual([]);
    });
  });

  describe("getItems", () => {
    it("returns item entries with keys and fields", () => {
      const rounds = graph.getItems("anthropic", "funding-rounds");
      expect(rounds.length).toBeGreaterThan(0);

      // Each entry has a key and fields
      for (const entry of rounds) {
        expect(typeof entry.key).toBe("string");
        expect(typeof entry.fields).toBe("object");
      }
    });

    it("returns correct data for a specific entry", () => {
      const people = graph.getItems("anthropic", "key-people");
      const darioCeo = people.find((p) => p.key === "dario-ceo");
      expect(darioCeo).toBeDefined();
      expect(darioCeo!.fields.person).toBe("dario-amodei");
      expect(darioCeo!.fields.title).toBe("CEO");
      expect(darioCeo!.fields.start).toBe("2021-01");
      expect(darioCeo!.fields.is_founder).toBe(true);
    });

    it("returns empty array for missing collection", () => {
      const items = graph.getItems("anthropic", "nonexistent");
      expect(items).toEqual([]);
    });

    it("returns empty array for thing without items", () => {
      const items = graph.getItems("jan-leike", "key-people");
      expect(items).toEqual([]);
    });
  });

  describe("getItemsMentioning", () => {
    it("finds items referencing a thing via ref fields", () => {
      // Anthropic's key-people collection has person fields referencing
      // dario-amodei, jan-leike, etc. (typed as ref in schema)
      const mentions = graph.getItemsMentioning("dario-amodei");
      expect(mentions.length).toBeGreaterThan(0);

      // Should find the key-people entry on Anthropic
      const anthropicMention = mentions.find(
        (m) => m.ownerThingId === "anthropic" && m.collection === "key-people"
      );
      expect(anthropicMention).toBeDefined();
      expect(anthropicMention!.matchingFields).toContain("person");
      expect(anthropicMention!.entry.fields.person).toBe("dario-amodei");
    });

    it("does not include self-references", () => {
      const mentions = graph.getItemsMentioning("anthropic");
      // Should not find items from Anthropic's own collections
      const selfRefs = mentions.filter((m) => m.ownerThingId === "anthropic");
      expect(selfRefs).toHaveLength(0);
    });

    it("returns empty array for thing with no mentions", () => {
      const mentions = graph.getItemsMentioning("nonexistent-thing");
      expect(mentions).toHaveLength(0);
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
