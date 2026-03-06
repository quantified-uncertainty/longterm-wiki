import { describe, it, expect, beforeAll, vi } from "vitest";
import path from "node:path";
import { loadKB } from "../src/loader.ts";
import { validate, validateThing } from "../src/validate.ts";
import { Graph } from "../src/graph.ts";
import type { ValidationResult } from "../src/types.ts";

const DATA_DIR = path.resolve(__dirname, "../data");

describe("validate", () => {
  let graph: Graph;

  beforeAll(async () => {
    graph = await loadKB(DATA_DIR);
  });

  describe("validateThing — anthropic (organization)", () => {
    let results: ValidationResult[];

    beforeAll(() => {
      results = validateThing(graph, "anthropic");
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

  describe("validateThing — person schemas", () => {
    it("person with all recommended properties has no warnings", () => {
      // Dario has employed-by, role, and born-year
      const results = validateThing(graph, "dario-amodei");
      const recommendedWarnings = results.filter(
        (r) => r.rule === "recommended-properties"
      );
      expect(recommendedWarnings).toHaveLength(0);
    });

    it("person missing recommended properties gets warnings", () => {
      // Jan Leike has employed-by and role but NO born-year
      const results = validateThing(graph, "jan-leike");
      const recommendedWarnings = results.filter(
        (r) => r.rule === "recommended-properties"
      );
      expect(recommendedWarnings).toHaveLength(1);
      expect(recommendedWarnings[0].message).toContain("born-year");
    });
  });

  describe("ref-integrity", () => {
    it("catches refs to non-existent things", () => {
      // Jan Leike references "openai" which is not in our test data
      const results = validateThing(graph, "jan-leike");
      const refErrors = results.filter((r) => r.rule === "ref-integrity");
      expect(refErrors.length).toBeGreaterThan(0);

      const openaiRef = refErrors.find((r) => r.message.includes("openai"));
      expect(openaiRef).toBeDefined();
      expect(openaiRef!.severity).toBe("error");
    });

    it("does not flag refs to existing things", () => {
      // Dario references "anthropic" which exists
      const results = validateThing(graph, "dario-amodei");
      const refErrors = results.filter((r) => r.rule === "ref-integrity");
      expect(refErrors).toHaveLength(0);
    });
  });

  describe("item-collection-schema validation", () => {
    it("validates item entries against schema", () => {
      const results = validateThing(graph, "anthropic");
      const itemResults = results.filter(
        (r) => r.rule === "item-collection-schema"
      );
      // The anthropic data has funding-round entries with lead_investor referencing
      // things not in our test graph (ftx, amazon, google, gic, jaan-tallinn).
      // These should produce type warnings since they reference non-existent things.
      const refWarnings = itemResults.filter(
        (r) =>
          r.severity === "warning" && r.message.includes("unknown thing")
      );
      expect(refWarnings.length).toBeGreaterThan(0);
    });

    it("does not report errors for required fields that are present", () => {
      // funding-rounds schema requires 'date', key-people requires 'person' and 'title'
      // All entries in our test data provide these fields
      const results = validateThing(graph, "anthropic");
      const requiredFieldErrors = results.filter(
        (r) =>
          r.rule === "item-collection-schema" &&
          r.severity === "error" &&
          r.message.includes("missing required field")
      );
      expect(requiredFieldErrors).toHaveLength(0);
    });

    it("validates key-people person refs against the graph", () => {
      const results = validateThing(graph, "anthropic");
      const itemResults = results.filter(
        (r) =>
          r.rule === "item-collection-schema" &&
          r.message.includes("key-people")
      );
      // Some key-people reference persons not in the graph
      // (daniela-amodei, chris-olah, tom-brown, mike-krieger, holden-karnofsky)
      const unknownPeople = itemResults.filter(
        (r) => r.message.includes("unknown thing")
      );
      expect(unknownPeople.length).toBeGreaterThan(0);
    });
  });

  describe("validate (full graph)", () => {
    it("returns results for all things", () => {
      const results = validate(graph);

      // Should have results for anthropic, dario-amodei, and jan-leike
      const thingIds = new Set(results.map((r) => r.thingId).filter(Boolean));
      expect(thingIds.has("anthropic")).toBe(true);
      expect(thingIds.has("dario-amodei")).toBe(true);
      expect(thingIds.has("jan-leike")).toBe(true);
    });

    it("includes completeness info for every thing", () => {
      const results = validate(graph);
      const completeness = results.filter((r) => r.rule === "completeness");
      expect(completeness).toHaveLength(3); // one per thing
    });

    it("properly categorizes severity levels", () => {
      const results = validate(graph);

      const errors = results.filter((r) => r.severity === "error");
      const warnings = results.filter((r) => r.severity === "warning");
      const infos = results.filter((r) => r.severity === "info");

      // There should be at least some errors (ref-integrity for openai)
      expect(errors.length).toBeGreaterThan(0);
      // There should be at least some warnings (recommended properties, or item ref warnings)
      expect(warnings.length).toBeGreaterThan(0);
      // There should be info messages (completeness for all 3 things)
      expect(infos.length).toBe(3);
    });
  });

  describe("validateThing — edge cases", () => {
    it("returns error for non-existent thing", () => {
      const results = validateThing(graph, "nonexistent");
      expect(results).toHaveLength(1);
      expect(results[0].severity).toBe("error");
      expect(results[0].rule).toBe("thing-exists");
    });

    it("returns warning for thing with no registered schema", () => {
      // Create a minimal graph with a thing of unknown type
      const minGraph = new Graph();
      minGraph.addThing({
        id: "test-product",
        stableId: "abc123def0",
        type: "product",
        name: "Test Product",
      });

      const results = validateThing(minGraph, "test-product");
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
      minGraph.addThing({
        id: "empty-org",
        stableId: "xyz456abc0",
        type: "organization",
        name: "Empty Org",
      });

      const results = validateThing(minGraph, "empty-org");
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
    it("warns when property is used on wrong thing type", () => {
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
      testGraph.addThing({
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

      const results = validateThing(testGraph, "wrong-type");
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
