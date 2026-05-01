import { describe, it, expect } from "vitest";
import {
  analyzePolicyGaps,
  analyzeOrganizationGaps,
  coverageScoreForEntity,
  isSupportedCoverageType,
  organizationCoverageScore,
  policyCoverageScore,
  SUPPORTED_COVERAGE_TYPES,
  type OrganizationEntity,
  type PolicyEntity,
} from "../gap-analyzer.ts";

// ─── Policy ────────────────────────────────────────────────────────────────

describe("analyzePolicyGaps", () => {
  it("flags missing top-level scalars", () => {
    const e: PolicyEntity = { id: "x", type: "policy", title: "X" };
    const gaps = analyzePolicyGaps(e);
    expect(gaps.find((g) => g.key === "scalar.description")).toBeDefined();
    expect(gaps.find((g) => g.key === "scalar.billNumber")).toBeDefined();
  });

  it("orders by priority descending", () => {
    const e: PolicyEntity = { id: "x", type: "policy", title: "X" };
    const gaps = analyzePolicyGaps(e);
    for (let i = 1; i < gaps.length; i++) {
      expect(gaps[i - 1].priority).toBeGreaterThanOrEqual(gaps[i].priority);
    }
  });

  it("computes coverage score in [0,1]", () => {
    const empty: PolicyEntity = { id: "x", type: "policy" };
    expect(policyCoverageScore(empty).score).toBe(0);
    const filled: PolicyEntity = {
      id: "x",
      type: "policy",
      description: "long description blob",
      billNumber: "S.1234",
      introduced: "2024-01-01",
      policyStatus: "enacted",
      author: "Senator X",
      jurisdiction: "United States",
      fullTextUrl: "https://example.com",
      provisions: Array.from({ length: 6 }, (_, i) => ({ title: `prov ${i}` })),
      stakeholders: Array.from({ length: 5 }, (_, i) => ({ name: `s${i}` })),
      tags: ["a", "b", "c"],
      relatedEntries: [
        { id: "a", type: "policy" },
        { id: "b", type: "policy" },
        { id: "c", type: "policy" },
      ],
    };
    expect(policyCoverageScore(filled).score).toBe(1);
  });
});

// ─── Organization ──────────────────────────────────────────────────────────

describe("analyzeOrganizationGaps", () => {
  it("flags all missing top-level scalars on an empty org", () => {
    const e: OrganizationEntity = { id: "anthropic", type: "organization", title: "Anthropic" };
    const gaps = analyzeOrganizationGaps(e);
    const keys = gaps.map((g) => g.key);
    expect(keys).toContain("scalar.description");
    expect(keys).toContain("scalar.website");
    expect(keys).toContain("scalar.orgType");
    expect(keys).toContain("scalar.founded");
    expect(keys).toContain("scalar.headquarters");
    expect(keys).toContain("scalar.employees");
  });

  it("flags products / keyPeople / keyDates gaps when below target", () => {
    const e: OrganizationEntity = { id: "x", type: "organization", title: "X" };
    const gaps = analyzeOrganizationGaps(e);
    expect(gaps.find((g) => g.key === "products")).toBeDefined();
    expect(gaps.find((g) => g.key === "keyPeople")).toBeDefined();
    expect(gaps.find((g) => g.key === "keyDates")).toBeDefined();
  });

  it("does NOT flag products gap when target met", () => {
    const e: OrganizationEntity = {
      id: "x",
      type: "organization",
      title: "X",
      products: [
        { name: "p1" },
        { name: "p2" },
        { name: "p3" },
      ],
    };
    const gaps = analyzeOrganizationGaps(e);
    expect(gaps.find((g) => g.key === "products")).toBeUndefined();
  });

  it("counts bare-string keyPeople entries toward the target", () => {
    const e: OrganizationEntity = {
      id: "x",
      type: "organization",
      title: "X",
      keyPeople: ["alice", "bob", "carol"],
    };
    const gaps = analyzeOrganizationGaps(e);
    expect(gaps.find((g) => g.key === "keyPeople")).toBeUndefined();
  });

  it("includes existing keyPeople names in the gap description for dedup hint", () => {
    const e: OrganizationEntity = {
      id: "x",
      type: "organization",
      title: "X",
      keyPeople: ["alice"],
    };
    const gaps = analyzeOrganizationGaps(e);
    const peopleGap = gaps.find((g) => g.key === "keyPeople");
    expect(peopleGap).toBeDefined();
    expect(peopleGap!.description).toContain("alice");
  });

  it("always emits factbase gaps for cross-base routing", () => {
    const e: OrganizationEntity = { id: "x", type: "organization", title: "X" };
    const gaps = analyzeOrganizationGaps(e);
    expect(gaps.find((g) => g.key === "factbase.revenue")).toBeDefined();
    expect(gaps.find((g) => g.key === "factbase.valuation")).toBeDefined();
  });

  it("orders gaps by priority descending", () => {
    const e: OrganizationEntity = { id: "x", type: "organization", title: "X" };
    const gaps = analyzeOrganizationGaps(e);
    for (let i = 1; i < gaps.length; i++) {
      expect(gaps[i - 1].priority).toBeGreaterThanOrEqual(gaps[i].priority);
    }
  });

  it("flags scalar gap when value is too short (<4 chars)", () => {
    const e: OrganizationEntity = {
      id: "x",
      type: "organization",
      title: "X",
      description: "abc", // 3 chars — too short
    };
    const gaps = analyzeOrganizationGaps(e);
    expect(gaps.find((g) => g.key === "scalar.description")).toBeDefined();
  });
});

describe("organizationCoverageScore", () => {
  it("returns 0 for empty entity (factbase weight 0.1 not earned)", () => {
    const e: OrganizationEntity = { id: "x", type: "organization" };
    expect(organizationCoverageScore(e).score).toBe(0);
  });

  it("score caps at 0.9 even when all local fields full (factbase out-of-scope)", () => {
    const e: OrganizationEntity = {
      id: "x",
      type: "organization",
      description: "long enough description string",
      website: "https://x.com",
      orgType: "frontier-lab",
      founded: "2021",
      headquarters: "San Francisco, CA",
      employees: "1000",
      products: [{ name: "p1" }, { name: "p2" }, { name: "p3" }],
      keyPeople: ["a", "b", "c"],
      keyDates: [
        { date: "2021", description: "founded" },
        { date: "2022", description: "series A" },
      ],
    };
    const cov = organizationCoverageScore(e);
    // top_level=1*0.4 + products=1*0.2 + keyPeople=1*0.2 + keyDates=1*0.1 + factbase=0*0.1 = 0.9
    expect(cov.score).toBe(0.9);
    expect(cov.components.factbase).toBe(0);
    expect(cov.facts_in_yaml.products).toBe(3);
  });

  it("partial fill produces partial score", () => {
    const e: OrganizationEntity = {
      id: "x",
      type: "organization",
      description: "a description",
      website: "https://x.com",
      orgType: "frontier-lab",
      // founded, headquarters, employees missing → 3/6 = 0.5 top-level
      keyPeople: ["a", "b", "c"], // full
    };
    const cov = organizationCoverageScore(e);
    // 0.5*0.4 + 0*0.2 + 1*0.2 + 0*0.1 + 0 = 0.4
    expect(cov.score).toBe(0.4);
  });
});

// ─── Type-aware dispatch (QUA-936) ─────────────────────────────────────────

describe("coverageScoreForEntity", () => {
  it("dispatches to policyCoverageScore for type=policy", () => {
    const policy = { id: "p", type: "policy", title: "P" } as PolicyEntity;
    const direct = policyCoverageScore(policy);
    const dispatched = coverageScoreForEntity(policy);
    expect(dispatched).toEqual(direct);
  });

  it("dispatches to organizationCoverageScore for type=organization", () => {
    const org = { id: "o", type: "organization", title: "O" } as OrganizationEntity;
    const direct = organizationCoverageScore(org);
    const dispatched = coverageScoreForEntity(org);
    expect(dispatched).toEqual(direct);
  });

  it("returns null for unsupported types", () => {
    expect(coverageScoreForEntity({ type: "person" })).toBeNull();
    expect(coverageScoreForEntity({ type: "ai-model" })).toBeNull();
    expect(coverageScoreForEntity({ type: "" })).toBeNull();
  });
});

describe("isSupportedCoverageType", () => {
  it("accepts every type listed in SUPPORTED_COVERAGE_TYPES", () => {
    for (const t of SUPPORTED_COVERAGE_TYPES) {
      expect(isSupportedCoverageType(t)).toBe(true);
    }
  });

  it("rejects unsupported types", () => {
    expect(isSupportedCoverageType("person")).toBe(false);
    expect(isSupportedCoverageType("benchmark")).toBe(false);
    expect(isSupportedCoverageType("")).toBe(false);
  });
});
