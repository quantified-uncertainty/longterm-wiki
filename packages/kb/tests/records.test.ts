import { describe, it, expect, beforeAll } from "vitest";
import type { Graph } from "../src/graph";
import { loadTestKB } from "./test-helpers";

describe("records", () => {
  let graph: Graph;
  let idOf: (filename: string) => string;

  beforeAll(async () => {
    ({ graph, idOf } = await loadTestKB());
  });

  describe("record schemas", () => {
    it("loads all record schemas from schemas/records/", () => {
      const schemas = graph.getAllRecordSchemas();
      expect(schemas.length).toBeGreaterThanOrEqual(14);
    });

    it("loads investment schema with correct endpoints", () => {
      const schema = graph.getRecordSchema("investment");
      expect(schema).toBeDefined();
      expect(schema!.name).toBe("Investment Participation");

      // investor endpoint: explicit, required, allows display_name
      expect(schema!.endpoints.investor).toBeDefined();
      expect(schema!.endpoints.investor.types).toEqual(["person", "organization"]);
      expect(schema!.endpoints.investor.implicit).toBeUndefined();
      expect(schema!.endpoints.investor.required).toBe(true);
      expect(schema!.endpoints.investor.allowDisplayName).toBe(true);

      // company endpoint: implicit
      expect(schema!.endpoints.company).toBeDefined();
      expect(schema!.endpoints.company.implicit).toBe(true);
    });

    it("loads equity-position schema as temporal", () => {
      const schema = graph.getRecordSchema("equity-position");
      expect(schema).toBeDefined();
      expect(schema!.temporal).toBe(true);
    });

    it("loads funding-round schema with single implicit endpoint", () => {
      const schema = graph.getRecordSchema("funding-round");
      expect(schema).toBeDefined();
      expect(Object.keys(schema!.endpoints)).toEqual(["company"]);
      expect(schema!.endpoints.company.implicit).toBe(true);
    });

    it("loads charitable-pledge schema with explicit pledger endpoint", () => {
      const schema = graph.getRecordSchema("charitable-pledge");
      expect(schema).toBeDefined();
      expect(schema!.endpoints.pledger.types).toEqual(["person"]);
      // After migration: pledger is explicit (required, allow_display_name)
      expect(schema!.endpoints.pledger.required).toBe(true);
      expect(schema!.endpoints.pledger.allowDisplayName).toBe(true);
    });
  });

  describe("collectionName in record schemas", () => {
    it("all record schemas have explicit collectionName", () => {
      const schemas = graph.getAllRecordSchemas();
      for (const schema of schemas) {
        expect(schema.collectionName, `schema "${schema.id}" missing collectionName`).toBeDefined();
      }
    });

    it("funding-round schema has collectionName 'funding-rounds'", () => {
      const schema = graph.getRecordSchema("funding-round");
      expect(schema!.collectionName).toBe("funding-rounds");
    });

    it("career-history schema has collectionName 'career-history'", () => {
      const schema = graph.getRecordSchema("career-history");
      expect(schema!.collectionName).toBe("career-history");
    });

    it("grant schema has collectionName 'grants'", () => {
      const schema = graph.getRecordSchema("grant");
      expect(schema!.collectionName).toBe("grants");
    });

    it("collectionName values are unique across schemas", () => {
      const schemas = graph.getAllRecordSchemas();
      const names = schemas.map((s) => s.collectionName).filter(Boolean);
      const unique = new Set(names);
      expect(unique.size).toBe(names.length);
    });

    it("getRecordSchemaByCollectionName resolves to correct schema", () => {
      const schema = graph.getRecordSchemaByCollectionName("funding-rounds");
      expect(schema).toBeDefined();
      expect(schema!.id).toBe("funding-round");
    });

    it("getRecordSchemaByCollectionName returns undefined for unknown name", () => {
      const schema = graph.getRecordSchemaByCollectionName("nonexistent");
      expect(schema).toBeUndefined();
    });
  });

  describe("entity type schema records list", () => {
    it("organization schema lists record types", () => {
      const orgSchema = graph.getSchema("organization");
      expect(orgSchema!.records).toBeDefined();
      expect(orgSchema!.records).toContain("funding-round");
      expect(orgSchema!.records).toContain("investment");
      expect(orgSchema!.records).toContain("equity-position");
      expect(orgSchema!.records).toContain("board-seat");
      expect(orgSchema!.records).toContain("charitable-pledge");
    });

    it("person schema lists record types", () => {
      const personSchema = graph.getSchema("person");
      expect(personSchema!.records).toBeDefined();
      expect(personSchema!.records).toContain("charitable-pledge");
      expect(personSchema!.records).toContain("career-history");
    });
  });

  describe("record loading from entity files", () => {
    it("loads equity-position records from Anthropic", () => {
      const positions = graph.getRecords(idOf("anthropic"), "equity-positions");
      expect(positions.length).toBeGreaterThanOrEqual(10);

      // Find the Tallinn entry
      const tallinn = positions.find((p) => p.key === "jaan-tallinn");
      expect(tallinn).toBeDefined();
      expect(tallinn!.schema).toBe("equity-position");
      expect(tallinn!.ownerEntityId).toBe(idOf("anthropic"));
      expect(tallinn!.fields.holder).toBe("jaan-tallinn");
      expect(tallinn!.fields.stake).toEqual([0.006, 0.017]);
    });

    it("handles display_name for non-entity participants", () => {
      const positions = graph.getRecords(idOf("anthropic"), "equity-positions");
      const pool = positions.find((p) => p.key === "employee-pool");
      expect(pool).toBeDefined();
      expect(pool!.displayName).toBe("Employee equity pool");
      expect(pool!.fields.holder).toBeUndefined();
    });

    it("loads investment records from Anthropic", () => {
      const investments = graph.getRecords(idOf("anthropic"), "investments");
      expect(investments.length).toBeGreaterThanOrEqual(10);

      const tallinnSeed = investments.find((i) => i.key === "tallinn-seed");
      expect(tallinnSeed).toBeDefined();
      expect(tallinnSeed!.schema).toBe("investment");
      expect(tallinnSeed!.fields.investor).toBe("jaan-tallinn");
      expect(tallinnSeed!.fields.role).toBe("lead");
    });

    it("loads funding-round records from Anthropic", () => {
      const rounds = graph.getRecords(idOf("anthropic"), "funding-rounds");
      expect(rounds.length).toBeGreaterThanOrEqual(15);

      const seriesA = rounds.find((r) => r.key === "series-a");
      expect(seriesA).toBeDefined();
      expect(seriesA!.fields.raised).toBe(124e6);
      expect(seriesA!.fields.valuation).toBe(550e6);
    });

    it("loads charitable-pledge records from Anthropic", () => {
      const pledges = graph.getRecords(idOf("anthropic"), "charitable-pledges");
      expect(pledges.length).toBeGreaterThanOrEqual(9);

      const dario = pledges.find((p) => p.key === "dario-amodei");
      expect(dario).toBeDefined();
      expect(dario!.fields.pledger).toBe("dario-amodei");
      expect(dario!.fields.pledge).toBe(0.8);
    });

    it("loads key-person records from Anthropic", () => {
      const people = graph.getRecords(idOf("anthropic"), "key-persons");
      expect(people.length).toBeGreaterThanOrEqual(10);

      const dario = people.find((p) => p.key === "dario-amodei");
      expect(dario).toBeDefined();
      expect(dario!.fields.person).toBe("dario-amodei");
      expect(dario!.fields.title).toBe("CEO");
    });

    it("returns collection names for entity", () => {
      const names = graph.getRecordCollectionNames(idOf("anthropic"));
      expect(names).toContain("equity-positions");
      expect(names).toContain("investments");
      expect(names).toContain("funding-rounds");
      expect(names).toContain("charitable-pledges");
      expect(names).toContain("key-persons");
      expect(names).toContain("products");
      expect(names).toContain("model-releases");
      expect(names).toContain("board-seats");
      expect(names).toContain("strategic-partnerships");
      expect(names).toContain("safety-milestones");
      expect(names).toContain("research-areas");
    });
  });

  describe("endpoint index", () => {
    it("indexes records by explicit endpoint (investor)", () => {
      // Record fields store slugs (not entity IDs) as references, so look up by slug
      const tallinnRecords = graph.getRecordsReferencing("jaan-tallinn");
      expect(tallinnRecords.length).toBeGreaterThanOrEqual(3);

      // Should include equity-position, investment, and charitable-pledge
      const schemas = new Set(tallinnRecords.map((r) => r.schema));
      expect(schemas.has("equity-position")).toBe(true);
      expect(schemas.has("investment")).toBe(true);
      expect(schemas.has("charitable-pledge")).toBe(true);
    });

    it("filters endpoint index by collection name", () => {
      const tallinnEquity = graph.getRecordsReferencing("jaan-tallinn", "equity-positions");
      expect(tallinnEquity).toHaveLength(1);
      expect(tallinnEquity[0].fields.stake).toEqual([0.006, 0.017]);

      const tallinnInvestments = graph.getRecordsReferencing("jaan-tallinn", "investments");
      expect(tallinnInvestments.length).toBeGreaterThanOrEqual(2); // seed + series-a
    });

    it("does not index display_name entries in endpoint index", () => {
      // "Employee equity pool" has no entity ref, so it shouldn't appear anywhere
      const poolRefs = graph.getRecordsReferencing("Employee equity pool");
      expect(poolRefs).toHaveLength(0);
    });

    it("returns empty array for entities with no records referencing them", () => {
      const refs = graph.getRecordsReferencing("nonexistent-entity");
      expect(refs).toHaveLength(0);
    });
  });

  describe("cross-entity queries", () => {
    it("getAllRecordsOfType returns records across entities", () => {
      const allInvestments = graph.getAllRecordsOfType("investment");
      expect(allInvestments.length).toBeGreaterThanOrEqual(10);

      // All should have schema = "investment"
      for (const inv of allInvestments) {
        expect(inv.schema).toBe("investment");
      }
    });

    it("getAllRecordsOfType returns empty for unused schema", () => {
      const results = graph.getAllRecordsOfType("nonexistent-schema");
      expect(results).toHaveLength(0);
    });
  });

  describe("1-endpoint record types", () => {
    it("loads product records", () => {
      const products = graph.getRecords(idOf("anthropic"), "products");
      expect(products.length).toBeGreaterThanOrEqual(5);

      const claudeCode = products.find((p) => p.key === "claude-code");
      expect(claudeCode).toBeDefined();
      expect(claudeCode!.fields.name).toBe("Claude Code");
    });

    it("loads model-release records", () => {
      const models = graph.getRecords(idOf("anthropic"), "model-releases");
      expect(models.length).toBeGreaterThanOrEqual(10);

      const opus46 = models.find((m) => m.key === "claude-opus-4-6");
      expect(opus46).toBeDefined();
      expect(opus46!.fields.safety_level).toBe("ASL-3");
    });

    it("loads board-seat records with display_name", () => {
      const seats = graph.getRecords(idOf("anthropic"), "board-seats");
      expect(seats.length).toBeGreaterThanOrEqual(4);

      // Dario has entity ref
      const dario = seats.find((s) => s.key === "dario-amodei");
      expect(dario).toBeDefined();
      expect(dario!.fields.member).toBe("dario-amodei");

      // Yasmin uses display_name
      const yasmin = seats.find((s) => s.key === "yasmin-razavi");
      expect(yasmin).toBeDefined();
      expect(yasmin!.displayName).toBe("Yasmin Razavi");
    });

    it("loads safety-milestone records", () => {
      const milestones = graph.getRecords(idOf("anthropic"), "safety-milestones");
      expect(milestones.length).toBeGreaterThanOrEqual(8);
    });

    it("loads research-area records", () => {
      const areas = graph.getRecords(idOf("anthropic"), "research-areas");
      expect(areas.length).toBeGreaterThanOrEqual(4);

      const interp = areas.find((a) => a.key === "mechanistic-interpretability");
      expect(interp).toBeDefined();
      expect(interp!.fields["team-size"]).toBe(50);
    });

    it("loads strategic-partnership records with display_name", () => {
      const partnerships = graph.getRecords(idOf("anthropic"), "strategic-partnerships");
      expect(partnerships.length).toBeGreaterThanOrEqual(4);

      const aws = partnerships.find((p) => p.key === "aws-investment");
      expect(aws).toBeDefined();
      expect(aws!.displayName).toBe("Amazon Web Services");
    });
  });
});
