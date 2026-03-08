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

      // Should have results for all entities
      const entityIds = new Set(results.map((r) => r.entityId).filter(Boolean));
      expect(entityIds.has("anthropic")).toBe(true);
      expect(entityIds.has("dario-amodei")).toBe(true);
      expect(entityIds.has("jan-leike")).toBe(true);
    });

    it("includes completeness info for every entity", () => {
      const results = validate(graph);
      const completeness = results.filter((r) => r.rule === "completeness");
      expect(completeness.length).toBeGreaterThanOrEqual(360); // one per entity
    });

    it("properly categorizes severity levels", () => {
      const results = validate(graph);

      const warnings = results.filter((r) => r.severity === "warning");
      const infos = results.filter((r) => r.severity === "info");

      // There should be at least some warnings (recommended properties, or item ref warnings)
      expect(warnings.length).toBeGreaterThan(0);
      // There should be info messages (completeness for all 31 entities + any orphan-entity infos)
      expect(infos.length).toBeGreaterThanOrEqual(31);
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
      // schema-exists warning + orphan-entity info (no facts, no items)
      const schemaWarning = results.find((r) => r.rule === "schema-exists");
      expect(schemaWarning).toBeDefined();
      expect(schemaWarning!.severity).toBe("warning");
      expect(schemaWarning!.message).toContain("product");
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

  // ── New check tests ────────────────────────────────────────────────────────

  describe("stableid-format check", () => {
    it("accepts valid 10-char alphanumeric stableId", () => {
      const g = new Graph();
      g.addSchema({ type: "org", name: "Org", required: [], recommended: [] });
      g.addEntity({ id: "good", stableId: "aB3cD4eF5g", type: "org", name: "Good" });
      g.addFact({ id: "f_x1", subjectId: "good", propertyId: "p", value: { type: "text", value: "v" } });

      const results = validateEntity(g, "good");
      const formatErrors = results.filter((r) => r.rule === "stableid-format");
      expect(formatErrors).toHaveLength(0);
    });

    it("rejects stableId that is too short", () => {
      const g = new Graph();
      g.addSchema({ type: "org", name: "Org", required: [], recommended: [] });
      g.addEntity({ id: "short", stableId: "abc12", type: "org", name: "Short" });

      const results = validateEntity(g, "short");
      const formatErrors = results.filter((r) => r.rule === "stableid-format");
      expect(formatErrors).toHaveLength(1);
      expect(formatErrors[0].severity).toBe("error");
    });

    it("rejects stableId with non-alphanumeric characters", () => {
      const g = new Graph();
      g.addSchema({ type: "org", name: "Org", required: [], recommended: [] });
      g.addEntity({ id: "bad", stableId: "abc-123_fg", type: "org", name: "Bad" });

      const results = validateEntity(g, "bad");
      const formatErrors = results.filter((r) => r.rule === "stableid-format");
      expect(formatErrors).toHaveLength(1);
      expect(formatErrors[0].severity).toBe("error");
    });
  });

  describe("duplicate-stableid check", () => {
    it("catches two entities sharing a stableId", () => {
      const g = new Graph();
      g.addSchema({ type: "org", name: "Org", required: [], recommended: [] });
      g.addEntity({ id: "ent-a", stableId: "aB3cD4eF5g", type: "org", name: "A" });
      g.addEntity({ id: "ent-b", stableId: "aB3cD4eF5g", type: "org", name: "B" });

      const results = validate(g);
      const dupErrors = results.filter((r) => r.rule === "duplicate-stableid");
      expect(dupErrors).toHaveLength(1);
      expect(dupErrors[0].severity).toBe("error");
    });

    it("does not flag unique stableIds", () => {
      const g = new Graph();
      g.addSchema({ type: "org", name: "Org", required: [], recommended: [] });
      g.addEntity({ id: "ent-a", stableId: "aB3cD4eF5g", type: "org", name: "A" });
      g.addEntity({ id: "ent-b", stableId: "xY7zW8vU9t", type: "org", name: "B" });

      const results = validate(g);
      const dupErrors = results.filter((r) => r.rule === "duplicate-stableid");
      expect(dupErrors).toHaveLength(0);
    });
  });

  describe("factid-format check", () => {
    it("accepts fact IDs starting with f_", () => {
      const g = new Graph();
      g.addSchema({ type: "org", name: "Org", required: [], recommended: [] });
      g.addProperty({ id: "name", name: "Name", dataType: "text" });
      g.addEntity({ id: "ent", stableId: "aB3cD4eF5g", type: "org", name: "E" });
      g.addFact({ id: "f_abc123def0", subjectId: "ent", propertyId: "name", value: { type: "text", value: "v" } });

      const results = validateEntity(g, "ent");
      const formatErrors = results.filter((r) => r.rule === "factid-format");
      expect(formatErrors).toHaveLength(0);
    });

    it("accepts fact IDs starting with inv_", () => {
      const g = new Graph();
      g.addSchema({ type: "org", name: "Org", required: [], recommended: [] });
      g.addProperty({ id: "name", name: "Name", dataType: "text" });
      g.addEntity({ id: "ent", stableId: "aB3cD4eF5g", type: "org", name: "E" });
      g.addFact({ id: "inv_abc123def0", subjectId: "ent", propertyId: "name", value: { type: "text", value: "v" } });

      const results = validateEntity(g, "ent");
      const formatErrors = results.filter((r) => r.rule === "factid-format");
      expect(formatErrors).toHaveLength(0);
    });

    it("rejects fact IDs without correct prefix", () => {
      const g = new Graph();
      g.addSchema({ type: "org", name: "Org", required: [], recommended: [] });
      g.addProperty({ id: "name", name: "Name", dataType: "text" });
      g.addEntity({ id: "ent", stableId: "aB3cD4eF5g", type: "org", name: "E" });
      g.addFact({ id: "bad_id", subjectId: "ent", propertyId: "name", value: { type: "text", value: "v" } });

      const results = validateEntity(g, "ent");
      const formatErrors = results.filter((r) => r.rule === "factid-format");
      expect(formatErrors).toHaveLength(1);
      expect(formatErrors[0].severity).toBe("error");
    });
  });

  describe("empty-name check", () => {
    it("catches entity with empty name", () => {
      const g = new Graph();
      g.addSchema({ type: "org", name: "Org", required: [], recommended: [] });
      g.addEntity({ id: "no-name", stableId: "aB3cD4eF5g", type: "org", name: "" });

      const results = validateEntity(g, "no-name");
      const nameErrors = results.filter((r) => r.rule === "empty-name");
      expect(nameErrors).toHaveLength(1);
      expect(nameErrors[0].severity).toBe("error");
    });

    it("catches entity with whitespace-only name", () => {
      const g = new Graph();
      g.addSchema({ type: "org", name: "Org", required: [], recommended: [] });
      g.addEntity({ id: "space-name", stableId: "aB3cD4eF5g", type: "org", name: "   " });

      const results = validateEntity(g, "space-name");
      const nameErrors = results.filter((r) => r.rule === "empty-name");
      expect(nameErrors).toHaveLength(1);
    });

    it("does not flag entity with valid name", () => {
      const g = new Graph();
      g.addSchema({ type: "org", name: "Org", required: [], recommended: [] });
      g.addEntity({ id: "good", stableId: "aB3cD4eF5g", type: "org", name: "Good Name" });

      const results = validateEntity(g, "good");
      const nameErrors = results.filter((r) => r.rule === "empty-name");
      expect(nameErrors).toHaveLength(0);
    });
  });

  describe("valid-end-before-as-of check", () => {
    it("catches validEnd before asOf", () => {
      const g = new Graph();
      g.addSchema({ type: "org", name: "Org", required: [], recommended: [] });
      g.addProperty({ id: "status", name: "Status", dataType: "text" });
      g.addEntity({ id: "ent", stableId: "aB3cD4eF5g", type: "org", name: "E" });
      g.addFact({
        id: "f_bad_dates",
        subjectId: "ent",
        propertyId: "status",
        value: { type: "text", value: "active" },
        asOf: "2024-06",
        validEnd: "2024-01",
      });

      const results = validateEntity(g, "ent");
      const orderErrors = results.filter((r) => r.rule === "valid-end-before-as-of");
      expect(orderErrors).toHaveLength(1);
      expect(orderErrors[0].severity).toBe("error");
    });

    it("does not flag valid temporal ordering", () => {
      const g = new Graph();
      g.addSchema({ type: "org", name: "Org", required: [], recommended: [] });
      g.addProperty({ id: "status", name: "Status", dataType: "text" });
      g.addEntity({ id: "ent", stableId: "aB3cD4eF5g", type: "org", name: "E" });
      g.addFact({
        id: "f_good_dates",
        subjectId: "ent",
        propertyId: "status",
        value: { type: "text", value: "active" },
        asOf: "2024-01",
        validEnd: "2024-06",
      });

      const results = validateEntity(g, "ent");
      const orderErrors = results.filter((r) => r.rule === "valid-end-before-as-of");
      expect(orderErrors).toHaveLength(0);
    });
  });

  describe("temporal-missing-date check", () => {
    it("warns when temporal property fact has no asOf", () => {
      const g = new Graph();
      g.addSchema({ type: "org", name: "Org", required: [], recommended: [] });
      g.addProperty({ id: "revenue", name: "Revenue", dataType: "number", temporal: true });
      g.addEntity({ id: "ent", stableId: "aB3cD4eF5g", type: "org", name: "E" });
      g.addFact({
        id: "f_no_date",
        subjectId: "ent",
        propertyId: "revenue",
        value: { type: "number", value: 1000 },
        // no asOf
      });

      const results = validateEntity(g, "ent");
      const dateWarnings = results.filter((r) => r.rule === "temporal-missing-date");
      expect(dateWarnings).toHaveLength(1);
      expect(dateWarnings[0].severity).toBe("warning");
    });

    it("does not warn when temporal fact has asOf", () => {
      const g = new Graph();
      g.addSchema({ type: "org", name: "Org", required: [], recommended: [] });
      g.addProperty({ id: "revenue", name: "Revenue", dataType: "number", temporal: true });
      g.addEntity({ id: "ent", stableId: "aB3cD4eF5g", type: "org", name: "E" });
      g.addFact({
        id: "f_with_date",
        subjectId: "ent",
        propertyId: "revenue",
        value: { type: "number", value: 1000 },
        asOf: "2024-01",
      });

      const results = validateEntity(g, "ent");
      const dateWarnings = results.filter((r) => r.rule === "temporal-missing-date");
      expect(dateWarnings).toHaveLength(0);
    });

    it("skips derived (inverse) facts", () => {
      const g = new Graph();
      g.addSchema({ type: "org", name: "Org", required: [], recommended: [] });
      g.addProperty({ id: "revenue", name: "Revenue", dataType: "number", temporal: true });
      g.addEntity({ id: "ent", stableId: "aB3cD4eF5g", type: "org", name: "E" });
      g.addFact({
        id: "inv_derived",
        subjectId: "ent",
        propertyId: "revenue",
        value: { type: "number", value: 1000 },
        derivedFrom: "f_original",
      });

      const results = validateEntity(g, "ent");
      const dateWarnings = results.filter((r) => r.rule === "temporal-missing-date");
      expect(dateWarnings).toHaveLength(0);
    });
  });

  describe("non-temporal-multiple check", () => {
    it("warns when non-temporal property has multiple facts", () => {
      const g = new Graph();
      g.addSchema({ type: "org", name: "Org", required: [], recommended: [] });
      g.addProperty({ id: "headquarters", name: "HQ", dataType: "text", temporal: false });
      g.addEntity({ id: "ent", stableId: "aB3cD4eF5g", type: "org", name: "E" });
      g.addFact({ id: "f_hq1", subjectId: "ent", propertyId: "headquarters", value: { type: "text", value: "SF" } });
      g.addFact({ id: "f_hq2", subjectId: "ent", propertyId: "headquarters", value: { type: "text", value: "NYC" } });

      const results = validateEntity(g, "ent");
      const multiWarnings = results.filter((r) => r.rule === "non-temporal-multiple");
      expect(multiWarnings).toHaveLength(1);
      expect(multiWarnings[0].severity).toBe("warning");
    });

    it("does not warn for temporal properties with multiple facts", () => {
      const g = new Graph();
      g.addSchema({ type: "org", name: "Org", required: [], recommended: [] });
      g.addProperty({ id: "revenue", name: "Revenue", dataType: "number", temporal: true });
      g.addEntity({ id: "ent", stableId: "aB3cD4eF5g", type: "org", name: "E" });
      g.addFact({ id: "f_r1", subjectId: "ent", propertyId: "revenue", value: { type: "number", value: 100 }, asOf: "2024-01" });
      g.addFact({ id: "f_r2", subjectId: "ent", propertyId: "revenue", value: { type: "number", value: 200 }, asOf: "2024-06" });

      const results = validateEntity(g, "ent");
      const multiWarnings = results.filter((r) => r.rule === "non-temporal-multiple");
      expect(multiWarnings).toHaveLength(0);
    });
  });

  describe("stale-temporal check", () => {
    it("warns when most recent temporal fact is >2 years old", () => {
      const g = new Graph();
      g.addSchema({ type: "org", name: "Org", required: [], recommended: [] });
      g.addProperty({ id: "revenue", name: "Revenue", dataType: "number", temporal: true });
      g.addEntity({ id: "ent", stableId: "aB3cD4eF5g", type: "org", name: "E" });
      g.addFact({ id: "f_old", subjectId: "ent", propertyId: "revenue", value: { type: "number", value: 100 }, asOf: "2020-01" });

      const results = validateEntity(g, "ent");
      const staleWarnings = results.filter((r) => r.rule === "stale-temporal");
      expect(staleWarnings).toHaveLength(1);
      expect(staleWarnings[0].severity).toBe("warning");
    });

    it("does not warn when recent temporal data exists", () => {
      const g = new Graph();
      g.addSchema({ type: "org", name: "Org", required: [], recommended: [] });
      g.addProperty({ id: "revenue", name: "Revenue", dataType: "number", temporal: true });
      g.addEntity({ id: "ent", stableId: "aB3cD4eF5g", type: "org", name: "E" });
      g.addFact({ id: "f_new", subjectId: "ent", propertyId: "revenue", value: { type: "number", value: 100 }, asOf: "2025-06" });

      const results = validateEntity(g, "ent");
      const staleWarnings = results.filter((r) => r.rule === "stale-temporal");
      expect(staleWarnings).toHaveLength(0);
    });
  });

  describe("duplicate-facts check", () => {
    it("warns on duplicate (entity, property, asOf) tuple", () => {
      const g = new Graph();
      g.addSchema({ type: "org", name: "Org", required: [], recommended: [] });
      g.addProperty({ id: "revenue", name: "Revenue", dataType: "number" });
      g.addEntity({ id: "ent", stableId: "aB3cD4eF5g", type: "org", name: "E" });
      g.addFact({ id: "f_dup1", subjectId: "ent", propertyId: "revenue", value: { type: "number", value: 100 }, asOf: "2024-01" });
      g.addFact({ id: "f_dup2", subjectId: "ent", propertyId: "revenue", value: { type: "number", value: 200 }, asOf: "2024-01" });

      const results = validateEntity(g, "ent");
      const dupWarnings = results.filter((r) => r.rule === "duplicate-facts");
      expect(dupWarnings).toHaveLength(1);
      expect(dupWarnings[0].severity).toBe("warning");
    });

    it("does not flag facts with different asOf dates", () => {
      const g = new Graph();
      g.addSchema({ type: "org", name: "Org", required: [], recommended: [] });
      g.addProperty({ id: "revenue", name: "Revenue", dataType: "number" });
      g.addEntity({ id: "ent", stableId: "aB3cD4eF5g", type: "org", name: "E" });
      g.addFact({ id: "f_ts1", subjectId: "ent", propertyId: "revenue", value: { type: "number", value: 100 }, asOf: "2024-01" });
      g.addFact({ id: "f_ts2", subjectId: "ent", propertyId: "revenue", value: { type: "number", value: 200 }, asOf: "2024-06" });

      const results = validateEntity(g, "ent");
      const dupWarnings = results.filter((r) => r.rule === "duplicate-facts");
      expect(dupWarnings).toHaveLength(0);
    });
  });

  describe("missing-source check", () => {
    it("warns when fact has no source URL", () => {
      const g = new Graph();
      g.addSchema({ type: "org", name: "Org", required: [], recommended: [] });
      g.addProperty({ id: "name", name: "Name", dataType: "text" });
      g.addEntity({ id: "ent", stableId: "aB3cD4eF5g", type: "org", name: "E" });
      g.addFact({ id: "f_nosrc", subjectId: "ent", propertyId: "name", value: { type: "text", value: "v" } });

      const results = validateEntity(g, "ent");
      const srcWarnings = results.filter((r) => r.rule === "missing-source");
      expect(srcWarnings).toHaveLength(1);
      expect(srcWarnings[0].severity).toBe("warning");
    });

    it("does not warn when fact has a source", () => {
      const g = new Graph();
      g.addSchema({ type: "org", name: "Org", required: [], recommended: [] });
      g.addProperty({ id: "name", name: "Name", dataType: "text" });
      g.addEntity({ id: "ent", stableId: "aB3cD4eF5g", type: "org", name: "E" });
      g.addFact({ id: "f_withsrc", subjectId: "ent", propertyId: "name", value: { type: "text", value: "v" }, source: "https://example.com" });

      const results = validateEntity(g, "ent");
      const srcWarnings = results.filter((r) => r.rule === "missing-source");
      expect(srcWarnings).toHaveLength(0);
    });
  });

  describe("unknown-property check", () => {
    it("warns when fact uses a property not in the registry", () => {
      const g = new Graph();
      g.addSchema({ type: "org", name: "Org", required: [], recommended: [] });
      // Do NOT add property "mystery" to the graph
      g.addEntity({ id: "ent", stableId: "aB3cD4eF5g", type: "org", name: "E" });
      g.addFact({ id: "f_unk", subjectId: "ent", propertyId: "mystery", value: { type: "text", value: "v" } });

      const results = validateEntity(g, "ent");
      const unkWarnings = results.filter((r) => r.rule === "unknown-property");
      expect(unkWarnings).toHaveLength(1);
      expect(unkWarnings[0].severity).toBe("warning");
      expect(unkWarnings[0].message).toContain("mystery");
    });

    it("does not warn for known properties", () => {
      const g = new Graph();
      g.addSchema({ type: "org", name: "Org", required: [], recommended: [] });
      g.addProperty({ id: "name", name: "Name", dataType: "text" });
      g.addEntity({ id: "ent", stableId: "aB3cD4eF5g", type: "org", name: "E" });
      g.addFact({ id: "f_known", subjectId: "ent", propertyId: "name", value: { type: "text", value: "v" } });

      const results = validateEntity(g, "ent");
      const unkWarnings = results.filter((r) => r.rule === "unknown-property");
      expect(unkWarnings).toHaveLength(0);
    });
  });

  describe("date-format check", () => {
    it("warns on invalid asOf format", () => {
      const g = new Graph();
      g.addSchema({ type: "org", name: "Org", required: [], recommended: [] });
      g.addProperty({ id: "name", name: "Name", dataType: "text" });
      g.addEntity({ id: "ent", stableId: "aB3cD4eF5g", type: "org", name: "E" });
      g.addFact({ id: "f_baddate", subjectId: "ent", propertyId: "name", value: { type: "text", value: "v" }, asOf: "Jan 2024" });

      const results = validateEntity(g, "ent");
      const dateWarnings = results.filter((r) => r.rule === "date-format");
      expect(dateWarnings).toHaveLength(1);
      expect(dateWarnings[0].severity).toBe("warning");
    });

    it("warns on invalid validEnd format", () => {
      const g = new Graph();
      g.addSchema({ type: "org", name: "Org", required: [], recommended: [] });
      g.addProperty({ id: "name", name: "Name", dataType: "text" });
      g.addEntity({ id: "ent", stableId: "aB3cD4eF5g", type: "org", name: "E" });
      g.addFact({ id: "f_badend", subjectId: "ent", propertyId: "name", value: { type: "text", value: "v" }, asOf: "2024", validEnd: "2024/06/01" });

      const results = validateEntity(g, "ent");
      const dateWarnings = results.filter((r) => r.rule === "date-format");
      expect(dateWarnings).toHaveLength(1);
      expect(dateWarnings[0].message).toContain("validEnd");
    });

    it("accepts valid date formats (YYYY, YYYY-MM, YYYY-MM-DD)", () => {
      const g = new Graph();
      g.addSchema({ type: "org", name: "Org", required: [], recommended: [] });
      g.addProperty({ id: "name", name: "Name", dataType: "text" });
      g.addEntity({ id: "ent", stableId: "aB3cD4eF5g", type: "org", name: "E" });
      g.addFact({ id: "f_y", subjectId: "ent", propertyId: "name", value: { type: "text", value: "v" }, asOf: "2024" });
      g.addFact({ id: "f_ym", subjectId: "ent", propertyId: "name", value: { type: "text", value: "v" }, asOf: "2024-06" });
      g.addFact({ id: "f_ymd", subjectId: "ent", propertyId: "name", value: { type: "text", value: "v" }, asOf: "2024-06-15" });

      const results = validateEntity(g, "ent");
      const dateWarnings = results.filter((r) => r.rule === "date-format");
      expect(dateWarnings).toHaveLength(0);
    });
  });

  describe("future-date check", () => {
    it("warns when asOf is in the future", () => {
      const g = new Graph();
      g.addSchema({ type: "org", name: "Org", required: [], recommended: [] });
      g.addProperty({ id: "name", name: "Name", dataType: "text" });
      g.addEntity({ id: "ent", stableId: "aB3cD4eF5g", type: "org", name: "E" });
      g.addFact({ id: "f_future", subjectId: "ent", propertyId: "name", value: { type: "text", value: "v" }, asOf: "2099-01-01" });

      const results = validateEntity(g, "ent");
      const futureWarnings = results.filter((r) => r.rule === "future-date");
      expect(futureWarnings).toHaveLength(1);
      expect(futureWarnings[0].severity).toBe("warning");
    });

    it("does not flag past dates", () => {
      const g = new Graph();
      g.addSchema({ type: "org", name: "Org", required: [], recommended: [] });
      g.addProperty({ id: "name", name: "Name", dataType: "text" });
      g.addEntity({ id: "ent", stableId: "aB3cD4eF5g", type: "org", name: "E" });
      g.addFact({ id: "f_past", subjectId: "ent", propertyId: "name", value: { type: "text", value: "v" }, asOf: "2020-01-01" });

      const results = validateEntity(g, "ent");
      const futureWarnings = results.filter((r) => r.rule === "future-date");
      expect(futureWarnings).toHaveLength(0);
    });
  });

  describe("orphan-entity check", () => {
    it("reports orphan entity with no facts and no items", () => {
      const g = new Graph();
      g.addSchema({ type: "org", name: "Org", required: [], recommended: [] });
      g.addEntity({ id: "orphan", stableId: "aB3cD4eF5g", type: "org", name: "Orphan" });

      const results = validateEntity(g, "orphan");
      const orphanInfos = results.filter((r) => r.rule === "orphan-entity");
      expect(orphanInfos).toHaveLength(1);
      expect(orphanInfos[0].severity).toBe("info");
    });

    it("does not flag entity with facts", () => {
      const g = new Graph();
      g.addSchema({ type: "org", name: "Org", required: [], recommended: [] });
      g.addProperty({ id: "name", name: "Name", dataType: "text" });
      g.addEntity({ id: "active", stableId: "aB3cD4eF5g", type: "org", name: "Active" });
      g.addFact({ id: "f_a1", subjectId: "active", propertyId: "name", value: { type: "text", value: "v" } });

      const results = validateEntity(g, "active");
      const orphanInfos = results.filter((r) => r.rule === "orphan-entity");
      expect(orphanInfos).toHaveLength(0);
    });
  });

  describe("bidirectional-redundancy check", () => {
    it("warns when both sides of inverse relationship are stored", () => {
      const g = new Graph();
      g.addSchema({ type: "person", name: "Person", required: [], recommended: [] });
      g.addSchema({ type: "org", name: "Org", required: [], recommended: [] });
      g.addProperty({ id: "employed-by", name: "Employed By", dataType: "ref", inverseId: "employer-of" });
      g.addProperty({ id: "employer-of", name: "Employs", dataType: "ref", computed: true });

      g.addEntity({ id: "alice", stableId: "aB3cD4eF5g", type: "person", name: "Alice" });
      g.addEntity({ id: "acme", stableId: "xY7zW8vU9t", type: "org", name: "ACME" });

      // Both sides stored explicitly (the inverse should be computed, not stored)
      g.addFact({ id: "f_alice_emp", subjectId: "alice", propertyId: "employed-by", value: { type: "ref", value: "acme" } });
      g.addFact({ id: "f_acme_emp", subjectId: "acme", propertyId: "employer-of", value: { type: "ref", value: "alice" } });

      const results = validate(g);
      const biWarnings = results.filter((r) => r.rule === "bidirectional-redundancy");
      expect(biWarnings).toHaveLength(1);
      expect(biWarnings[0].severity).toBe("warning");
    });

    it("does not flag when only one side is stored", () => {
      const g = new Graph();
      g.addSchema({ type: "person", name: "Person", required: [], recommended: [] });
      g.addSchema({ type: "org", name: "Org", required: [], recommended: [] });
      g.addProperty({ id: "employed-by", name: "Employed By", dataType: "ref", inverseId: "employer-of" });
      g.addProperty({ id: "employer-of", name: "Employs", dataType: "ref", computed: true });

      g.addEntity({ id: "alice", stableId: "aB3cD4eF5g", type: "person", name: "Alice" });
      g.addEntity({ id: "acme", stableId: "xY7zW8vU9t", type: "org", name: "ACME" });

      g.addFact({ id: "f_alice_emp", subjectId: "alice", propertyId: "employed-by", value: { type: "ref", value: "acme" } });
      // employer-of NOT explicitly stored — will be computed

      const results = validate(g);
      const biWarnings = results.filter((r) => r.rule === "bidirectional-redundancy");
      expect(biWarnings).toHaveLength(0);
    });
  });

  describe("new checks on real data", () => {
    it("produces no stableid-format errors on real entities", () => {
      const results = validate(graph);
      const stableIdErrors = results.filter((r) => r.rule === "stableid-format");
      expect(stableIdErrors).toHaveLength(0);
    });

    it("produces no duplicate-stableid errors on real entities", () => {
      const results = validate(graph);
      const dupErrors = results.filter((r) => r.rule === "duplicate-stableid");
      expect(dupErrors).toHaveLength(0);
    });

    it("produces no factid-format errors on real entities", () => {
      const results = validate(graph);
      const formatErrors = results.filter((r) => r.rule === "factid-format");
      expect(formatErrors).toHaveLength(0);
    });

    it("produces no empty-name errors on real entities", () => {
      const results = validate(graph);
      const nameErrors = results.filter((r) => r.rule === "empty-name");
      expect(nameErrors).toHaveLength(0);
    });

    it("produces no valid-end-before-as-of errors on real entities", () => {
      const results = validate(graph);
      const orderErrors = results.filter((r) => r.rule === "valid-end-before-as-of");
      expect(orderErrors).toHaveLength(0);
    });

    it("produces no date-format warnings on real entities", () => {
      const results = validate(graph);
      const dateWarnings = results.filter((r) => r.rule === "date-format");
      expect(dateWarnings).toHaveLength(0);
    });
  });
});
