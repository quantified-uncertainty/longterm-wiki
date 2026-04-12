import { describe, it, expect } from "vitest";
import { isEntityRefColumn, isEntityRefKey } from "../entity-ref-columns";

describe("isEntityRefColumn (snake_case schema column names)", () => {
  // ── Columns that MUST be detected ───────────────────────────────────────
  const POSITIVE_CASES = [
    // Bare entity_id — the original bug: endsWith("_entity_id") fails here
    // because "_entity_id" (10 chars) > "entity_id" (9 chars)
    "entity_id",
    // Compound _entity_id suffixed columns (personnel, grants, etc.)
    "person_entity_id",
    "org_entity_id",
    "grantee_entity_id",
    "company_entity_id",
    "investor_entity_id",
    "holder_entity_id",
    "lead_investor_entity_id",
    "stakeholder_entity_id",
    "policy_entity_id",
    // stableId variants
    "stableId",
    "stable_id",
    // Parent org
    "parentOrgId",
    "parent_org_id",
    // Things table parent ref
    "parent_thing_id",
    // Funding programs org ref
    "org_id",
    // Benchmark results model ref
    "model_id",
    // Facts table subject (references entities.stableId)
    "subject",
    // camelCase EntityId suffix (from Drizzle property names)
    "personEntityId",
    "orgEntityId",
    "companyEntityId",
  ];

  for (const col of POSITIVE_CASES) {
    it(`detects "${col}" as entity ref`, () => {
      expect(isEntityRefColumn(col)).toBe(true);
    });
  }

  // ── Columns that must NOT be detected ──────────────────────────────────
  const NEGATIVE_CASES = [
    // Internal IDs that are not entity refs
    "id",
    "fact_id",
    "resource_id",
    "source_id",
    "thing_type",
    // Data columns
    "title",
    "description",
    "value",
    "label",
    "note",
    "source",
    "measure",
    "currency",
    "format",
    // Boolean/date columns
    "authored_by_entity",
    "is_subject",
    "created_at",
    "updated_at",
    // Columns that contain "entity" but aren't entity FK refs
    "entity_type",
    "entity_name",
  ];

  for (const col of NEGATIVE_CASES) {
    it(`does NOT detect "${col}" as entity ref`, () => {
      expect(isEntityRefColumn(col)).toBe(false);
    });
  }
});

describe("isEntityRefKey (camelCase Drizzle row keys)", () => {
  // ── Keys that MUST be detected ─────────────────────────────────────────
  const POSITIVE_CASES = [
    "entityId",
    "personEntityId",
    "orgEntityId",
    "companyEntityId",
    "investorEntityId",
    "stableId",
    "personId",
    "parentOrgId",
    "orgId",
    "parentThingId",
    "modelId",
    "subject",
  ];

  for (const key of POSITIVE_CASES) {
    it(`detects "${key}" as entity ref key`, () => {
      expect(isEntityRefKey(key)).toBe(true);
    });
  }

  // ── Keys that must NOT be detected ─────────────────────────────────────
  const NEGATIVE_CASES = [
    "id",
    "factId",
    "resourceId",
    "sourceId",
    "thingType",
    "title",
    "description",
    "entityType",
    "sourceTable",
    "authoredByEntity",
  ];

  for (const key of NEGATIVE_CASES) {
    it(`does NOT detect "${key}" as entity ref key`, () => {
      expect(isEntityRefKey(key)).toBe(false);
    });
  }
});

describe("endsWith edge case regression", () => {
  it("endsWith('_entity_id') does NOT match bare 'entity_id'", () => {
    // This is the root cause of the original bug — document it explicitly
    expect("entity_id".endsWith("_entity_id")).toBe(false);
    // But our function handles it via the explicit === check
    expect(isEntityRefColumn("entity_id")).toBe(true);
  });

  it("endsWith('_entity_id') matches compound column names", () => {
    expect("person_entity_id".endsWith("_entity_id")).toBe(true);
    expect(isEntityRefColumn("person_entity_id")).toBe(true);
  });
});
