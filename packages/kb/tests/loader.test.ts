import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { loadKB } from "../src/loader";
import type { Graph } from "../src/graph";

const DATA_DIR = path.resolve(__dirname, "../data");

describe("loader", () => {
  let graph: Graph;

  beforeAll(async () => {
    graph = await loadKB(DATA_DIR);
  });

  describe("entities", () => {
    it("loads Anthropic from disk", () => {
      const anthropic = graph.getEntity("anthropic");
      expect(anthropic).toBeDefined();
      expect(anthropic!.name).toBe("Anthropic");
      expect(anthropic!.stableId).toBe("mK9pX3rQ7n");
      expect(anthropic!.type).toBe("organization");
      expect(anthropic!.numericId).toBe("E22");
    });

    it("loads all entities (360+ after bulk migration)", () => {
      const entities = graph.getAllEntities();
      expect(entities.length).toBeGreaterThanOrEqual(360);

      // Spot-check key entities are present (including migrated facts entities)
      const ids = new Set(entities.map((t) => t.id));
      expect(ids.has("anthropic")).toBe(true);
      expect(ids.has("openai")).toBe(true);
      expect(ids.has("deepmind")).toBe(true);
      expect(ids.has("claude-3-opus")).toBe(true);
      expect(ids.has("alignment")).toBe(true);
      expect(ids.has("existential-risk")).toBe(true);
      expect(ids.has("anthropic-government-standoff")).toBe(true);
      expect(ids.has("chan-zuckerberg-initiative")).toBe(true);
      expect(ids.has("coefficient-giving")).toBe(true);
      expect(ids.has("jaan-tallinn")).toBe(true);
      expect(ids.has("manifund")).toBe(true);
    });

    it("loads entity aliases", () => {
      const anthropic = graph.getEntity("anthropic");
      expect(anthropic!.aliases).toEqual(["Anthropic PBC", "Anthropic AI"]);
    });

    it("all numericIds use E-prefix format and are unique", () => {
      const entities = graph.getAllEntities();
      const numericIds = entities
        .map((e) => e.numericId)
        .filter((id): id is string => id !== undefined);

      // All have numericIds
      expect(numericIds).toHaveLength(entities.length);

      // All match E-prefix format
      for (const id of numericIds) {
        expect(String(id)).toMatch(/^E\d+$/);
      }

      // All unique
      const unique = new Set(numericIds);
      expect(unique.size).toBe(numericIds.length);
    });
  });

  describe("properties", () => {
    it("loads properties (68 from main + additional migration properties)", () => {
      const properties = graph.getAllProperties();
      // 68 from main + branch additions (revenue-guidance, retention-rate, customer-concentration,
      // infrastructure-investment, equity-stake-percent, equity-value, safety-staffing-ratio,
      // model-parameters, benchmark-score) = 77
      expect(properties.length).toBeGreaterThanOrEqual(68);
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
    it("loads 19 schemas", () => {
      const schemas = graph.getAllSchemas();
      expect(schemas).toHaveLength(19);
    });

    it("loads original concept entity schemas", () => {
      expect(graph.getSchema("ai-model")).toBeDefined();
      expect(graph.getSchema("risk")).toBeDefined();
      expect(graph.getSchema("approach")).toBeDefined();
      expect(graph.getSchema("debate")).toBeDefined();
      expect(graph.getSchema("capability")).toBeDefined();
      expect(graph.getSchema("concept")).toBeDefined();
    });

    it("loads new entity type schemas", () => {
      expect(graph.getSchema("event")).toBeDefined();
      expect(graph.getSchema("policy")).toBeDefined();
      expect(graph.getSchema("project")).toBeDefined();
      expect(graph.getSchema("analysis")).toBeDefined();
      expect(graph.getSchema("argument")).toBeDefined();
      expect(graph.getSchema("case-study")).toBeDefined();
      expect(graph.getSchema("funder")).toBeDefined();
      expect(graph.getSchema("historical")).toBeDefined();
      expect(graph.getSchema("risk-factor")).toBeDefined();
      expect(graph.getSchema("safety-agenda")).toBeDefined();
    });

    it("loads ai-model schema with required properties", () => {
      const modelSchema = graph.getSchema("ai-model");
      expect(modelSchema!.required).toEqual(["developed-by", "model-release-date"]);
      expect(modelSchema!.recommended).toContain("parameter-count");
      expect(modelSchema!.recommended).toContain("context-window");
    });

    it("loads risk schema with recommended properties", () => {
      const riskSchema = graph.getSchema("risk");
      expect(riskSchema!.recommended).toContain("severity-level");
      expect(riskSchema!.recommended).toContain("likelihood-estimate");
      expect(riskSchema!.recommended).toContain("evidence-strength");
    });

    it("loads organization schema with required and recommended properties", () => {
      const orgSchema = graph.getSchema("organization");
      expect(orgSchema).toBeDefined();
      expect(orgSchema!.name).toBe("Organization");
      expect(orgSchema!.required).toEqual([]);
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
    it("loads correct number of facts for Anthropic (52)", () => {
      const facts = graph.getFacts("anthropic");
      expect(facts).toHaveLength(52);
    });

    it("loads correct number of facts for Dario Amodei (9)", () => {
      const facts = graph.getFacts("dario-amodei");
      expect(facts).toHaveLength(9);
    });

    it("loads correct number of facts for Jan Leike (9)", () => {
      const facts = graph.getFacts("jan-leike");
      expect(facts).toHaveLength(9);
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
      expect(employedByFacts).toHaveLength(3);
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
      expect(rounds).toHaveLength(13);
    });

    it("loads key-people collection for Anthropic", () => {
      const people = graph.getItems("anthropic", "key-people");
      expect(people).toHaveLength(15);
    });

    it("item entries have correct keys and field values", () => {
      const rounds = graph.getItems("anthropic", "funding-rounds");
      const seed = rounds.find((r) => r.key === "i_VImpFJfKiQ");
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

    it("returns empty array for non-existent entity", () => {
      const items = graph.getItems("nonexistent", "funding-rounds");
      expect(items).toEqual([]);
    });
  });
});
