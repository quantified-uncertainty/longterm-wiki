import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { loadKB } from "../src/loader";
import type { Graph } from "../src/graph";

const DATA_DIR = path.resolve(__dirname, "../data");

describe("loader", () => {
  let graph: Graph;
  let idOf: (filename: string) => string;

  beforeAll(async () => {
    const result = await loadKB(DATA_DIR);
    graph = result.graph;
    // Build reverse lookup: filename → entityId for test convenience
    const reverseMap = new Map<string, string>();
    for (const [entityId, filename] of result.filenameMap) {
      reverseMap.set(filename, entityId);
    }
    idOf = (filename: string) => {
      const id = reverseMap.get(filename);
      if (!id) throw new Error(`No entity for filename "${filename}"`);
      return id;
    };
  });

  describe("entities", () => {
    it("loads Anthropic from disk", () => {
      const anthropic = graph.getEntity(idOf("anthropic"));
      expect(anthropic).toBeDefined();
      expect(anthropic!.name).toBe("Anthropic");
      expect(anthropic!.id).toBe("mK9pX3rQ7n");
      expect(anthropic!.type).toBe("organization");
      expect(anthropic!.wikiPageId).toBe("E22");
      // Deprecated aliases still work
      expect(anthropic!.stableId).toBe("mK9pX3rQ7n");
      expect(anthropic!.numericId).toBe("E22");
    });

    it("loads all entities (360+ after bulk migration)", () => {
      const entities = graph.getAllEntities();
      expect(entities.length).toBeGreaterThanOrEqual(360);

      // Spot-check key entities are present via name lookup
      const names = new Set(entities.map((t) => t.name));
      expect(names.has("Anthropic")).toBe(true);
      expect(names.has("OpenAI")).toBe(true);
    });

    it("loads entity aliases", () => {
      const anthropic = graph.getEntity(idOf("anthropic"));
      expect(anthropic!.aliases).toEqual(["Anthropic PBC", "Anthropic AI"]);
    });

    it("all wikiPageIds use E-prefix format and are unique", () => {
      const entities = graph.getAllEntities();
      const wikiPageIds = entities
        .map((e) => e.wikiPageId)
        .filter((id): id is string => id !== undefined);

      // All have wikiPageIds
      expect(wikiPageIds).toHaveLength(entities.length);

      // All match E-prefix format
      for (const id of wikiPageIds) {
        expect(String(id)).toMatch(/^E\d+$/);
      }

      // All unique
      const unique = new Set(wikiPageIds);
      expect(unique.size).toBe(wikiPageIds.length);
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

    it("loads record collection schemas on organization", () => {
      const orgSchema = graph.getSchema("organization");
      expect(orgSchema!.records).toBeDefined();
      expect(orgSchema!.records).toContain("funding-round");
      expect(orgSchema!.records).toContain("key-person");

      // Verify the record schemas themselves are loaded
      const frSchema = graph.getRecordSchema("funding-round");
      expect(frSchema).toBeDefined();
      expect(frSchema!.fields["date"].required).toBe(true);
      expect(frSchema!.fields["date"].type).toBe("date");
      expect(frSchema!.fields["raised"].type).toBe("number");
      expect(frSchema!.fields["lead_investor"].type).toBe("ref");
    });
  });

  describe("facts", () => {
    it("loads correct number of facts for Anthropic (52)", () => {
      const facts = graph.getFacts(idOf("anthropic"));
      expect(facts).toHaveLength(52);
    });

    it("loads correct number of facts for Dario Amodei (9)", () => {
      const facts = graph.getFacts(idOf("dario-amodei"));
      expect(facts).toHaveLength(9);
    });

    it("loads correct number of facts for Jan Leike (9)", () => {
      const facts = graph.getFacts(idOf("jan-leike"));
      expect(facts).toHaveLength(9);
    });

    it("normalizes number values as {type: 'number'}", () => {
      const revenueFacts = graph.getFacts(idOf("anthropic"), {
        property: "revenue",
      });
      expect(revenueFacts.length).toBeGreaterThan(0);
      for (const fact of revenueFacts) {
        expect(fact.value.type).toBe("number");
        expect(typeof (fact.value as { type: "number"; value: number }).value).toBe("number");
      }
    });

    it("normalizes ref values as {type: 'ref'}", () => {
      const employedByFacts = graph.getFacts(idOf("jan-leike"), {
        property: "employed-by",
      });
      expect(employedByFacts).toHaveLength(3);
      for (const fact of employedByFacts) {
        expect(fact.value.type).toBe("ref");
      }
    });

    it("normalizes date values as {type: 'date'}", () => {
      const foundedFacts = graph.getFacts(idOf("anthropic"), {
        property: "founded-date",
      });
      expect(foundedFacts).toHaveLength(1);
      expect(foundedFacts[0].value).toEqual({
        type: "date",
        value: "2021-01",
      });
    });

    it("normalizes text values as {type: 'text'}", () => {
      const hqFacts = graph.getFacts(idOf("anthropic"), {
        property: "headquarters",
      });
      expect(hqFacts).toHaveLength(1);
      expect(hqFacts[0].value).toEqual({
        type: "text",
        value: "San Francisco, CA",
      });
    });

    it("preserves temporal metadata (asOf and validEnd)", () => {
      const janFacts = graph.getFacts(idOf("jan-leike"), {
        property: "employed-by",
      });
      const openaiId = graph.getEntity(idOf("openai"))!.id;
      const anthropicId = graph.getEntity(idOf("anthropic"))!.id;

      // One fact has validEnd (the OpenAI one)
      const openAiFact = janFacts.find(
        (f) => f.value.type === "ref" && f.value.value === openaiId
      );
      expect(openAiFact).toBeDefined();
      expect(openAiFact!.asOf).toBe("2021-01");
      expect(openAiFact!.validEnd).toBe("2024-05");

      // One fact has no validEnd (the Anthropic one)
      const anthropicFact = janFacts.find(
        (f) => f.value.type === "ref" && f.value.value === anthropicId
      );
      expect(anthropicFact).toBeDefined();
      expect(anthropicFact!.asOf).toBe("2024-05");
      expect(anthropicFact!.validEnd).toBeUndefined();
    });

    it("preserves source and notes metadata", () => {
      const foundedFacts = graph.getFacts(idOf("anthropic"), {
        property: "founded-date",
      });
      expect(foundedFacts[0].source).toBe("https://anthropic.com/company");
      expect(foundedFacts[0].notes).toBe(
        "Founded by seven former OpenAI researchers in January 2021"
      );
    });
  });

  describe("record collections", () => {
    it("returns empty array for non-existent collection", () => {
      const records = graph.getRecords(idOf("anthropic"), "nonexistent");
      expect(records).toEqual([]);
    });

    it("returns empty array for non-existent entity", () => {
      const records = graph.getRecords("nonexistent", "funding-rounds");
      expect(records).toEqual([]);
    });
  });

  describe("record collections (data verification)", () => {
    it("loads funding-rounds records for Anthropic", () => {
      const rounds = graph.getRecords(idOf("anthropic"), "funding-rounds");
      expect(rounds.length).toBeGreaterThanOrEqual(13);
    });

    it("loads key-persons records for Anthropic", () => {
      const people = graph.getRecords(idOf("anthropic"), "key-persons");
      expect(people.length).toBeGreaterThanOrEqual(15);
    });

    it("record entries have correct keys and field values", () => {
      const rounds = graph.getRecords(idOf("anthropic"), "funding-rounds");
      const seriesA = rounds.find((r) => r.key === "series-a");
      expect(seriesA).toBeDefined();
      expect(seriesA!.fields.date).toBe("2021-05");
      expect(seriesA!.fields.raised).toBe(124e6);
      expect(seriesA!.fields.valuation).toBe(550e6);
      expect(seriesA!.fields.lead_investor).toBe("jaan-tallinn");
    });
  });
});
