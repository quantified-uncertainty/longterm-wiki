/**
 * Org resolver tests (QUA-698).
 *
 * Exercises `resolveOrg` against synthetic matcher + override maps
 * (no fs, no database.json read). The real `buildOrgResolver` is left
 * as an integration concern.
 */

import { describe, it, expect } from "vitest";
import { resolveOrg } from "../org-aliases.ts";
import type { OrgResolverContext } from "../org-aliases.ts";
import type { EntityMatcher } from "../../grant-import/types.ts";

function makeMatcher(map: Record<string, string>): EntityMatcher {
  const nameMap = new Map(
    Object.entries(map).map(([name, stableId]) => [
      name.toLowerCase(),
      { stableId, slug: name, name },
    ]),
  );
  return {
    allNames: nameMap,
    match: (name: string) => nameMap.get(name.toLowerCase().trim()) || null,
  };
}

function ctx(
  matchMap: Record<string, string>,
  overrides: Record<string, string> = {},
): OrgResolverContext {
  // Mirror the lower-case normalization that loadOverrides() does.
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(overrides)) lower[k.toLowerCase()] = v;
  return { matcher: makeMatcher(matchMap), overrides: lower };
}

describe("resolveOrg", () => {
  it("returns null for empty / whitespace input", () => {
    const c = ctx({ anthropic: "sid_aaa" });
    expect(resolveOrg(c, "")).toBeNull();
    expect(resolveOrg(c, "   ")).toBeNull();
  });

  it("resolves via override before direct match", () => {
    const c = ctx(
      { anthropic: "sid_aaa", openai: "sid_bbb" },
      // Override redirects "Mystery Lab" → openai (would otherwise fail).
      { "Mystery Lab": "openai" },
    );
    expect(resolveOrg(c, "Mystery Lab")?.entityId).toBe("sid_bbb");
  });

  it("override lookup is case-insensitive on the key", () => {
    const c = ctx(
      { anthropic: "sid_aaa" },
      { "ANTHROPIC PBC": "anthropic" },
    );
    // Override key was "ANTHROPIC PBC" but user supplies mixed case.
    expect(resolveOrg(c, "anthropic pbc")?.entityId).toBe("sid_aaa");
    expect(resolveOrg(c, "Anthropic Pbc")?.entityId).toBe("sid_aaa");
  });

  it("falls through to direct title/alias match when no override", () => {
    const c = ctx({ anthropic: "sid_aaa" });
    expect(resolveOrg(c, "Anthropic")?.entityId).toBe("sid_aaa");
    expect(resolveOrg(c, "anthropic")?.entityId).toBe("sid_aaa");
  });

  it("falls through to normalized match (suffix-stripped)", () => {
    const c = ctx({ anthropic: "sid_aaa" });
    // "Anthropic, Inc." -> normalized "Anthropic" -> match.
    expect(resolveOrg(c, "Anthropic, Inc.")?.entityId).toBe("sid_aaa");
  });

  it("returns null when nothing matches — never fabricates a sid", () => {
    const c = ctx({ anthropic: "sid_aaa" });
    expect(resolveOrg(c, "Some Lab That Does Not Exist")).toBeNull();
  });

  it("throws if an override points to a slug that doesn't resolve", () => {
    // Override claims "X Corp" → "ghost-org" but the matcher has no
    // such entity. This is a data bug in the YAML — surface loudly.
    const c = ctx({ anthropic: "sid_aaa" }, { "X Corp": "ghost-org" });
    expect(() => resolveOrg(c, "X Corp")).toThrow(
      /override.*X Corp.*ghost-org/,
    );
  });

  it("returns the canonical name from the matcher (not the override key)", () => {
    const c = ctx(
      { anthropic: "sid_aaa" },
      { "Anthropic PBC": "anthropic" },
    );
    const r = resolveOrg(c, "Anthropic PBC");
    // Canonical name comes from database.json (the matcher). The
    // override is only for routing the lookup.
    expect(r?.canonicalName).toBe("anthropic");
  });
});
