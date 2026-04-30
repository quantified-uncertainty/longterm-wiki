import { describe, it, expect } from "vitest";
import {
  applyVerdictsToOrganization,
  applyVerdictsToPolicy,
  canonicalizePersonKey,
  type VerifiedVerdict,
} from "../apply-verdicts.ts";
import type { OrganizationEntity, OrganizationKeyPersonObject, PolicyEntity } from "../gap-analyzer.ts";

function v(over: Partial<VerifiedVerdict>): VerifiedVerdict {
  return {
    targetField: "scalar.description",
    claimText: "Some claim text",
    extractedValue: null,
    proposedValue: null,
    sourceUrl: "https://example.com",
    status: "verified",
    ...over,
  };
}

// ─── canonicalizePersonKey ─────────────────────────────────────────────────

describe("canonicalizePersonKey", () => {
  it("strips degree suffixes", () => {
    expect(canonicalizePersonKey("Sam Altman, PhD")).toBe("sam-altman");
    expect(canonicalizePersonKey("Sam Altman PhD")).toBe("sam-altman");
    expect(canonicalizePersonKey("John Smith Jr.")).toBe("john-smith");
    expect(canonicalizePersonKey("Jane Doe Sr.")).toBe("jane-doe");
    expect(canonicalizePersonKey("King George III")).toBe("king-george");
  });

  it("returns same key for slug and display variants", () => {
    expect(canonicalizePersonKey("sam-altman")).toBe(canonicalizePersonKey("Sam Altman"));
    expect(canonicalizePersonKey("Sam Altman, PhD")).toBe(canonicalizePersonKey("Sam Altman"));
  });

  it("handles empty input", () => {
    expect(canonicalizePersonKey("")).toBe("");
  });
});

// ─── applyVerdictsToPolicy (smoke) ─────────────────────────────────────────

describe("applyVerdictsToPolicy", () => {
  it("applies a verified scalar to an empty entity", () => {
    const entity: PolicyEntity = { id: "x", type: "policy" };
    const result = applyVerdictsToPolicy(entity, [
      v({
        targetField: "scalar.billNumber",
        extractedValue: "S.1234",
        status: "verified",
      }),
    ]);
    expect(result.entity.billNumber).toBe("S.1234");
    expect(result.applied[0]).toEqual({ targetField: "scalar.billNumber", action: "added" });
  });

  it("skips contradicted/unverifiable verdicts", () => {
    const entity: PolicyEntity = { id: "x", type: "policy" };
    const result = applyVerdictsToPolicy(entity, [
      v({ targetField: "scalar.billNumber", status: "contradicted", extractedValue: "X" }),
    ]);
    expect(result.entity.billNumber).toBeUndefined();
    expect(result.applied).toEqual([]);
  });
});

// ─── applyVerdictsToOrganization ───────────────────────────────────────────

describe("applyVerdictsToOrganization", () => {
  it("applies scalar fields to an empty org", () => {
    const entity: OrganizationEntity = { id: "anthropic", type: "organization", title: "Anthropic" };
    const result = applyVerdictsToOrganization(entity, [
      v({ targetField: "scalar.website", extractedValue: "https://anthropic.com" }),
      v({ targetField: "scalar.headquarters", extractedValue: "San Francisco, CA" }),
      v({ targetField: "scalar.founded", extractedValue: "2021" }),
    ]);
    expect(result.entity.website).toBe("https://anthropic.com");
    expect(result.entity.headquarters).toBe("San Francisco, CA");
    expect(result.entity.founded).toBe("2021");
    expect(result.applied.every((a) => a.action === "added")).toBe(true);
  });

  it("rejects unknown scalar fields", () => {
    const entity: OrganizationEntity = { id: "x", type: "organization" };
    const result = applyVerdictsToOrganization(entity, [
      v({ targetField: "scalar.unknownField", extractedValue: "x" }),
    ]);
    expect(result.warnings).toContain("unknown scalar field: unknownField");
    expect(result.applied[0].action).toBe("skipped");
  });

  it("skips already-filled scalar (no overwrite)", () => {
    const entity: OrganizationEntity = {
      id: "x",
      type: "organization",
      website: "https://existing.com",
    };
    const result = applyVerdictsToOrganization(entity, [
      v({ targetField: "scalar.website", extractedValue: "https://new.com" }),
    ]);
    expect(result.entity.website).toBe("https://existing.com");
    expect(result.applied[0]).toMatchObject({ action: "skipped", reason: "already filled" });
  });

  it("adds new product entries", () => {
    const entity: OrganizationEntity = { id: "x", type: "organization", title: "X" };
    const result = applyVerdictsToOrganization(entity, [
      v({
        targetField: "product.claude-3-5-sonnet",
        extractedValue: "Claude 3.5 Sonnet is a frontier model.",
        displayHint: "Claude 3.5 Sonnet",
        sourceUrl: "https://anthropic.com/news/claude-3-5",
      }),
    ]);
    expect(result.entity.products).toHaveLength(1);
    expect(result.entity.products![0]).toEqual({
      name: "Claude 3.5 Sonnet",
      description: "Claude 3.5 Sonnet is a frontier model.",
      source: "https://anthropic.com/news/claude-3-5",
    });
  });

  it("dedupes products by slugified name", () => {
    const entity: OrganizationEntity = {
      id: "x",
      type: "organization",
      products: [{ name: "Claude 3.5 Sonnet", description: "old short" }],
    };
    const result = applyVerdictsToOrganization(entity, [
      v({
        targetField: "product.claude-3-5-sonnet",
        extractedValue: "A much longer and more detailed description.",
        displayHint: "Claude 3.5 Sonnet",
      }),
    ]);
    expect(result.entity.products).toHaveLength(1);
    expect(result.entity.products![0].description).toBe("A much longer and more detailed description.");
    expect(result.applied[0].action).toBe("updated");
  });

  it("skips product update when existing description is longer", () => {
    const entity: OrganizationEntity = {
      id: "x",
      type: "organization",
      products: [
        { name: "p", description: "An existing long detailed description that is more comprehensive." },
      ],
    };
    const result = applyVerdictsToOrganization(entity, [
      v({ targetField: "product.p", extractedValue: "short" }),
    ]);
    expect(result.applied[0]).toMatchObject({ action: "skipped" });
  });

  it("adds keyPerson as an object with slug+name+source", () => {
    const entity: OrganizationEntity = { id: "x", type: "organization" };
    const result = applyVerdictsToOrganization(entity, [
      v({
        targetField: "keyPerson.dario-amodei",
        displayHint: "Dario Amodei",
        sourceUrl: "https://wired.com/anthropic-profile",
      }),
    ]);
    expect(result.entity.keyPeople).toHaveLength(1);
    const kp = result.entity.keyPeople![0] as OrganizationKeyPersonObject;
    expect(kp.name).toBe("Dario Amodei");
    expect(kp.source).toBe("https://wired.com/anthropic-profile");
  });

  it("dedupes keyPerson against existing bare-slug entries (canonicalization)", () => {
    const entity: OrganizationEntity = {
      id: "anthropic",
      type: "organization",
      keyPeople: ["dario-amodei", "daniela-amodei"],
    };
    const result = applyVerdictsToOrganization(entity, [
      v({
        targetField: "keyPerson.dario-amodei",
        displayHint: "Dario Amodei, PhD", // canonicalizes to dario-amodei
      }),
    ]);
    expect(result.entity.keyPeople).toHaveLength(2); // no new entry
    // The bare string was upgraded to an object only if there's a new field to add — here
    // there's no resolver and no source URL on this verdict, so it should remain a string.
    // But our verdict has a sourceUrl by default from the helper. Let's check:
    const e0 = result.entity.keyPeople![0];
    if (typeof e0 === "string") {
      // Stayed as string when no new info to add
      expect(e0).toBe("dario-amodei");
    } else {
      // Upgraded to object with at least name or source
      expect(e0.name ?? e0.slug).toMatch(/dario/i);
    }
  });

  it("uses resolvePersonEntity to attach entityId on new keyPerson", () => {
    const entity: OrganizationEntity = { id: "anthropic", type: "organization" };
    const result = applyVerdictsToOrganization(
      entity,
      [
        v({
          targetField: "keyPerson.sam-altman",
          displayHint: "Sam Altman",
        }),
      ],
      {
        resolvePersonEntity: (canon) => (canon === "sam-altman" ? "sam-altman" : null),
      },
    );
    const kp = result.entity.keyPeople![0] as OrganizationKeyPersonObject;
    expect(kp.entityId).toBe("sam-altman");
  });

  it("adds keyDate when extractedValue carries the date", () => {
    const entity: OrganizationEntity = { id: "x", type: "organization" };
    const result = applyVerdictsToOrganization(entity, [
      v({
        targetField: "keyDate.founded",
        extractedValue: "January 2021",
        displayHint: "Founded as Anthropic PBC",
      }),
    ]);
    expect(result.entity.keyDates).toEqual([
      {
        date: "January 2021",
        description: "Founded as Anthropic PBC",
        source: "https://example.com",
      },
    ]);
  });

  it("skips keyDate when no date value present", () => {
    const entity: OrganizationEntity = { id: "x", type: "organization" };
    const result = applyVerdictsToOrganization(entity, [
      v({ targetField: "keyDate.founded", extractedValue: null, proposedValue: null }),
    ]);
    expect(result.entity.keyDates ?? []).toHaveLength(0);
    expect(result.applied[0]).toMatchObject({ action: "skipped", reason: "no date value" });
  });

  it("dedupes tags", () => {
    const entity: OrganizationEntity = { id: "x", type: "organization", tags: ["ai-safety"] };
    const result = applyVerdictsToOrganization(entity, [
      v({ targetField: "tag.ai-safety", extractedValue: "duplicate" }),
      v({ targetField: "tag.interpretability", extractedValue: "new" }),
    ]);
    expect(result.entity.tags).toEqual(["ai-safety", "interpretability"]);
    expect(result.applied[0].action).toBe("skipped");
    expect(result.applied[1].action).toBe("added");
  });

  it("adds relatedEntry once and dedupes by id", () => {
    const entity: OrganizationEntity = { id: "x", type: "organization" };
    const result = applyVerdictsToOrganization(entity, [
      v({ targetField: "relatedEntry.openai" }),
      v({ targetField: "relatedEntry.openai" }), // duplicate
    ]);
    expect(result.entity.relatedEntries).toHaveLength(1);
    expect(result.entity.relatedEntries![0]).toEqual({ id: "openai", type: "organization" });
    expect(result.applied[0].action).toBe("added");
    expect(result.applied[1].action).toBe("skipped");
  });

  it("routes factbase.* to skipped (separate ticket) without warning", () => {
    const entity: OrganizationEntity = { id: "x", type: "organization" };
    const result = applyVerdictsToOrganization(entity, [
      v({ targetField: "factbase.revenue", extractedValue: "$2B ARR" }),
    ]);
    expect(result.applied[0]).toMatchObject({
      action: "skipped",
      reason: expect.stringContaining("factbase"),
    });
    expect(result.warnings).toEqual([]);
  });

  it("warns on unrecognized targetField", () => {
    const entity: OrganizationEntity = { id: "x", type: "organization" };
    const result = applyVerdictsToOrganization(entity, [
      v({ targetField: "garbage.xyz" }),
    ]);
    expect(result.warnings).toContain("unrecognized targetField: garbage.xyz");
    expect(result.applied[0].action).toBe("skipped");
  });

  it("does not corrupt existing fields when applying new ones", () => {
    const entity: OrganizationEntity = {
      id: "anthropic",
      type: "organization",
      description: "Existing description",
      website: "https://anthropic.com",
      tags: ["ai-safety", "constitutional-ai"],
      keyPeople: ["dario-amodei"],
      products: [{ name: "Claude", description: "AI assistant" }],
    };
    const result = applyVerdictsToOrganization(entity, [
      v({ targetField: "scalar.founded", extractedValue: "2021" }),
      v({ targetField: "tag.frontier-ai" }),
      v({
        targetField: "product.claude-3-5-sonnet",
        extractedValue: "newer model",
        displayHint: "Claude 3.5 Sonnet",
      }),
    ]);
    expect(result.entity.description).toBe("Existing description");
    expect(result.entity.website).toBe("https://anthropic.com");
    expect(result.entity.tags).toEqual(["ai-safety", "constitutional-ai", "frontier-ai"]);
    expect(result.entity.keyPeople).toEqual(["dario-amodei"]);
    // Original product preserved + new product appended.
    expect(result.entity.products).toHaveLength(2);
    expect(result.entity.products![0].name).toBe("Claude");
    expect(result.entity.products![1].name).toBe("Claude 3.5 Sonnet");
  });

  it("does not mutate input entity", () => {
    const entity: OrganizationEntity = {
      id: "x",
      type: "organization",
      tags: ["a"],
      products: [{ name: "p" }],
    };
    const before = JSON.stringify(entity);
    applyVerdictsToOrganization(entity, [
      v({ targetField: "tag.b" }),
      v({ targetField: "product.q", displayHint: "Q" }),
    ]);
    expect(JSON.stringify(entity)).toBe(before);
  });
});
