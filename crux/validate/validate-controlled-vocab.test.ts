import { describe, it, expect } from "vitest";
import {
  suggestCorrection,
  checkValue,
  checkYamlEntities,
  VALID_ENTITY_TYPES,
  VALID_RELATIONSHIPS,
  VALID_MATURITIES,
  type VocabIssue,
  type EntityData,
} from "./validate-controlled-vocab.ts";

// ---------------------------------------------------------------------------
// suggestCorrection
// ---------------------------------------------------------------------------

describe("suggestCorrection", () => {
  const vocab = new Set([
    "key-person",
    "board",
    "career",
    "frontier-lab",
    "safety-org",
    "academic",
    "government",
    "funder",
    "startup",
    "generic",
    "other",
  ]);

  it("returns the exact match for a value already in the vocab", () => {
    expect(suggestCorrection("key-person", vocab)).toBe("key-person");
  });

  it("suggests correction for underscore-to-hyphen typos", () => {
    expect(suggestCorrection("key_person", vocab)).toBe("key-person");
  });

  it("suggests correction for minor misspellings", () => {
    expect(suggestCorrection("fronter-lab", vocab)).toBe("frontier-lab");
  });

  it("suggests correction for case differences when close enough", () => {
    expect(suggestCorrection("Funder", vocab)).toBe("funder");
  });

  it("suggests correction for missing hyphen", () => {
    expect(suggestCorrection("keyperson", vocab)).toBe("key-person");
  });

  it("returns undefined for completely unrelated strings", () => {
    expect(suggestCorrection("xyzzy-foobarbaz", vocab)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(suggestCorrection("", vocab)).toBeUndefined();
  });

  it("suggests correction for extra character", () => {
    expect(suggestCorrection("startupp", vocab)).toBe("startup");
  });

  it("suggests correction for missing character", () => {
    expect(suggestCorrection("generi", vocab)).toBe("generic");
  });

  it("returns undefined when vocab is empty", () => {
    expect(suggestCorrection("anything", new Set())).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// checkValue
// ---------------------------------------------------------------------------

describe("checkValue", () => {
  it("records an issue for values not in the vocabulary", () => {
    const issues: VocabIssue[] = [];
    const vocab = new Set(["alpha", "beta"]);
    checkValue("testField", "gamma", vocab, "entity-1", "test.yaml", issues);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual({
      field: "testField",
      value: "gamma",
      entityId: "entity-1",
      sourceFile: "test.yaml",
      suggestion: undefined,
    });
  });

  it("does not record an issue for valid values", () => {
    const issues: VocabIssue[] = [];
    const vocab = new Set(["alpha", "beta"]);
    checkValue("testField", "alpha", vocab, "entity-1", "test.yaml", issues);
    expect(issues).toHaveLength(0);
  });

  it("skips null and undefined values", () => {
    const issues: VocabIssue[] = [];
    const vocab = new Set(["alpha"]);
    checkValue("f", null, vocab, "e", "s", issues);
    checkValue("f", undefined, vocab, "e", "s", issues);
    expect(issues).toHaveLength(0);
  });

  it("skips empty string values", () => {
    const issues: VocabIssue[] = [];
    const vocab = new Set(["alpha"]);
    checkValue("f", "", vocab, "e", "s", issues);
    expect(issues).toHaveLength(0);
  });

  it("trims whitespace before checking", () => {
    const issues: VocabIssue[] = [];
    const vocab = new Set(["alpha"]);
    checkValue("f", "  alpha  ", vocab, "e", "s", issues);
    expect(issues).toHaveLength(0);
  });

  it("includes suggestion for close typos", () => {
    const issues: VocabIssue[] = [];
    const vocab = new Set(["frontier-lab"]);
    checkValue("f", "fronter-lab", vocab, "e", "s", issues);
    expect(issues).toHaveLength(1);
    expect(issues[0].suggestion).toBe("frontier-lab");
  });
});

// ---------------------------------------------------------------------------
// checkYamlEntities
// ---------------------------------------------------------------------------

describe("checkYamlEntities", () => {
  function makeEntity(
    overrides: Partial<EntityData> & { id: string }
  ): EntityData & { _sourceFile: string } {
    return {
      type: "organization",
      ...overrides,
      _sourceFile: "/data/entities/test.yaml",
    };
  }

  it("returns no issues for entities with all valid values", () => {
    const entities = [
      makeEntity({
        id: "test-org",
        type: "organization",
        orgType: "frontier-lab",
        status: "published",
        clusters: ["ai-safety"],
      }),
    ];
    const issues = checkYamlEntities(entities);
    expect(issues).toHaveLength(0);
  });

  it("flags invalid entity type", () => {
    const entities = [
      makeEntity({ id: "bad-type", type: "nonexistent-type" }),
    ];
    const issues = checkYamlEntities(entities);
    expect(issues).toHaveLength(1);
    expect(issues[0].field).toBe("type");
    expect(issues[0].value).toBe("nonexistent-type");
    expect(issues[0].entityId).toBe("bad-type");
  });

  it("flags invalid orgType", () => {
    const entities = [
      makeEntity({ id: "bad-org", type: "organization", orgType: "mega-corp" }),
    ];
    const issues = checkYamlEntities(entities);
    expect(issues).toHaveLength(1);
    expect(issues[0].field).toBe("orgType");
    expect(issues[0].value).toBe("mega-corp");
  });

  it("flags invalid severity", () => {
    const entities = [
      makeEntity({ id: "bad-sev", type: "risk", severity: "extreme" }),
    ];
    const issues = checkYamlEntities(entities);
    expect(issues).toHaveLength(1);
    expect(issues[0].field).toBe("severity");
  });

  it("accepts case variants of severity", () => {
    const entities = [
      makeEntity({ id: "ok-sev", type: "risk", severity: "High" }),
    ];
    const issues = checkYamlEntities(entities);
    // "High" is in the valid set as a case variant
    expect(issues).toHaveLength(0);
  });

  it("flags invalid maturity", () => {
    const entities = [
      makeEntity({ id: "bad-mat", type: "risk", maturity: "Unknown" }),
    ];
    const issues = checkYamlEntities(entities);
    expect(issues).toHaveLength(1);
    expect(issues[0].field).toBe("maturity");
  });

  // entity.status is no longer checked here — chk_entities_status (migration
  // 0218) and SyncEntitySchema's z.enum() now own that contract.

  it("flags invalid cluster values", () => {
    const entities = [
      makeEntity({
        id: "bad-cluster",
        type: "risk",
        clusters: ["ai-safety", "invalid-cluster"],
      }),
    ];
    const issues = checkYamlEntities(entities);
    expect(issues).toHaveLength(1);
    expect(issues[0].field).toBe("clusters");
    expect(issues[0].value).toBe("invalid-cluster");
  });

  it("flags invalid policyStatus on policy entities", () => {
    const entities = [
      makeEntity({
        id: "bad-policy",
        type: "policy",
        policyStatus: "cancelled",
      }),
    ];
    const issues = checkYamlEntities(entities);
    expect(issues).toHaveLength(1);
    expect(issues[0].field).toBe("policyStatus");
  });

  it("ignores policyStatus on non-policy entities", () => {
    const entities = [
      makeEntity({
        id: "not-policy",
        type: "organization",
        policyStatus: "cancelled",
      }),
    ];
    const issues = checkYamlEntities(entities);
    // policyStatus is only checked for type=policy
    expect(issues).toHaveLength(0);
  });

  it("flags invalid projectStatus on project entities", () => {
    const entities = [
      makeEntity({
        id: "bad-project",
        type: "project",
        projectStatus: "dead",
      }),
    ];
    const issues = checkYamlEntities(entities);
    expect(issues).toHaveLength(1);
    expect(issues[0].field).toBe("projectStatus");
  });

  it("flags invalid relatedEntries.relationship", () => {
    const entities = [
      makeEntity({
        id: "bad-rel",
        type: "risk",
        relatedEntries: [
          { id: "other", type: "risk", relationship: "fights" },
        ],
      }),
    ];
    const issues = checkYamlEntities(entities);
    const relIssue = issues.find(
      (i) => i.field === "relatedEntries.relationship"
    );
    expect(relIssue).toBeDefined();
    expect(relIssue!.value).toBe("fights");
  });

  it("flags invalid relatedEntries.type", () => {
    const entities = [
      makeEntity({
        id: "bad-re-type",
        type: "risk",
        relatedEntries: [
          { id: "other", type: "nonexistent-type", relationship: "related" },
        ],
      }),
    ];
    const issues = checkYamlEntities(entities);
    const typeIssue = issues.find((i) => i.field === "relatedEntries.type");
    expect(typeIssue).toBeDefined();
    expect(typeIssue!.value).toBe("nonexistent-type");
  });

  it("handles entities with missing optional fields", () => {
    const entities = [makeEntity({ id: "minimal" })];
    const issues = checkYamlEntities(entities);
    expect(issues).toHaveLength(0);
  });

  it("accumulates multiple issues from multiple entities", () => {
    const entities = [
      makeEntity({ id: "e1", type: "fake-type" }),
      makeEntity({ id: "e2", type: "another-fake" }),
    ];
    const issues = checkYamlEntities(entities);
    expect(issues).toHaveLength(2);
    expect(issues[0].entityId).toBe("e1");
    expect(issues[1].entityId).toBe("e2");
  });

  it("uses (unknown) for entities without an id", () => {
    const entities = [
      { type: "fake-type", _sourceFile: "/test.yaml" } as EntityData & {
        _sourceFile: string;
      },
    ];
    const issues = checkYamlEntities(entities);
    expect(issues[0].entityId).toBe("(unknown)");
  });
});

// ---------------------------------------------------------------------------
// Vocabulary set correctness — canonical source alignment
// ---------------------------------------------------------------------------

describe("vocabulary sets align with canonical sources", () => {
  it("VALID_ENTITY_TYPES contains canonical entity types", () => {
    // Spot-check core types that must always exist
    const coreTypes = [
      "risk",
      "organization",
      "person",
      "policy",
      "project",
      "concept",
      "ai-model",
      "benchmark",
    ];
    for (const t of coreTypes) {
      expect(VALID_ENTITY_TYPES.has(t)).toBe(true);
    }
  });

  it("VALID_ENTITY_TYPES contains legacy aliases", () => {
    expect(VALID_ENTITY_TYPES.has("researcher")).toBe(true);
    expect(VALID_ENTITY_TYPES.has("lab")).toBe(true);
    expect(VALID_ENTITY_TYPES.has("lab-frontier")).toBe(true);
  });

  it("VALID_RELATIONSHIPS contains core relationship types", () => {
    const core = ["related", "causes", "mitigates", "enables", "blocks"];
    for (const r of core) {
      expect(VALID_RELATIONSHIPS.has(r)).toBe(true);
    }
  });

  // entities.status / EntityStatus is now PG-enforced (chk_entities_status,
  // migration 0218) so the matching set is no longer exported from the
  // validator.

  it("VALID_MATURITIES matches ResearchMaturity enum", () => {
    expect(VALID_MATURITIES.has("Neglected")).toBe(true);
    expect(VALID_MATURITIES.has("Emerging")).toBe(true);
    expect(VALID_MATURITIES.has("Growing")).toBe(true);
    expect(VALID_MATURITIES.has("Mature")).toBe(true);
    expect(VALID_MATURITIES.size).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Relationship vocabulary completeness (existing tests)
// ---------------------------------------------------------------------------

describe("controlled vocabulary sets", () => {
  it("relationship vocabulary contains common relationship values", () => {
    const knownRelationships = [
      "related",
      "causes",
      "mitigates",
      "enables",
      "blocks",
      "composed-of",
      "part-of",
      "created-by",
      "leads-to",
      "addresses",
      "affects",
      "research",
      "analyzes",
    ];

    for (const rel of knownRelationships) {
      const typo = rel.slice(0, -1) + "x";
      const vocabSet = new Set(knownRelationships);
      const suggestion = suggestCorrection(typo, vocabSet);
      expect(suggestion).toBe(rel);
    }
  });
});

// ---------------------------------------------------------------------------
// Edge cases for the suggestion algorithm (existing tests)
// ---------------------------------------------------------------------------

describe("suggestCorrection edge cases", () => {
  const smallVocab = new Set(["ab", "cd"]);

  it("does not suggest when distance exceeds 50% of candidate length", () => {
    expect(suggestCorrection("zz", smallVocab)).toBeUndefined();
  });

  it("suggests single-char correction for short strings", () => {
    expect(suggestCorrection("ac", smallVocab)).toBeUndefined();
  });

  it("handles the exact match edge case (distance=0)", () => {
    expect(suggestCorrection("ab", smallVocab)).toBe("ab");
  });
});
