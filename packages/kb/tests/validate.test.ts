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
      expect(completeness).toHaveLength(16); // one per entity
    });

    it("properly categorizes severity levels", () => {
      const results = validate(graph);

      const warnings = results.filter((r) => r.severity === "warning");
      const infos = results.filter((r) => r.severity === "info");

      // There should be at least some warnings (recommended properties, item ref warnings, missing-source, etc.)
      expect(warnings.length).toBeGreaterThan(0);
      // There should be info messages (completeness for all 16 entities + orphan-entity + stale-temporal)
      expect(infos.length).toBeGreaterThanOrEqual(16);
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
      // Gets orphan-entity (info) + schema-exists (warning)
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

  // ── New check tests (checks 7–21) ──────────────────────────────────────

  /** Helper to create a minimal test graph with optional schema. */
  function makeTestGraph(opts?: { withSchema?: boolean }) {
    const g = new Graph();
    if (opts?.withSchema) {
      g.addSchema({
        type: "organization",
        name: "Organization",
        required: [],
        recommended: [],
      });
    }
    return g;
  }

  describe("stableid-format (check 7)", () => {
    it("errors on invalid stableId (too short)", () => {
      const g = makeTestGraph({ withSchema: true });
      g.addEntity({ id: "bad", stableId: "abc", type: "organization", name: "Bad" });
      const results = validateEntity(g, "bad");
      const errs = results.filter((r) => r.rule === "stableid-format");
      expect(errs).toHaveLength(1);
      expect(errs[0].severity).toBe("error");
    });

    it("errors on stableId with special chars", () => {
      const g = makeTestGraph({ withSchema: true });
      g.addEntity({ id: "bad2", stableId: "ab_cd!fg12", type: "organization", name: "Bad2" });
      const results = validateEntity(g, "bad2");
      const errs = results.filter((r) => r.rule === "stableid-format");
      expect(errs).toHaveLength(1);
    });

    it("passes for valid 10-char alphanumeric stableId", () => {
      const g = makeTestGraph({ withSchema: true });
      g.addEntity({ id: "good", stableId: "aBcDeFgH12", type: "organization", name: "Good" });
      const results = validateEntity(g, "good");
      const errs = results.filter((r) => r.rule === "stableid-format");
      expect(errs).toHaveLength(0);
    });
  });

  describe("duplicate-stableid (check 8)", () => {
    it("errors when two entities share the same stableId", () => {
      const g = makeTestGraph({ withSchema: true });
      g.addEntity({ id: "a", stableId: "AAAAAAAAAA", type: "organization", name: "A" });
      g.addEntity({ id: "b", stableId: "AAAAAAAAAA", type: "organization", name: "B" });
      const results = validate(g);
      const dupeErrors = results.filter((r) => r.rule === "duplicate-stableid");
      expect(dupeErrors).toHaveLength(1);
      expect(dupeErrors[0].severity).toBe("error");
      expect(dupeErrors[0].message).toContain("a");
      expect(dupeErrors[0].message).toContain("b");
    });

    it("passes when stableIds are unique", () => {
      const g = makeTestGraph({ withSchema: true });
      g.addEntity({ id: "a", stableId: "AAAAAAAAAA", type: "organization", name: "A" });
      g.addEntity({ id: "b", stableId: "BBBBBBBBBB", type: "organization", name: "B" });
      const results = validate(g);
      const dupeErrors = results.filter((r) => r.rule === "duplicate-stableid");
      expect(dupeErrors).toHaveLength(0);
    });
  });

  describe("factid-format (check 9)", () => {
    it("errors on fact ID without f_ prefix", () => {
      const g = makeTestGraph({ withSchema: true });
      g.addEntity({ id: "e1", stableId: "E1abcdefgh", type: "organization", name: "E1" });
      g.addFact({
        id: "badid",
        subjectId: "e1",
        propertyId: "revenue",
        value: { type: "number", value: 100 },
      });
      const results = validateEntity(g, "e1");
      const errs = results.filter((r) => r.rule === "factid-format");
      expect(errs).toHaveLength(1);
      expect(errs[0].severity).toBe("error");
    });

    it("passes for valid f_ prefixed ID", () => {
      const g = makeTestGraph({ withSchema: true });
      g.addEntity({ id: "e2", stableId: "E2abcdefgh", type: "organization", name: "E2" });
      g.addFact({
        id: "f_abc12345",
        subjectId: "e2",
        propertyId: "revenue",
        value: { type: "number", value: 100 },
      });
      const results = validateEntity(g, "e2");
      const errs = results.filter((r) => r.rule === "factid-format");
      expect(errs).toHaveLength(0);
    });
  });

  describe("empty-name (check 10)", () => {
    it("errors on empty name", () => {
      const g = makeTestGraph({ withSchema: true });
      g.addEntity({ id: "noname", stableId: "Nnoname1234", type: "organization", name: "" });
      const results = validateEntity(g, "noname");
      const errs = results.filter((r) => r.rule === "empty-name");
      expect(errs).toHaveLength(1);
      expect(errs[0].severity).toBe("error");
    });

    it("errors on whitespace-only name", () => {
      const g = makeTestGraph({ withSchema: true });
      g.addEntity({ id: "spacename", stableId: "Sspacename", type: "organization", name: "   " });
      const results = validateEntity(g, "spacename");
      const errs = results.filter((r) => r.rule === "empty-name");
      expect(errs).toHaveLength(1);
    });

    it("passes for non-empty name", () => {
      const g = makeTestGraph({ withSchema: true });
      g.addEntity({ id: "ok", stableId: "Ok12345678", type: "organization", name: "OK Corp" });
      const results = validateEntity(g, "ok");
      const errs = results.filter((r) => r.rule === "empty-name");
      expect(errs).toHaveLength(0);
    });
  });

  describe("valid-end-before-as-of (check 11)", () => {
    it("errors when validEnd is before asOf", () => {
      const g = makeTestGraph({ withSchema: true });
      g.addEntity({ id: "e", stableId: "Etest12345", type: "organization", name: "E" });
      g.addFact({
        id: "f_bad_dates",
        subjectId: "e",
        propertyId: "revenue",
        value: { type: "number", value: 100 },
        asOf: "2025-06",
        validEnd: "2024-01",
      });
      const results = validateEntity(g, "e");
      const errs = results.filter((r) => r.rule === "valid-end-before-as-of");
      expect(errs).toHaveLength(1);
      expect(errs[0].severity).toBe("error");
    });

    it("passes when validEnd is after asOf", () => {
      const g = makeTestGraph({ withSchema: true });
      g.addEntity({ id: "e2", stableId: "E2test1234", type: "organization", name: "E2" });
      g.addFact({
        id: "f_ok_dates",
        subjectId: "e2",
        propertyId: "revenue",
        value: { type: "number", value: 100 },
        asOf: "2024-01",
        validEnd: "2025-06",
      });
      const results = validateEntity(g, "e2");
      const errs = results.filter((r) => r.rule === "valid-end-before-as-of");
      expect(errs).toHaveLength(0);
    });
  });

  describe("temporal-missing-date (check 12)", () => {
    it("warns when temporal property fact has no asOf", () => {
      const g = makeTestGraph({ withSchema: true });
      g.addProperty({ id: "revenue", name: "Revenue", dataType: "number", temporal: true });
      g.addEntity({ id: "e", stableId: "Etemporal12", type: "organization", name: "E" });
      g.addFact({
        id: "f_no_date",
        subjectId: "e",
        propertyId: "revenue",
        value: { type: "number", value: 1000 },
      });
      const results = validateEntity(g, "e");
      const warns = results.filter((r) => r.rule === "temporal-missing-date");
      expect(warns).toHaveLength(1);
      expect(warns[0].severity).toBe("warning");
    });

    it("passes when temporal property fact has asOf", () => {
      const g = makeTestGraph({ withSchema: true });
      g.addProperty({ id: "revenue", name: "Revenue", dataType: "number", temporal: true });
      g.addEntity({ id: "e", stableId: "Etemporal12", type: "organization", name: "E" });
      g.addFact({
        id: "f_with_date",
        subjectId: "e",
        propertyId: "revenue",
        value: { type: "number", value: 1000 },
        asOf: "2025-01",
      });
      const results = validateEntity(g, "e");
      const warns = results.filter((r) => r.rule === "temporal-missing-date");
      expect(warns).toHaveLength(0);
    });

    it("does not warn for non-temporal property without asOf", () => {
      const g = makeTestGraph({ withSchema: true });
      g.addProperty({ id: "headquarters", name: "HQ", dataType: "text" });
      g.addEntity({ id: "e", stableId: "Enontempo12", type: "organization", name: "E" });
      g.addFact({
        id: "f_static",
        subjectId: "e",
        propertyId: "headquarters",
        value: { type: "text", value: "NYC" },
      });
      const results = validateEntity(g, "e");
      const warns = results.filter((r) => r.rule === "temporal-missing-date");
      expect(warns).toHaveLength(0);
    });
  });

  describe("non-temporal-multiple (check 13)", () => {
    it("warns when non-temporal property has multiple facts", () => {
      const g = makeTestGraph({ withSchema: true });
      g.addProperty({ id: "headquarters", name: "HQ", dataType: "text" });
      g.addEntity({ id: "e", stableId: "Emulti12345", type: "organization", name: "E" });
      g.addFact({ id: "f_hq1", subjectId: "e", propertyId: "headquarters", value: { type: "text", value: "NYC" } });
      g.addFact({ id: "f_hq2", subjectId: "e", propertyId: "headquarters", value: { type: "text", value: "SF" } });
      const results = validateEntity(g, "e");
      const warns = results.filter((r) => r.rule === "non-temporal-multiple");
      expect(warns).toHaveLength(1);
      expect(warns[0].severity).toBe("warning");
    });

    it("does not warn for temporal property with multiple facts", () => {
      const g = makeTestGraph({ withSchema: true });
      g.addProperty({ id: "revenue", name: "Revenue", dataType: "number", temporal: true });
      g.addEntity({ id: "e", stableId: "Etmulti1234", type: "organization", name: "E" });
      g.addFact({ id: "f_r1", subjectId: "e", propertyId: "revenue", value: { type: "number", value: 100 }, asOf: "2024" });
      g.addFact({ id: "f_r2", subjectId: "e", propertyId: "revenue", value: { type: "number", value: 200 }, asOf: "2025" });
      const results = validateEntity(g, "e");
      const warns = results.filter((r) => r.rule === "non-temporal-multiple");
      expect(warns).toHaveLength(0);
    });
  });

  describe("stale-temporal (check 14)", () => {
    it("reports info when most recent temporal fact is >2 years old", () => {
      const g = makeTestGraph({ withSchema: true });
      g.addProperty({ id: "revenue", name: "Revenue", dataType: "number", temporal: true });
      g.addEntity({ id: "e", stableId: "Estale12345", type: "organization", name: "E" });
      g.addFact({ id: "f_old", subjectId: "e", propertyId: "revenue", value: { type: "number", value: 100 }, asOf: "2020-01" });
      const results = validateEntity(g, "e");
      const infos = results.filter((r) => r.rule === "stale-temporal");
      expect(infos).toHaveLength(1);
      expect(infos[0].severity).toBe("info");
    });

    it("does not report stale for recent temporal data", () => {
      const g = makeTestGraph({ withSchema: true });
      g.addProperty({ id: "revenue", name: "Revenue", dataType: "number", temporal: true });
      g.addEntity({ id: "e", stableId: "Efresh12345", type: "organization", name: "E" });
      g.addFact({ id: "f_new", subjectId: "e", propertyId: "revenue", value: { type: "number", value: 100 }, asOf: "2025-06" });
      const results = validateEntity(g, "e");
      const infos = results.filter((r) => r.rule === "stale-temporal");
      expect(infos).toHaveLength(0);
    });
  });

  describe("duplicate-facts (check 15)", () => {
    it("warns on duplicate (property, asOf) tuple", () => {
      const g = makeTestGraph({ withSchema: true });
      g.addEntity({ id: "e", stableId: "Edupe123456", type: "organization", name: "E" });
      g.addFact({ id: "f_d1", subjectId: "e", propertyId: "revenue", value: { type: "number", value: 100 }, asOf: "2025" });
      g.addFact({ id: "f_d2", subjectId: "e", propertyId: "revenue", value: { type: "number", value: 200 }, asOf: "2025" });
      const results = validateEntity(g, "e");
      const warns = results.filter((r) => r.rule === "duplicate-facts");
      expect(warns).toHaveLength(1);
      expect(warns[0].severity).toBe("warning");
    });

    it("does not warn for same property with different asOf", () => {
      const g = makeTestGraph({ withSchema: true });
      g.addEntity({ id: "e", stableId: "Enodupe1234", type: "organization", name: "E" });
      g.addFact({ id: "f_n1", subjectId: "e", propertyId: "revenue", value: { type: "number", value: 100 }, asOf: "2024" });
      g.addFact({ id: "f_n2", subjectId: "e", propertyId: "revenue", value: { type: "number", value: 200 }, asOf: "2025" });
      const results = validateEntity(g, "e");
      const warns = results.filter((r) => r.rule === "duplicate-facts");
      expect(warns).toHaveLength(0);
    });
  });

  describe("missing-source (check 16)", () => {
    it("warns when fact has no source URL", () => {
      const g = makeTestGraph({ withSchema: true });
      g.addEntity({ id: "e", stableId: "Enosource12", type: "organization", name: "E" });
      g.addFact({ id: "f_nosrc", subjectId: "e", propertyId: "revenue", value: { type: "number", value: 100 } });
      const results = validateEntity(g, "e");
      const warns = results.filter((r) => r.rule === "missing-source");
      expect(warns).toHaveLength(1);
      expect(warns[0].severity).toBe("warning");
    });

    it("passes when fact has source", () => {
      const g = makeTestGraph({ withSchema: true });
      g.addEntity({ id: "e", stableId: "Ewithsrc123", type: "organization", name: "E" });
      g.addFact({
        id: "f_withsrc",
        subjectId: "e",
        propertyId: "revenue",
        value: { type: "number", value: 100 },
        source: "https://example.com",
      });
      const results = validateEntity(g, "e");
      const warns = results.filter((r) => r.rule === "missing-source");
      expect(warns).toHaveLength(0);
    });
  });

  describe("unknown-property (check 17)", () => {
    it("warns when propertyId is not in registry", () => {
      const g = makeTestGraph({ withSchema: true });
      g.addEntity({ id: "e", stableId: "Eunkprop123", type: "organization", name: "E" });
      g.addFact({ id: "f_unk", subjectId: "e", propertyId: "made-up-prop", value: { type: "text", value: "x" } });
      const results = validateEntity(g, "e");
      const warns = results.filter((r) => r.rule === "unknown-property");
      expect(warns).toHaveLength(1);
      expect(warns[0].message).toContain("made-up-prop");
    });

    it("passes when propertyId is registered", () => {
      const g = makeTestGraph({ withSchema: true });
      g.addProperty({ id: "revenue", name: "Revenue", dataType: "number" });
      g.addEntity({ id: "e", stableId: "Eknownpr123", type: "organization", name: "E" });
      g.addFact({ id: "f_known", subjectId: "e", propertyId: "revenue", value: { type: "number", value: 100 } });
      const results = validateEntity(g, "e");
      const warns = results.filter((r) => r.rule === "unknown-property");
      expect(warns).toHaveLength(0);
    });
  });

  describe("date-format (check 18)", () => {
    it("warns on invalid asOf date format", () => {
      const g = makeTestGraph({ withSchema: true });
      g.addEntity({ id: "e", stableId: "Ebaddate123", type: "organization", name: "E" });
      g.addFact({ id: "f_bd", subjectId: "e", propertyId: "x", value: { type: "number", value: 1 }, asOf: "Jan 2025" });
      const results = validateEntity(g, "e");
      const warns = results.filter((r) => r.rule === "date-format");
      expect(warns).toHaveLength(1);
    });

    it("warns on invalid validEnd date format", () => {
      const g = makeTestGraph({ withSchema: true });
      g.addEntity({ id: "e", stableId: "Ebadend1234", type: "organization", name: "E" });
      g.addFact({ id: "f_be", subjectId: "e", propertyId: "x", value: { type: "number", value: 1 }, asOf: "2025", validEnd: "not-a-date" });
      const results = validateEntity(g, "e");
      const warns = results.filter((r) => r.rule === "date-format");
      expect(warns).toHaveLength(1);
      expect(warns[0].message).toContain("validEnd");
    });

    it("passes for valid date formats (YYYY, YYYY-MM, YYYY-MM-DD)", () => {
      const g = makeTestGraph({ withSchema: true });
      g.addEntity({ id: "e", stableId: "Egooddate12", type: "organization", name: "E" });
      g.addFact({ id: "f_y", subjectId: "e", propertyId: "a", value: { type: "number", value: 1 }, asOf: "2025" });
      g.addFact({ id: "f_ym", subjectId: "e", propertyId: "b", value: { type: "number", value: 1 }, asOf: "2025-06" });
      g.addFact({ id: "f_ymd", subjectId: "e", propertyId: "c", value: { type: "number", value: 1 }, asOf: "2025-06-15" });
      const results = validateEntity(g, "e");
      const warns = results.filter((r) => r.rule === "date-format");
      expect(warns).toHaveLength(0);
    });
  });

  describe("future-date (check 19)", () => {
    it("warns when asOf is in the future", () => {
      const g = makeTestGraph({ withSchema: true });
      g.addEntity({ id: "e", stableId: "Efuture12345", type: "organization", name: "E" });
      g.addFact({ id: "f_fut", subjectId: "e", propertyId: "x", value: { type: "number", value: 1 }, asOf: "2099-01-01" });
      const results = validateEntity(g, "e");
      const warns = results.filter((r) => r.rule === "future-date");
      expect(warns).toHaveLength(1);
      expect(warns[0].severity).toBe("warning");
    });

    it("passes for past dates", () => {
      const g = makeTestGraph({ withSchema: true });
      g.addEntity({ id: "e", stableId: "Epast1234567", type: "organization", name: "E" });
      g.addFact({ id: "f_past", subjectId: "e", propertyId: "x", value: { type: "number", value: 1 }, asOf: "2024-01-01" });
      const results = validateEntity(g, "e");
      const warns = results.filter((r) => r.rule === "future-date");
      expect(warns).toHaveLength(0);
    });
  });

  describe("bidirectional-redundancy (check 20)", () => {
    it("warns when both sides of inverse are manually stored", () => {
      const g = makeTestGraph({ withSchema: true });
      g.addProperty({ id: "employed-by", name: "Employed By", dataType: "ref", inverseId: "employer-of" });
      g.addProperty({ id: "employer-of", name: "Employs", dataType: "refs", inverseId: "employed-by" });
      g.addSchema({ type: "person", name: "Person", required: [], recommended: [] });
      g.addEntity({ id: "person1", stableId: "Pperson1234", type: "person", name: "Person1" });
      g.addEntity({ id: "org1", stableId: "Oorg1234567", type: "organization", name: "Org1" });
      // Person has employed-by -> org1
      g.addFact({ id: "f_eb", subjectId: "person1", propertyId: "employed-by", value: { type: "ref", value: "org1" } });
      // Org also manually stores employer-of -> person1 (redundant!)
      g.addFact({ id: "f_eo", subjectId: "org1", propertyId: "employer-of", value: { type: "refs", value: ["person1"] } });

      const results = validateEntity(g, "person1");
      const warns = results.filter((r) => r.rule === "bidirectional-redundancy");
      expect(warns).toHaveLength(1);
      expect(warns[0].severity).toBe("warning");
      expect(warns[0].message).toContain("Bidirectional");
    });

    it("does not warn when only one side is stored", () => {
      const g = makeTestGraph({ withSchema: true });
      g.addProperty({ id: "employed-by", name: "Employed By", dataType: "ref", inverseId: "employer-of" });
      g.addProperty({ id: "employer-of", name: "Employs", dataType: "refs", inverseId: "employed-by", computed: true });
      g.addSchema({ type: "person", name: "Person", required: [], recommended: [] });
      g.addEntity({ id: "person1", stableId: "Pperson1234", type: "person", name: "Person1" });
      g.addEntity({ id: "org1", stableId: "Oorg1234567", type: "organization", name: "Org1" });
      g.addFact({ id: "f_eb", subjectId: "person1", propertyId: "employed-by", value: { type: "ref", value: "org1" } });
      // No manual employer-of fact on org1

      const results = validateEntity(g, "person1");
      const warns = results.filter((r) => r.rule === "bidirectional-redundancy");
      expect(warns).toHaveLength(0);
    });
  });

  describe("orphan-entity (check 21)", () => {
    it("reports info for entity with no facts and no items", () => {
      const g = makeTestGraph({ withSchema: true });
      g.addEntity({ id: "lonely", stableId: "Llonely1234", type: "organization", name: "Lonely" });
      const results = validateEntity(g, "lonely");
      const infos = results.filter((r) => r.rule === "orphan-entity");
      expect(infos).toHaveLength(1);
      expect(infos[0].severity).toBe("info");
    });

    it("does not report orphan for entity with facts", () => {
      const g = makeTestGraph({ withSchema: true });
      g.addEntity({ id: "withfacts", stableId: "Wwithfact12", type: "organization", name: "WithFacts" });
      g.addFact({ id: "f_wf", subjectId: "withfacts", propertyId: "revenue", value: { type: "number", value: 100 } });
      const results = validateEntity(g, "withfacts");
      const infos = results.filter((r) => r.rule === "orphan-entity");
      expect(infos).toHaveLength(0);
    });
  });
});
