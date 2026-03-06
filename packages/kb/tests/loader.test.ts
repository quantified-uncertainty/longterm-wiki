import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { loadKB } from "../src/loader.ts";
import type { Graph } from "../src/graph.ts";

const DATA_DIR = path.resolve(__dirname, "../data");

describe("loader", () => {
  let graph: Graph;

  beforeAll(async () => {
    graph = await loadKB(DATA_DIR);
  });

  describe("things", () => {
    it("loads Anthropic from disk", () => {
      const anthropic = graph.getThing("anthropic");
      expect(anthropic).toBeDefined();
      expect(anthropic!.name).toBe("Anthropic");
      expect(anthropic!.stableId).toBe("mK9pX3rQ7n");
      expect(anthropic!.type).toBe("organization");
      expect(anthropic!.numericId).toBe(3);
    });

    it("loads all 5 things", () => {
      const things = graph.getAllThings();
      expect(things).toHaveLength(5);

      const ids = things.map((t) => t.id).sort();
      expect(ids).toEqual(["anthropic", "dario-amodei", "jan-leike", "openai", "sam-altman"]);
    });

    it("loads thing aliases", () => {
      const anthropic = graph.getThing("anthropic");
      expect(anthropic!.aliases).toEqual(["Anthropic PBC", "Anthropic AI"]);
    });
  });

  describe("properties", () => {
    it("loads 18 properties", () => {
      const properties = graph.getAllProperties();
      expect(properties).toHaveLength(18);
    });

    it("loads property details correctly", () => {
      const revenue = graph.getProperty("revenue");
      expect(revenue).toBeDefined();
      expect(revenue!.name).toBe("Revenue");
      expect(revenue!.dataType).toBe("number");
      expect(revenue!.unit).toBe("USD");
      expect(revenue!.category).toBe("financial");
      expect(revenue!.appliesTo).toEqual(["organization"]);
    });

    it("loads property display formatting", () => {
      const revenue = graph.getProperty("revenue");
      expect(revenue!.display).toEqual({
        divisor: 1e9,
        prefix: "$",
        suffix: "B",
      });
    });

    it("loads inverse property relationships", () => {
      const employedBy = graph.getProperty("employed-by");
      expect(employedBy!.inverseId).toBe("employer-of");
      expect(employedBy!.inverseName).toBe("Employs");
    });

    it("marks computed properties", () => {
      const employerOf = graph.getProperty("employer-of");
      expect(employerOf!.computed).toBe(true);
    });
  });

  describe("schemas", () => {
    it("loads 2 schemas (organization, person)", () => {
      const schemas = graph.getAllSchemas();
      expect(schemas).toHaveLength(2);
    });

    it("loads organization schema with required and recommended properties", () => {
      const orgSchema = graph.getSchema("organization");
      expect(orgSchema).toBeDefined();
      expect(orgSchema!.name).toBe("Organization");
      expect(orgSchema!.required).toEqual(["founded-date", "headquarters"]);
      expect(orgSchema!.recommended).toContain("revenue");
      expect(orgSchema!.recommended).toContain("valuation");
    });

    it("loads person schema with empty required array", () => {
      const personSchema = graph.getSchema("person");
      expect(personSchema).toBeDefined();
      expect(personSchema!.required).toEqual([]);
      expect(personSchema!.recommended).toContain("employed-by");
      expect(personSchema!.recommended).toContain("role");
      expect(personSchema!.recommended).toContain("born-year");
    });

    it("loads item collection schemas on organization", () => {
      const orgSchema = graph.getSchema("organization");
      expect(orgSchema!.items).toBeDefined();
      expect(orgSchema!.items!["funding-rounds"]).toBeDefined();
      expect(orgSchema!.items!["key-people"]).toBeDefined();

      const frFields = orgSchema!.items!["funding-rounds"].fields;
      expect(frFields["date"].required).toBe(true);
      expect(frFields["date"].type).toBe("date");
      expect(frFields["amount"].type).toBe("number");
      expect(frFields["lead_investor"].type).toBe("ref");
    });
  });

  describe("facts", () => {
    it("loads correct number of facts for Anthropic (11)", () => {
      const facts = graph.getFacts("anthropic");
      // 5 revenue + 1 valuation + 1 founded-date + 1 headquarters + 1 headcount
      // + 1 legal-structure + 1 total-funding + 1 gross-margin + 2 market-share = 14
      expect(facts).toHaveLength(14);
    });

    it("loads correct number of facts for Dario Amodei (3)", () => {
      const facts = graph.getFacts("dario-amodei");
      expect(facts).toHaveLength(3);
    });

    it("loads correct number of facts for Jan Leike (3)", () => {
      const facts = graph.getFacts("jan-leike");
      expect(facts).toHaveLength(3);
    });

    it("normalizes number values as {type: 'number'}", () => {
      const revenueFacts = graph.getFacts("anthropic", {
        property: "revenue",
      });
      expect(revenueFacts.length).toBeGreaterThan(0);
      for (const fact of revenueFacts) {
        expect(fact.value.type).toBe("number");
        expect(typeof (fact.value as { type: "number"; value: number }).value).toBe("number");
      }
    });

    it("normalizes ref values as {type: 'ref'}", () => {
      const employedByFacts = graph.getFacts("jan-leike", {
        property: "employed-by",
      });
      expect(employedByFacts).toHaveLength(2);
      for (const fact of employedByFacts) {
        expect(fact.value.type).toBe("ref");
      }
    });

    it("normalizes date values as {type: 'date'}", () => {
      const foundedFacts = graph.getFacts("anthropic", {
        property: "founded-date",
      });
      expect(foundedFacts).toHaveLength(1);
      expect(foundedFacts[0].value).toEqual({
        type: "date",
        value: "2021-01",
      });
    });

    it("normalizes text values as {type: 'text'}", () => {
      const hqFacts = graph.getFacts("anthropic", {
        property: "headquarters",
      });
      expect(hqFacts).toHaveLength(1);
      expect(hqFacts[0].value).toEqual({
        type: "text",
        value: "San Francisco, CA",
      });
    });

    it("preserves temporal metadata (asOf and validEnd)", () => {
      const janFacts = graph.getFacts("jan-leike", {
        property: "employed-by",
      });
      // One fact has validEnd (the OpenAI one)
      const openAiFact = janFacts.find(
        (f) => f.value.type === "ref" && f.value.value === "openai"
      );
      expect(openAiFact).toBeDefined();
      expect(openAiFact!.asOf).toBe("2021-01");
      expect(openAiFact!.validEnd).toBe("2024-05");

      // One fact has no validEnd (the Anthropic one)
      const anthropicFact = janFacts.find(
        (f) => f.value.type === "ref" && f.value.value === "anthropic"
      );
      expect(anthropicFact).toBeDefined();
      expect(anthropicFact!.asOf).toBe("2024-05");
      expect(anthropicFact!.validEnd).toBeUndefined();
    });

    it("preserves source and notes metadata", () => {
      const foundedFacts = graph.getFacts("anthropic", {
        property: "founded-date",
      });
      expect(foundedFacts[0].source).toBe("https://anthropic.com/company");
      expect(foundedFacts[0].notes).toBe(
        "Founded by seven former OpenAI researchers in January 2021"
      );
    });
  });

  describe("item collections", () => {
    it("loads funding-rounds collection for Anthropic", () => {
      const rounds = graph.getItems("anthropic", "funding-rounds");
      expect(rounds).toHaveLength(9);
    });

    it("loads key-people collection for Anthropic", () => {
      const people = graph.getItems("anthropic", "key-people");
      expect(people).toHaveLength(7);
    });

    it("item entries have correct keys and field values", () => {
      const rounds = graph.getItems("anthropic", "funding-rounds");
      const seed = rounds.find((r) => r.key === "seed");
      expect(seed).toBeDefined();
      expect(seed!.fields.date).toBe("2021-04");
      expect(seed!.fields.amount).toBe(124e6);
      expect(seed!.fields.valuation).toBe(550e6);
      expect(seed!.fields.lead_investor).toBe("jaan-tallinn");
    });

    it("returns empty array for non-existent collection", () => {
      const items = graph.getItems("anthropic", "nonexistent");
      expect(items).toEqual([]);
    });

    it("returns empty array for non-existent thing", () => {
      const items = graph.getItems("nonexistent", "funding-rounds");
      expect(items).toEqual([]);
    });
  });
});
