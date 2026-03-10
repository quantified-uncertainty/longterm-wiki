import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { loadKB } from "../src/loader";
import type { Graph } from "../src/graph";

const DATA_DIR = path.resolve(__dirname, "../data");

describe("records", () => {
  let graph: Graph;

  beforeAll(async () => {
    graph = await loadKB(DATA_DIR);
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

    it("loads charitable-pledge schema for person entities", () => {
      const schema = graph.getRecordSchema("charitable-pledge");
      expect(schema).toBeDefined();
      expect(schema!.endpoints.pledger.types).toEqual(["person"]);
      expect(schema!.endpoints.pledger.implicit).toBe(true);
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
      const positions = graph.getRecords("anthropic", "equity-positions");
      expect(positions.length).toBeGreaterThanOrEqual(2);

      // Find the Tallinn entry
      const tallinn = positions.find((p) => p.key === "tallinn-test");
      expect(tallinn).toBeDefined();
      expect(tallinn!.schema).toBe("equity-position");
      expect(tallinn!.ownerEntityId).toBe("anthropic");
      expect(tallinn!.fields.holder).toBe("jaan-tallinn");
      expect(tallinn!.fields.stake).toEqual([0.006, 0.017]);
      expect(tallinn!.asOf).toBe("2026-03");
    });

    it("handles display_name for non-entity participants", () => {
      const positions = graph.getRecords("anthropic", "equity-positions");
      const pool = positions.find((p) => p.key === "employee-pool-test");
      expect(pool).toBeDefined();
      expect(pool!.displayName).toBe("Employee equity pool");
      expect(pool!.fields.holder).toBeUndefined();
    });

    it("loads investment records from Anthropic", () => {
      const investments = graph.getRecords("anthropic", "investments");
      expect(investments.length).toBeGreaterThanOrEqual(1);

      const tallinnSeed = investments.find((i) => i.key === "tallinn-seed-test");
      expect(tallinnSeed).toBeDefined();
      expect(tallinnSeed!.schema).toBe("investment");
      expect(tallinnSeed!.fields.investor).toBe("jaan-tallinn");
      expect(tallinnSeed!.fields.role).toBe("lead");
      expect(tallinnSeed!.fields.amount).toEqual([40e6, 80e6]);
    });

    it("returns collection names for entity", () => {
      const names = graph.getRecordCollectionNames("anthropic");
      expect(names).toContain("equity-positions");
      expect(names).toContain("investments");
    });
  });

  describe("endpoint index", () => {
    it("indexes records by explicit endpoint (investor)", () => {
      const tallinnRecords = graph.getRecordsReferencing("jaan-tallinn");
      expect(tallinnRecords.length).toBeGreaterThanOrEqual(2);

      // Should include both equity-position and investment
      const schemas = new Set(tallinnRecords.map((r) => r.schema));
      expect(schemas.has("equity-position")).toBe(true);
      expect(schemas.has("investment")).toBe(true);
    });

    it("filters endpoint index by collection name", () => {
      const tallinnEquity = graph.getRecordsReferencing("jaan-tallinn", "equity-positions");
      expect(tallinnEquity).toHaveLength(1);
      expect(tallinnEquity[0].fields.stake).toEqual([0.006, 0.017]);

      const tallinnInvestments = graph.getRecordsReferencing("jaan-tallinn", "investments");
      expect(tallinnInvestments).toHaveLength(1);
      expect(tallinnInvestments[0].fields.role).toBe("lead");
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
      expect(allInvestments.length).toBeGreaterThanOrEqual(1);

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

  describe("coexistence with items", () => {
    it("items still load correctly alongside records", () => {
      // Old items should still work
      const fundingRounds = graph.getItems("anthropic", "funding-rounds");
      expect(fundingRounds.length).toBeGreaterThan(0);

      const keyPeople = graph.getItems("anthropic", "key-people");
      expect(keyPeople.length).toBeGreaterThan(0);
    });

    it("items and records are separate indices", () => {
      // Old equity-holders in items
      const oldEquity = graph.getItems("anthropic", "equity-holders");
      expect(oldEquity.length).toBeGreaterThan(0);

      // New equity-positions in records
      const newEquity = graph.getRecords("anthropic", "equity-positions");
      expect(newEquity.length).toBeGreaterThan(0);

      // They're independent
      expect(oldEquity[0]).not.toHaveProperty("schema");
    });
  });
});
