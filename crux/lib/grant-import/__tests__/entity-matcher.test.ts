import { describe, it, expect } from "vitest";
import { matchGrantee, MANUAL_GRANTEE_OVERRIDES } from "../entity-matcher.ts";
import type { EntityMatcher } from "../types.ts";

function makeMockMatcher(map: Record<string, string>): EntityMatcher {
  const nameMap = new Map(
    Object.entries(map).map(([name, stableId]) => [
      name.toLowerCase(),
      { stableId, slug: name, name },
    ])
  );
  return {
    allNames: nameMap,
    match: (name: string) => nameMap.get(name.toLowerCase().trim()) || null,
  };
}

describe("matchGrantee", () => {
  const matcher = makeMockMatcher({
    miri: "abc123",
    anthropic: "def456",
    arc: "ghi789",
    "center-for-ai-safety": "jkl012",
    cset: "mno345",
    elicit: "pqr678",
  });

  it("matches via manual override", () => {
    // "Machine Intelligence Research Institute" → "miri" → "abc123"
    expect(matchGrantee("Machine Intelligence Research Institute", matcher)).toBe("abc123");
  });

  it("matches via override acronym", () => {
    expect(matchGrantee("MIRI", matcher)).toBe("abc123");
  });

  it("returns null for unknown name", () => {
    expect(matchGrantee("Totally Unknown Org", matcher)).toBeNull();
  });

  it("matches directly when no override exists", () => {
    expect(matchGrantee("Anthropic", matcher)).toBe("def456");
  });

  it("prefers override over direct match when both exist", () => {
    // "ARC" override maps to "arc" slug which resolves to ghi789
    expect(matchGrantee("ARC", matcher)).toBe("ghi789");
  });

  it("accepts extra overrides", () => {
    const result = matchGrantee("Custom Org", matcher, { "Custom Org": "miri" });
    expect(result).toBe("abc123");
  });

  it("extra overrides take precedence over built-in", () => {
    const result = matchGrantee("MIRI", matcher, { MIRI: "cset" });
    expect(result).toBe("mno345");
  });

  it("includes FTX-specific overrides", () => {
    expect(MANUAL_GRANTEE_OVERRIDES["Ought"]).toBe("elicit");
    expect(MANUAL_GRANTEE_OVERRIDES["Quantified Uncertainty Research Institute"]).toBe("quri");
  });
});
