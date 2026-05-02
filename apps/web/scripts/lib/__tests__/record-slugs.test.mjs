/**
 * Tests for record-slugs.mjs (QUA-908).
 */

import { describe, it, expect } from "vitest";
import { slugify, candidateSlugs, assignSlugs } from "../record-slugs.mjs";

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  it("collapses runs of non-alphanumerics", () => {
    expect(slugify("Foo --- Bar // Baz")).toBe("foo-bar-baz");
  });

  it("strips leading and trailing hyphens", () => {
    expect(slugify("--Hello--")).toBe("hello");
  });

  it("strips diacritics", () => {
    expect(slugify("Café Naïve")).toBe("cafe-naive");
  });

  it("returns empty string for null/undefined/empty", () => {
    expect(slugify(null)).toBe("");
    expect(slugify(undefined)).toBe("");
    expect(slugify("")).toBe("");
  });

  it("truncates to 80 chars without trailing hyphen", () => {
    const long = "a".repeat(100);
    expect(slugify(long).length).toBe(80);
    const longMixed = "ab-".repeat(40);
    const result = slugify(longMixed);
    expect(result.length).toBeLessThanOrEqual(80);
    expect(result.endsWith("-")).toBe(false);
  });

  it("handles names with currency and punctuation", () => {
    expect(slugify("Series A — $50M Round")).toBe("series-a-50m-round");
  });
});

describe("candidateSlugs", () => {
  const ownerSlugs = new Map([
    ["sid_anthropic1", "anthropic"],
    ["sid_xai1234567", "xai"],
  ]);
  const getOwnerSlug = (id) => ownerSlugs.get(id) ?? null;

  it("for funding-rounds, always namespaces by owner when owner exists", () => {
    const record = {
      key: "vjzygxG2V9",
      ownerEntityId: "sid_anthropic1",
      fields: { name: "Series G" },
    };
    const { base, withOwner } = candidateSlugs(record, "funding-rounds", getOwnerSlug);
    expect(base).toBe("anthropic-series-g");
    expect(withOwner).toBe("anthropic-series-g");
  });

  it("for funding-programs, base is the bare slug when no collision", () => {
    const record = {
      key: "pJ9oHvQ1Bb",
      ownerEntityId: "sid_anthropic1",
      fields: { name: "Rise Global Talent Program" },
    };
    const { base, withOwner } = candidateSlugs(record, "funding-programs", getOwnerSlug);
    expect(base).toBe("rise-global-talent-program");
    expect(withOwner).toBe("anthropic-rise-global-talent-program");
  });

  it("does not double-prefix when name already starts with owner slug", () => {
    const record = {
      key: "abc",
      ownerEntityId: "sid_anthropic1",
      fields: { name: "Anthropic Series G" },
    };
    const { withOwner } = candidateSlugs(record, "funding-rounds", getOwnerSlug);
    expect(withOwner).toBe("anthropic-series-g");
  });

  it("falls back to bare slug when owner has no slug", () => {
    const record = {
      key: "abc",
      ownerEntityId: "sid_unknown",
      fields: { name: "Series A" },
    };
    const { base } = candidateSlugs(record, "funding-rounds", getOwnerSlug);
    expect(base).toBe("series-a");
  });

  it("falls back to record.key when name is missing", () => {
    const record = {
      key: "abc1234567",
      ownerEntityId: "sid_anthropic1",
      fields: {},
    };
    const { base } = candidateSlugs(record, "funding-programs", getOwnerSlug);
    // slugify("abc1234567") strips nothing — it's already alphanumeric
    expect(base).toBe("abc1234567");
  });
});

describe("assignSlugs", () => {
  const owners = new Map([
    ["sid_anthropic1", "anthropic"],
    ["sid_xai1234567", "xai"],
    ["sid_openai0000", "openai"],
  ]);
  const getOwnerSlug = (id) => owners.get(id) ?? null;

  it("assigns unique slugs to distinct funding-programs records", () => {
    const records = [
      { key: "AAAAAAAAAA", ownerEntityId: "sid_anthropic1", fields: { name: "Rise Talent" } },
      { key: "BBBBBBBBBB", ownerEntityId: "sid_openai0000", fields: { name: "Superalignment Fast Grants" } },
    ];
    assignSlugs(records, "funding-programs", getOwnerSlug);
    expect(records[0].slug).toBe("rise-talent");
    expect(records[1].slug).toBe("superalignment-fast-grants");
  });

  it("namespaces colliding funding-program names by owner", () => {
    const records = [
      { key: "AAAAAAAAAA", ownerEntityId: "sid_anthropic1", fields: { name: "Open Call" } },
      { key: "BBBBBBBBBB", ownerEntityId: "sid_openai0000", fields: { name: "Open Call" } },
    ];
    assignSlugs(records, "funding-programs", getOwnerSlug);
    const slugs = records.map((r) => r.slug).sort();
    expect(slugs).toEqual(["anthropic-open-call", "openai-open-call"]);
    expect(new Set(slugs).size).toBe(2);
  });

  it("namespaces all funding-rounds by company even without collision", () => {
    const records = [
      { key: "AAAAAAAAAA", ownerEntityId: "sid_xai1234567", fields: { name: "Series E" } },
      { key: "BBBBBBBBBB", ownerEntityId: "sid_anthropic1", fields: { name: "Series G" } },
    ];
    assignSlugs(records, "funding-rounds", getOwnerSlug);
    const slugs = records.map((r) => r.slug).sort();
    expect(slugs).toEqual(["anthropic-series-g", "xai-series-e"]);
  });

  it("appends a 4-char suffix when even owner-prefixed slug collides", () => {
    // Two rounds with the same name at the same company
    const records = [
      { key: "AAAAAAAAAA", ownerEntityId: "sid_anthropic1", fields: { name: "Series A" } },
      { key: "BBBBBBBBBB", ownerEntityId: "sid_anthropic1", fields: { name: "Series A" } },
    ];
    assignSlugs(records, "funding-rounds", getOwnerSlug);
    const slugs = records.map((r) => r.slug).sort();
    // First wins the un-suffixed slot (sorted by key); second gets suffix.
    expect(slugs).toEqual(["anthropic-series-a", "anthropic-series-a-bbbb"]);
  });

  it("is deterministic regardless of input order", () => {
    const r1 = { key: "AAAAAAAAAA", ownerEntityId: "sid_anthropic1", fields: { name: "Open Call" } };
    const r2 = { key: "BBBBBBBBBB", ownerEntityId: "sid_openai0000", fields: { name: "Open Call" } };

    const forward = [{ ...r1 }, { ...r2 }];
    const reverse = [{ ...r2 }, { ...r1 }];
    assignSlugs(forward, "funding-programs", getOwnerSlug);
    assignSlugs(reverse, "funding-programs", getOwnerSlug);

    const fwd = new Map(forward.map((r) => [r.key, r.slug]));
    const rev = new Map(reverse.map((r) => [r.key, r.slug]));
    expect(fwd.get("AAAAAAAAAA")).toBe(rev.get("AAAAAAAAAA"));
    expect(fwd.get("BBBBBBBBBB")).toBe(rev.get("BBBBBBBBBB"));
  });

  it("falls back gracefully when name and owner both missing", () => {
    const records = [
      { key: "ABCDEFGHIJ", ownerEntityId: "", fields: {} },
    ];
    assignSlugs(records, "funding-programs", () => null);
    expect(records[0].slug).toBeTruthy();
    expect(records[0].slug).toBe("abcdefghij");
  });

  it("handles empty record list", () => {
    /** @type {any[]} */
    const records = [];
    expect(() => assignSlugs(records, "funding-programs", getOwnerSlug)).not.toThrow();
  });

  it("produces only URL-safe characters", () => {
    const records = [
      { key: "AAAAAAAAAA", ownerEntityId: "sid_xai1234567", fields: { name: "Series E — $6B / lead Valor!" } },
      { key: "BBBBBBBBBB", ownerEntityId: "sid_anthropic1", fields: { name: "Investments in (claude)?" } },
    ];
    assignSlugs(records, "funding-rounds", getOwnerSlug);
    for (const r of records) {
      expect(r.slug).toMatch(/^[a-z0-9-]+$/);
      expect(r.slug.startsWith("-")).toBe(false);
      expect(r.slug.endsWith("-")).toBe(false);
    }
  });
});
