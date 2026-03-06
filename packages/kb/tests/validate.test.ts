import { describe, it, expect, beforeAll, vi } from "vitest";
import path from "node:path";
import { loadKB } from "../src/loader";
import { validate, validateEntity } from "../src/validate";
import { Graph } from "../src/graph";
import type { ValidationResult } from "../src/types";

const DATA_DIR = path.resolve(__dirname, "../data");

describe("validate", () => {
  let graph: Graph;

  beforeAll(async () => {
    graph = await loadKB(DATA_DIR);
  });

  describe("validateEntity — anthropic (organization)", () => {
    let results: ValidationResult[];

    beforeAll(() => {
      results = validateEntity(graph, "anthropic");
    });

    it("has no required-property errors (founded-date and headquarters present)", () => {
      const requiredErrors = results.filter(
        (r) => r.rule === "required-properties" && r.severity === "error"
      );
      expect(requiredErrors).toHaveLength(0);
    });

    it("has a completeness info message showing percentage", () => {
      const completeness = results.filter((r) => r.rule === "completeness");
      expect(completeness).toHaveLength(1);
      expect(completeness[0].severity).toBe("info");
      expect(completeness[0].message).toContain("Completeness");
      expect(completeness[0].message).toMatch(/\d+%/);
    });

    it("completeness shows high percentage for well-populated entity", () => {
      const completeness = results.find((r) => r.rule === "completeness");
      // Anthropic has all 7 required+recommended properties:
      // required: founded-date, headquarters (2)
      // recommended: revenue, valuation, headcount, legal-structure, total-funding (5)
      // Total: 7/7 = 100%
      expect(completeness!.message).toContain("100%");
    });

    it("has no recommended-property warnings (all recommended are present)", () => {
      const recommendedWarnings = results.filter(
        (r) => r.rule === "recommended-properties" && r.severity === "warning"
      );
      expect(recommendedWarnings).toHaveLength(0);
    });
  });

  describe("validateEntity — person schemas", () => {
    it("person with all recommended properties has no warnings", () => {
      // Dario has employed-by, role, and born-year
      const results = validateEntity(graph, "dario-amodei");
      const recommendedWarnings = results.filter(
        (r) => r.rule === "recommended-properties"
      );
      expect(recommendedWarnings).toHaveLength(0);
    });

    it("person missing recommended properties gets warnings", () => {
      // Jan Leike has employed-by and role but NO born-year
      const results = validateEntity(graph, "jan-leike");
      const recommendedWarnings = results.filter(
        (r) => r.rule === "recommended-properties"
      );
      expect(recommendedWarnings).toHaveLength(1);
      expect(recommendedWarnings[0].message).toContain("born-year");
    });
  });

  describe("ref-integrity", () => {
    it("catches refs to non-existent entities", () => {
      // OpenAI key-people reference persons not in our test data (e.g., ilya-sutskever)
      const results = validateEntity(graph, "openai");
      const refErrors = results.filter((r) => r.rule === "ref-integrity" || r.rule === "item-collection-schema");
      // There should be warnings for referenced persons not in the graph
      expect(refErrors.length).toBeGreaterThan(0);
    });

    it("does not flag refs to existing entities", () => {
      // Dario references "anthropic" which exists
      const results = validateEntity(graph, "dario-amodei");
      const refErrors = results.filter((r) => r.rule === "ref-integrity");
      expect(refErrors).toHaveLength(0);
    });
  });

  describe("item-collection-schema validation", () => {
    it("validates item entries against schema", () => {
      const results = validateEntity(graph, "anthropic");
      const itemResults = results.filter(
        (r) => r.rule === "item-collection-schema"
      );
      // The anthropic data has funding-round entries with lead_investor referencing
      // entities not in our test graph (ftx, amazon, google, gic, jaan-tallinn).
      // These should produce type warnings since they reference non-existent entities.
      const refWarnings = itemResults.filter(
        (r) =>
          r.severity === "warning" && r.message.includes("unknown entity")
      );
      expect(refWarnings.length).toBeGreaterThan(0);
    });

    it("does not report errors for required fields that are present", () => {
      // funding-rounds schema requires 'date', key-people requires 'person' and 'title'
      // All entries in our test data provide these fields
      const results = validateEntity(graph, "anthropic");
      const requiredFieldErrors = results.filter(
        (r) =>
          r.rule === "item-collection-schema" &&
          r.severity === "error" &&
          r.message.includes("missing required field")
      );
      expect(requiredFieldErrors).toHaveLength(0);
    });

    it("validates key-people person refs against the graph", () => {
      const results = validateEntity(graph, "anthropic");
      const itemResults = results.filter(
        (r) =>
          r.rule === "item-collection-schema" &&
          r.message.includes("key-people")
      );
      // Some key-people reference persons not in the graph
      // (daniela-amodei, chris-olah, tom-brown, mike-krieger, holden-karnofsky)
      const unknownPeople = itemResults.filter(
        (r) => r.message.includes("unknown entity")
      );
      expect(unknownPeople.length).toBeGreaterThan(0);
    });
  });

  describe("validate (full graph)", () => {
    it("returns results for all entities", () => {
      const results = validate(graph);

      // Should have results for all 16 entities
      const entityIds = new Set(results.map((r) => r.entityId).filter(Boolean));
      expect(entityIds.has("anthropic")).toBe(true);
      expect(entityIds.has("dario-amodei")).toBe(true);
      expect(entityIds.has("jan-leike")).toBe(true);
    });

    it("includes completeness info for every entity", () => {
      const results = validate(graph);
      const completeness = results.filter((r) => r.rule === "completeness");
      expect(completeness).toHaveLength(30); // one per entity
    });

    it("properly categorizes severity levels", () => {
      const results = validate(graph);

      const warnings = results.filter((r) => r.severity === "warning");
      const infos = results.filter((r) => r.severity === "info");

      // There should be at least some warnings (recommended properties, or item ref warnings)
      expect(warnings.length).toBeGreaterThan(0);
      // There should be info messages (completeness for all 30 entities)
      expect(infos.length).toBe(30);
    });
  });

  describe("validateEntity — edge cases", () => {
    it("returns error for non-existent entity", () => {
      const results = validateEntity(graph, "nonexistent");
      expect(results).toHaveLength(1);
      expect(results[0].severity).toBe("error");
      expect(results[0].rule).toBe("entity-exists");
    });

    it("returns warning for entity with no registered schema", () => {
      // Create a minimal graph with an entity of unknown type
      const minGraph = new Graph();
      minGraph.addEntity({
        id: "test-product",
        stableId: "abc123def0",
        type: "product",
        name: "Test Product",
      });

      const results = validateEntity(minGraph, "test-product");
      expect(results).toHaveLength(1);
      expect(results[0].severity).toBe("warning");
      expect(results[0].rule).toBe("schema-exists");
      expect(results[0].message).toContain("product");
    });

    it("validates required fields are missing in a minimal graph", () => {
      // Create a minimal org with no facts
      const minGraph = new Graph();
      minGraph.addSchema({
        type: "organization",
        name: "Organization",
        required: ["founded-date", "headquarters"],
        recommended: ["revenue"],
      });
      minGraph.addEntity({
        id: "empty-org",
        stableId: "xyz456abc0",
        type: "organization",
        name: "Empty Org",
      });

      const results = validateEntity(minGraph, "empty-org");
      const requiredErrors = results.filter(
        (r) => r.rule === "required-properties"
      );
      expect(requiredErrors).toHaveLength(2);
      expect(requiredErrors.map((r) => r.propertyId).sort()).toEqual([
        "founded-date",
        "headquarters",
      ]);
    });
  });

  describe("property-applies-to check", () => {
    it("warns when property is used on wrong entity type", () => {
      // Create a scenario where a "revenue" fact is on a person (wrong type)
      const testGraph = new Graph();
      testGraph.addSchema({
        type: "person",
        name: "Person",
        required: [],
        recommended: [],
      });
      testGraph.addProperty({
        id: "revenue",
        name: "Revenue",
        dataType: "number",
        appliesTo: ["organization"],
      });
      testGraph.addEntity({
        id: "wrong-type",
        stableId: "abc123def0",
        type: "person",
        name: "Wrong Type",
      });
      testGraph.addFact({
        id: "f_test123456",
        subjectId: "wrong-type",
        propertyId: "revenue",
        value: { type: "number", value: 1000 },
      });

      const results = validateEntity(testGraph, "wrong-type");
      const appliesToWarnings = results.filter(
        (r) => r.rule === "property-applies-to"
      );
      expect(appliesToWarnings).toHaveLength(1);
      expect(appliesToWarnings[0].severity).toBe("warning");
      expect(appliesToWarnings[0].message).toContain("organization");
      expect(appliesToWarnings[0].message).toContain("person");
    });
  });
});
