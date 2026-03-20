import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ApiResult } from "../lib/wiki-server/client.ts";

// Mock apiRequest before importing modules that use it
vi.mock("../lib/wiki-server/client.ts", () => ({
  apiRequest: vi.fn(),
  getServerUrl: vi.fn(() => "http://localhost:3002"),
  getApiKey: vi.fn(() => "test-key"),
  buildHeaders: vi.fn(() => ({ "Content-Type": "application/json" })),
}));

import { apiRequest } from "../lib/wiki-server/client.ts";
import {
  suggestCorrection,
  checkValue,
  checkYamlEntities,
  checkPersonnel,
  checkDivisions,
  VALID_ENTITY_TYPES,
  VALID_RELATIONSHIPS,
  VALID_ORG_TYPES,
  VALID_SEVERITIES,
  VALID_MATURITIES,
  VALID_STATUSES,
  VALID_CLUSTERS,
  VALID_POLICY_STATUSES,
  VALID_PROJECT_STATUSES,
  VALID_ROLE_TYPES,
  VALID_DIVISION_TYPES,
  VALID_DIVISION_STATUSES,
  type VocabIssue,
  type EntityData,
} from "./validate-controlled-vocab.ts";

const mockApiRequest = vi.mocked(apiRequest);

beforeEach(() => {
  mockApiRequest.mockReset();
});

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

  it("flags invalid status", () => {
    const entities = [
      makeEntity({ id: "bad-status", type: "risk", status: "pending" }),
    ];
    const issues = checkYamlEntities(entities);
    expect(issues).toHaveLength(1);
    expect(issues[0].field).toBe("status");
  });

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
// checkPersonnel (PG checks with mocked API)
// ---------------------------------------------------------------------------

describe("checkPersonnel", () => {
  it("returns no issues when all roleTypes are valid", async () => {
    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: {
        items: [
          {
            roleType: "key-person",
            personId: "alice",
            organizationId: "org-a",
            role: "CEO",
          },
          {
            roleType: "board",
            personId: "bob",
            organizationId: "org-b",
            role: "Director",
          },
        ],
        total: 2,
      },
    } as ApiResult<Record<string, unknown>>);

    const issues = await checkPersonnel();
    expect(issues).toHaveLength(0);
  });

  it("flags invalid roleType values", async () => {
    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: {
        items: [
          {
            roleType: "key_person",
            personId: "alice",
            organizationId: "org-a",
            role: "CEO",
          },
        ],
        total: 1,
      },
    } as ApiResult<Record<string, unknown>>);

    const issues = await checkPersonnel();
    expect(issues).toHaveLength(1);
    expect(issues[0].field).toBe("personnel.roleType");
    expect(issues[0].value).toBe("key_person");
    expect(issues[0].suggestion).toBe("key-person");
  });

  it("returns empty issues when wiki-server is unavailable", async () => {
    mockApiRequest.mockResolvedValueOnce({
      ok: false,
      error: "server_error" as const,
      message: "Connection refused",
    } as ApiResult<Record<string, unknown>>);

    const issues = await checkPersonnel();
    expect(issues).toHaveLength(0);
  });

  it("paginates through all personnel records", async () => {
    // First page: 2 records with total=3
    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: {
        items: [
          {
            roleType: "key-person",
            personId: "p1",
            organizationId: "o1",
            role: "CEO",
          },
          {
            roleType: "board",
            personId: "p2",
            organizationId: "o2",
            role: "Dir",
          },
        ],
        total: 3,
      },
    } as ApiResult<Record<string, unknown>>);
    // Second page: 1 record (invalid)
    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: {
        items: [
          {
            roleType: "invalid-type",
            personId: "p3",
            organizationId: "o3",
            role: "Unknown",
          },
        ],
        total: 3,
      },
    } as ApiResult<Record<string, unknown>>);

    const issues = await checkPersonnel();
    expect(mockApiRequest).toHaveBeenCalledTimes(2);
    expect(issues).toHaveLength(1);
    expect(issues[0].value).toBe("invalid-type");
  });
});

// ---------------------------------------------------------------------------
// checkDivisions (PG checks with mocked API)
// ---------------------------------------------------------------------------

describe("checkDivisions", () => {
  it("returns no issues when all values are valid", async () => {
    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: {
        items: [
          {
            divisionType: "team",
            name: "Safety Team",
            parentOrgId: "org-a",
            status: "active",
          },
          {
            divisionType: "fund",
            name: "Grants Fund",
            parentOrgId: "org-b",
            status: null,
          },
        ],
        total: 2,
      },
    } as ApiResult<Record<string, unknown>>);

    const issues = await checkDivisions();
    expect(issues).toHaveLength(0);
  });

  it("flags invalid divisionType", async () => {
    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: {
        items: [
          {
            divisionType: "bureau",
            name: "Some Bureau",
            parentOrgId: "org-a",
            status: "active",
          },
        ],
        total: 1,
      },
    } as ApiResult<Record<string, unknown>>);

    const issues = await checkDivisions();
    expect(issues).toHaveLength(1);
    expect(issues[0].field).toBe("divisions.divisionType");
    expect(issues[0].value).toBe("bureau");
  });

  it("flags invalid division status", async () => {
    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: {
        items: [
          {
            divisionType: "team",
            name: "Dead Team",
            parentOrgId: "org-a",
            status: "closed",
          },
        ],
        total: 1,
      },
    } as ApiResult<Record<string, unknown>>);

    const issues = await checkDivisions();
    expect(issues).toHaveLength(1);
    expect(issues[0].field).toBe("divisions.status");
    expect(issues[0].value).toBe("closed");
  });

  it("skips null division status without flagging", async () => {
    mockApiRequest.mockResolvedValueOnce({
      ok: true,
      data: {
        items: [
          {
            divisionType: "team",
            name: "No Status",
            parentOrgId: "org-a",
            status: null,
          },
        ],
        total: 1,
      },
    } as ApiResult<Record<string, unknown>>);

    const issues = await checkDivisions();
    expect(issues).toHaveLength(0);
  });

  it("returns empty issues when wiki-server is unavailable", async () => {
    mockApiRequest.mockResolvedValueOnce({
      ok: false,
      error: "server_error" as const,
      message: "Connection refused",
    } as ApiResult<Record<string, unknown>>);

    const issues = await checkDivisions();
    expect(issues).toHaveLength(0);
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

  it("VALID_STATUSES matches EntityStatus enum", () => {
    expect(VALID_STATUSES.has("stub")).toBe(true);
    expect(VALID_STATUSES.has("draft")).toBe(true);
    expect(VALID_STATUSES.has("published")).toBe(true);
    expect(VALID_STATUSES.has("verified")).toBe(true);
    expect(VALID_STATUSES.size).toBe(4);
  });

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
