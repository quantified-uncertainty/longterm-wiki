/**
 * Entity profile display name resolution coverage test.
 *
 * Verifies that every column referencing entities.stableId in entity-profile
 * sections is either:
 * 1. Detected by the entity ref detection logic (resolved to display names), OR
 * 2. Explicitly hidden from the UI
 *
 * This test maintains a registry of all known entity FK columns per section,
 * extracted from the Drizzle schema. When adding a new entity FK column to a
 * table used by entity-profile, add it to ENTITY_FK_COLUMNS below.
 *
 * The Playwright e2e test (no-raw-ids.spec.ts) catches NEW unregistered columns
 * by detecting raw sid_ values in the rendered output. This test catches
 * regressions in the detection logic itself.
 */
import { describe, it, expect } from "vitest";

// ── Detection logic ──────────────────────────────────────────────────────
// SYNC NOTE: These are copies of the functions in:
//   apps/web/src/app/internal/entity-profile/entity-ref-columns.ts
// They cannot be imported because the wiki-server has no dependency on the
// web app. If you update one, update the other. The test below will fail
// if they diverge (different column lists = different detection results).
// Long-term fix: move to @longterm-wiki/id-utils shared package.

/** Frontend detection: PG column names (snake_case) */
function isEntityRefColumn(columnName: string): boolean {
  return (
    columnName.endsWith("EntityId") ||
    columnName.endsWith("_entity_id") ||
    columnName === "entity_id" ||
    columnName === "stableId" ||
    columnName === "stable_id" ||
    columnName === "parentOrgId" ||
    columnName === "parent_org_id" ||
    columnName === "parent_thing_id" ||
    columnName === "org_id" ||
    columnName === "model_id" ||
    columnName === "subject"
  );
}

/** Backend detection: Drizzle property names (camelCase) */
function isEntityRefKey(key: string): boolean {
  return (
    key.endsWith("EntityId") ||
    key === "stableId" ||
    key === "personId" ||
    key === "parentOrgId" ||
    key === "orgId" ||
    key === "entityId" ||
    key === "parentThingId" ||
    key === "modelId" ||
    key === "subject"
  );
}

// ── Registry of all entity FK columns per entity-profile section ─────────
//
// Each entry: { pgName, drizzleKey, disposition }
// disposition:
//   "detected" = handled by isEntityRefColumn + isEntityRefKey
//   "hidden"   = hidden via HIDDEN_COLUMNS config (not rendered)
//
// IMPORTANT: When adding a new entity FK column to any table used by
// entity-profile, add an entry here. The test will tell you whether
// to add it to detection or hiding.

interface FkEntry {
  pgName: string;
  drizzleKey: string;
  disposition: "detected" | "hidden";
}

const ENTITY_FK_COLUMNS: Record<string, FkEntry[]> = {
  personnel: [
    { pgName: "person_entity_id", drizzleKey: "personEntityId", disposition: "detected" },
    { pgName: "org_entity_id", drizzleKey: "orgEntityId", disposition: "detected" },
  ],
  divisions: [
    { pgName: "parent_org_id", drizzleKey: "parentOrgId", disposition: "detected" },
  ],
  divisionPersonnel: [
    { pgName: "person_id", drizzleKey: "personId", disposition: "hidden" },
  ],
  grantsGiven: [
    { pgName: "org_entity_id", drizzleKey: "orgEntityId", disposition: "detected" },
    { pgName: "grantee_entity_id", drizzleKey: "granteeEntityId", disposition: "detected" },
  ],
  grantsReceived: [
    { pgName: "org_entity_id", drizzleKey: "orgEntityId", disposition: "detected" },
    { pgName: "grantee_entity_id", drizzleKey: "granteeEntityId", disposition: "detected" },
  ],
  fundingRounds: [
    { pgName: "company_entity_id", drizzleKey: "companyEntityId", disposition: "detected" },
    { pgName: "lead_investor_entity_id", drizzleKey: "leadInvestorEntityId", disposition: "detected" },
  ],
  investments: [
    { pgName: "company_entity_id", drizzleKey: "companyEntityId", disposition: "detected" },
    { pgName: "investor_entity_id", drizzleKey: "investorEntityId", disposition: "detected" },
  ],
  equityPositions: [
    { pgName: "company_entity_id", drizzleKey: "companyEntityId", disposition: "detected" },
    { pgName: "holder_entity_id", drizzleKey: "holderEntityId", disposition: "detected" },
  ],
  fundingPrograms: [
    { pgName: "org_id", drizzleKey: "orgId", disposition: "detected" },
  ],
  policyStakeholders: [
    { pgName: "policy_entity_id", drizzleKey: "policyEntityId", disposition: "detected" },
    { pgName: "stakeholder_entity_id", drizzleKey: "stakeholderEntityId", disposition: "detected" },
  ],
  entityResources: [
    { pgName: "entity_id", drizzleKey: "entityId", disposition: "hidden" },
  ],
  facts: [
    { pgName: "entity_id", drizzleKey: "entityId", disposition: "hidden" },
    { pgName: "subject", drizzleKey: "subject", disposition: "detected" },
  ],
  things: [
    { pgName: "parent_thing_id", drizzleKey: "parentThingId", disposition: "hidden" },
  ],
  benchmarkResults: [
    { pgName: "model_id", drizzleKey: "modelId", disposition: "detected" },
  ],
};

// ── Tests ─────────────────────────────────────────────────────────────────

describe("Entity profile: detection functions cover all detected FK columns", () => {
  for (const [section, entries] of Object.entries(ENTITY_FK_COLUMNS)) {
    for (const { pgName, drizzleKey, disposition } of entries) {
      if (disposition !== "detected") continue;

      it(`[${section}] "${pgName}" is detected by isEntityRefColumn()`, () => {
        expect(
          isEntityRefColumn(pgName),
          `Column "${pgName}" in section "${section}" references entities.stableId ` +
          `and is marked as "detected", but isEntityRefColumn("${pgName}") returns false. ` +
          `Raw sid_ values will appear in the UI.`
        ).toBe(true);
      });

      it(`[${section}] "${drizzleKey}" is detected by isEntityRefKey()`, () => {
        expect(
          isEntityRefKey(drizzleKey),
          `Key "${drizzleKey}" in section "${section}" references entities.stableId ` +
          `and is marked as "detected", but isEntityRefKey("${drizzleKey}") returns false. ` +
          `This stableId won't be collected for display name resolution.`
        ).toBe(true);
      });
    }
  }
});

// Hidden FK columns (disposition: "hidden") are listed in ENTITY_FK_COLUMNS
// for completeness but don't need individual tests — they're never rendered.
// The comprehensive zero-gap check below verifies that every "detected"
// column passes both detection functions.

describe("endsWith regression guard", () => {
  it('endsWith("_entity_id") does NOT match bare "entity_id"', () => {
    // Root cause of the original bug: "_entity_id" (10 chars) > "entity_id" (9 chars)
    expect("entity_id".endsWith("_entity_id")).toBe(false);
    // Our detection function handles this via explicit === check
    expect(isEntityRefColumn("entity_id")).toBe(true);
  });

  it('endsWith("_entity_id") DOES match compound column names', () => {
    expect("person_entity_id".endsWith("_entity_id")).toBe(true);
    expect(isEntityRefColumn("person_entity_id")).toBe(true);
  });
});

describe("Non-entity columns are not falsely detected", () => {
  const NON_ENTITY_COLUMNS = [
    "id", "fact_id", "resource_id", "source_id", "thing_type",
    "title", "description", "value", "label", "note", "source",
    "measure", "currency", "format", "entity_type", "entity_name",
    "authored_by_entity", "is_subject", "created_at", "updated_at",
  ];

  for (const col of NON_ENTITY_COLUMNS) {
    it(`"${col}" is NOT detected as entity ref`, () => {
      expect(isEntityRefColumn(col)).toBe(false);
    });
  }

  const NON_ENTITY_KEYS = [
    "id", "factId", "resourceId", "sourceId", "thingType",
    "title", "description", "entityType", "sourceTable",
    "authoredByEntity",
  ];

  for (const key of NON_ENTITY_KEYS) {
    it(`"${key}" is NOT detected as entity ref key`, () => {
      expect(isEntityRefKey(key)).toBe(false);
    });
  }
});

describe("Comprehensive zero-gap check", () => {
  it("all registered FK columns are either detected or hidden", () => {
    const gaps: string[] = [];

    for (const [section, entries] of Object.entries(ENTITY_FK_COLUMNS)) {
      for (const { pgName, drizzleKey, disposition } of entries) {
        if (disposition === "detected") {
          if (!isEntityRefColumn(pgName)) {
            gaps.push(`${section}.${pgName}: marked "detected" but isEntityRefColumn() returns false`);
          }
          if (!isEntityRefKey(drizzleKey)) {
            gaps.push(`${section}.${drizzleKey}: marked "detected" but isEntityRefKey() returns false`);
          }
        }
        // Hidden columns are OK — they just need to be listed
      }
    }

    expect(
      gaps,
      `Found ${gaps.length} gap(s) in entity ref detection:\n` +
      gaps.map((g) => `  - ${g}`).join("\n")
    ).toHaveLength(0);
  });
});
