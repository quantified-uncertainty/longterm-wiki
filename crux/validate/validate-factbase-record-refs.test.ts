import { describe, it, expect } from "vitest";

import {
  isSidRef,
  isLegacyIdRef,
  classifyFieldValue,
  buildEntityLookup,
  validateRecordRefs,
  type EntityLookup,
} from "./validate-factbase-record-refs.ts";

// ---------------------------------------------------------------------------
// Pattern detection tests
// ---------------------------------------------------------------------------

describe("isSidRef", () => {
  it("returns true for sid_-prefixed strings", () => {
    expect(isSidRef("sid_1LcLlMGLbw")).toBe(true);
    expect(isSidRef("sid_abc")).toBe(true);
    expect(isSidRef("sid_")).toBe(true);
  });

  it("returns false for non-sid_ strings", () => {
    expect(isSidRef("John Smith")).toBe(false);
    expect(isSidRef("anthropic")).toBe(false);
    expect(isSidRef("")).toBe(false);
    expect(isSidRef("SID_uppercase")).toBe(false);
  });
});

describe("isLegacyIdRef", () => {
  it("returns true for 10-char alphanumeric IDs with uppercase", () => {
    expect(isLegacyIdRef("mK9pX3rQ7n")).toBe(true);
    expect(isLegacyIdRef("ABCDEFGHIJ")).toBe(true);
    expect(isLegacyIdRef("aB3dE5gH9j")).toBe(true);
  });

  it("returns false for all-lowercase 10-char strings", () => {
    expect(isLegacyIdRef("abcdefghij")).toBe(false);
  });

  it("returns false for strings of wrong length", () => {
    expect(isLegacyIdRef("mK9pX3rQ7")).toBe(false); // 9 chars
    expect(isLegacyIdRef("mK9pX3rQ7nZ")).toBe(false); // 11 chars
  });

  it("returns false for strings with special characters", () => {
    expect(isLegacyIdRef("mK9pX3r-7n")).toBe(false);
    expect(isLegacyIdRef("mK9pX3r_7n")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isLegacyIdRef("")).toBe(false);
  });
});

describe("classifyFieldValue", () => {
  it("returns 'sid' for sid_ values in entity-like fields", () => {
    expect(classifyFieldValue("sid_1LcLlMGLbw", "person")).toBe("sid");
    expect(classifyFieldValue("sid_abc123", "organization")).toBe("sid");
  });

  it("returns 'legacy' for 10-char IDs in entity-like fields", () => {
    expect(classifyFieldValue("mK9pX3rQ7n", "recipient")).toBe("legacy");
  });

  it("returns null for non-string values", () => {
    expect(classifyFieldValue(42, "person")).toBeNull();
    expect(classifyFieldValue(true, "org")).toBeNull();
    expect(classifyFieldValue(null, "person")).toBeNull();
    expect(classifyFieldValue(undefined, "person")).toBeNull();
    expect(classifyFieldValue(["sid_abc"], "person")).toBeNull();
  });

  it("returns null for empty strings", () => {
    expect(classifyFieldValue("", "person")).toBeNull();
  });

  it("returns null for known non-entity fields regardless of content", () => {
    expect(classifyFieldValue("sid_1LcLlMGLbw", "title")).toBeNull();
    expect(classifyFieldValue("sid_1LcLlMGLbw", "notes")).toBeNull();
    expect(classifyFieldValue("sid_1LcLlMGLbw", "source")).toBeNull();
    expect(classifyFieldValue("sid_1LcLlMGLbw", "name")).toBeNull();
    expect(classifyFieldValue("sid_1LcLlMGLbw", "role")).toBeNull();
    expect(classifyFieldValue("sid_1LcLlMGLbw", "date")).toBeNull();
    expect(classifyFieldValue("sid_1LcLlMGLbw", "start")).toBeNull();
    expect(classifyFieldValue("sid_1LcLlMGLbw", "end")).toBeNull();
    expect(classifyFieldValue("sid_1LcLlMGLbw", "status")).toBeNull();
    expect(classifyFieldValue("sid_1LcLlMGLbw", "amount")).toBeNull();
  });

  it("returns null for regular human-readable text", () => {
    expect(classifyFieldValue("John Smith", "person")).toBeNull();
    expect(classifyFieldValue("Anthropic", "organization")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildEntityLookup
// ---------------------------------------------------------------------------

describe("buildEntityLookup", () => {
  it("builds lookup from idRegistry stableIdToSlug", () => {
    const lookup = buildEntityLookup({
      idRegistry: {
        stableIdToSlug: { sid_abc1234567: "anthropic" },
        stableIdBySlug: { anthropic: "sid_abc1234567" },
      },
    });
    expect(lookup.hasSid("sid_abc1234567")).toBe(true);
    expect(lookup.hasSlug("anthropic")).toBe(true);
    expect(lookup.hasSid("sid_unknown")).toBe(false);
    expect(lookup.hasSlug("unknown")).toBe(false);
  });

  it("builds lookup from typedEntities as fallback", () => {
    const lookup = buildEntityLookup({
      typedEntities: [
        { id: "anthropic", stableId: "sid_abc1234567" },
        { id: "openai" },
      ],
    });
    expect(lookup.hasSid("sid_abc1234567")).toBe(true);
    expect(lookup.hasSlug("anthropic")).toBe(true);
    expect(lookup.hasSlug("openai")).toBe(true);
  });

  it("handles empty database gracefully", () => {
    const lookup = buildEntityLookup({});
    expect(lookup.hasSid("sid_anything")).toBe(false);
    expect(lookup.hasSlug("anything")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateRecordRefs
// ---------------------------------------------------------------------------

function makeLookup(
  sids: string[] = [],
  slugs: string[] = [],
): EntityLookup {
  const sidSet = new Set(sids);
  const slugSet = new Set(slugs);
  return {
    hasSid: (s) => sidSet.has(s),
    hasSlug: (s) => slugSet.has(s),
  };
}

describe("validateRecordRefs", () => {
  it("passes with clean data (all references resolve)", () => {
    const records = {
      sid_org1: {
        "key-persons": [
          {
            key: "rec-1",
            schema: "key-person",
            ownerEntityId: "sid_org1",
            fields: {
              person: "sid_person1",
              title: "CEO",
            },
          },
        ],
      },
    };

    const lookup = makeLookup(["sid_org1", "sid_person1"]);
    const result = validateRecordRefs(records, lookup);
    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
    expect(result.totalRecords).toBe(1);
  });

  it("reports error for sid_ value that does not resolve", () => {
    const records = {
      sid_org1: {
        "key-persons": [
          {
            key: "rec-1",
            schema: "key-person",
            ownerEntityId: "sid_org1",
            fields: {
              person: "sid_unknown_person",
              title: "CEO",
            },
          },
        ],
      },
    };

    const lookup = makeLookup(["sid_org1"]);
    const result = validateRecordRefs(records, lookup);
    expect(result.passed).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toEqual({
      entityId: "sid_org1",
      collection: "key-persons",
      recordKey: "rec-1",
      fieldName: "person",
      rawValue: "sid_unknown_person",
      kind: "sid",
    });
  });

  it("reports warning for legacy 10-char ID that does not resolve", () => {
    const records = {
      sid_org1: {
        grants: [
          {
            key: "grant-1",
            schema: "grant",
            ownerEntityId: "sid_org1",
            fields: {
              recipient: "mK9pX3rQ7n",
              name: "Research Grant",
            },
          },
        ],
      },
    };

    const lookup = makeLookup(["sid_org1"]);
    const result = validateRecordRefs(records, lookup);
    expect(result.passed).toBe(true); // warnings don't fail
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toEqual({
      entityId: "sid_org1",
      collection: "grants",
      recordKey: "grant-1",
      fieldName: "recipient",
      rawValue: "mK9pX3rQ7n",
      kind: "legacy",
    });
  });

  it("does not warn for legacy 10-char ID that resolves as slug", () => {
    const records = {
      sid_org1: {
        grants: [
          {
            key: "grant-1",
            schema: "grant",
            ownerEntityId: "sid_org1",
            fields: {
              recipient: "mK9pX3rQ7n",
            },
          },
        ],
      },
    };

    // The ID resolves as a slug
    const lookup = makeLookup(["sid_org1"], ["mK9pX3rQ7n"]);
    const result = validateRecordRefs(records, lookup);
    expect(result.passed).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it("handles multiple records across multiple collections and entities", () => {
    const records = {
      sid_org1: {
        "key-persons": [
          {
            key: "rec-1",
            schema: "key-person",
            ownerEntityId: "sid_org1",
            fields: { person: "sid_bad_person_1" },
          },
          {
            key: "rec-2",
            schema: "key-person",
            ownerEntityId: "sid_org1",
            fields: { person: "sid_good_person" },
          },
        ],
        grants: [
          {
            key: "grant-1",
            schema: "grant",
            ownerEntityId: "sid_org1",
            fields: { recipient: "sid_bad_grantee" },
          },
        ],
      },
      sid_org2: {
        "key-persons": [
          {
            key: "rec-3",
            schema: "key-person",
            ownerEntityId: "sid_org2",
            fields: { person: "sid_bad_person_2" },
          },
        ],
      },
    };

    const lookup = makeLookup(["sid_org1", "sid_org2", "sid_good_person"]);
    const result = validateRecordRefs(records, lookup);
    expect(result.passed).toBe(false);
    expect(result.errors).toHaveLength(3);
    expect(result.errors.map((e) => e.rawValue).sort()).toEqual([
      "sid_bad_grantee",
      "sid_bad_person_1",
      "sid_bad_person_2",
    ]);
    expect(result.totalRecords).toBe(4);
  });

  it("handles empty records map", () => {
    const result = validateRecordRefs({}, makeLookup());
    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
    expect(result.totalRecords).toBe(0);
    expect(result.totalFieldsChecked).toBe(0);
  });

  it("handles entity with empty collections", () => {
    const records = {
      sid_org1: {},
    };
    const result = validateRecordRefs(records, makeLookup(["sid_org1"]));
    expect(result.passed).toBe(true);
    expect(result.totalRecords).toBe(0);
  });

  it("handles collection with empty array", () => {
    const records = {
      sid_org1: {
        "key-persons": [],
      },
    };
    const result = validateRecordRefs(records, makeLookup(["sid_org1"]));
    expect(result.passed).toBe(true);
    expect(result.totalRecords).toBe(0);
  });

  it("skips non-string field values (numbers, booleans, arrays, objects)", () => {
    const records = {
      sid_org1: {
        grants: [
          {
            key: "grant-1",
            schema: "grant",
            ownerEntityId: "sid_org1",
            fields: {
              numeric_field: 42,
              bool_field: true,
              array_field: ["sid_abc"],
              object_field: { id: "sid_abc" },
              null_field: null,
            },
          },
        ],
      },
    };

    const result = validateRecordRefs(records, makeLookup(["sid_org1"]));
    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
    expect(result.totalFieldsChecked).toBe(0);
  });

  it("skips known non-entity fields even if they contain sid_ values", () => {
    const records = {
      sid_org1: {
        "key-persons": [
          {
            key: "rec-1",
            schema: "key-person",
            ownerEntityId: "sid_org1",
            fields: {
              title: "sid_looks_like_id",
              notes: "sid_also_looks_like_id",
              source: "sid_source_id",
              name: "sid_name_id",
              role: "sid_role_id",
            },
          },
        ],
      },
    };

    const result = validateRecordRefs(records, makeLookup(["sid_org1"]));
    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.totalFieldsChecked).toBe(0);
  });

  it("detects sid_ that resolves via slug lookup (not just sid lookup)", () => {
    // Edge case: a sid_ value that happens to also be a known slug
    // (this shouldn't happen in practice, but the lookup should still pass it)
    const records = {
      sid_org1: {
        grants: [
          {
            key: "grant-1",
            schema: "grant",
            ownerEntityId: "sid_org1",
            fields: {
              // This sid_ value is not in the stableId set, but is a slug
              recipient: "sid_also_a_slug",
            },
          },
        ],
      },
    };

    const lookup = makeLookup([], ["sid_also_a_slug"]);
    const result = validateRecordRefs(records, lookup);
    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});
