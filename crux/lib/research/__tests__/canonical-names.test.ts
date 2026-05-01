import { describe, expect, it } from "vitest";
import {
  STAKEHOLDER_ALIASES,
  canonicalSlug,
  generateSlugCandidates,
} from "../canonical-names.ts";

describe("canonicalSlug", () => {
  // ── Acronyms collapse to canonical ────────────────────────────────────────
  it.each([
    ["ACLU", "american-civil-liberties-union"],
    ["aclu", "american-civil-liberties-union"],
    ["American Civil Liberties Union", "american-civil-liberties-union"],
    ["EFF", "electronic-frontier-foundation"],
    ["Electronic Frontier Foundation", "electronic-frontier-foundation"],
    ["NSA", "national-security-agency"],
    ["National Security Agency", "national-security-agency"],
    ["FBI", "federal-bureau-of-investigation"],
    ["Federal Bureau of Investigation", "federal-bureau-of-investigation"],
    ["ODNI", "office-of-the-director-of-national-intelligence"],
    ["DNI", "office-of-the-director-of-national-intelligence"],
    ["FISC", "foreign-intelligence-surveillance-court"],
    ["FISA Court", "foreign-intelligence-surveillance-court"],
    ["Foreign Intelligence Surveillance Court", "foreign-intelligence-surveillance-court"],
    ["DOJ", "department-of-justice"],
    ["Department of Justice", "department-of-justice"],
    ["CIA", "central-intelligence-agency"],
    ["Central Intelligence Agency", "central-intelligence-agency"],
  ])("collapses %s → %s", (input, expected) => {
    expect(canonicalSlug(input)).toBe(expected);
  });

  // ── Parenthetical and prefix variants ─────────────────────────────────────
  it("handles 'FBI (Federal Bureau of Investigation)'", () => {
    expect(canonicalSlug("FBI (Federal Bureau of Investigation)")).toBe(
      "federal-bureau-of-investigation",
    );
  });

  it("handles 'Federal Bureau of Investigation (FBI)'", () => {
    expect(canonicalSlug("Federal Bureau of Investigation (FBI)")).toBe(
      "federal-bureau-of-investigation",
    );
  });

  it("strips 'U.S.' prefix on Department of Justice", () => {
    expect(canonicalSlug("U.S. Department of Justice")).toBe("department-of-justice");
  });

  it("strips 'United States' prefix on Department of Defense", () => {
    expect(canonicalSlug("United States Department of Defense")).toBe("department-of-defense");
  });

  it("strips 'U.S.A.' prefix", () => {
    expect(canonicalSlug("U.S.A. Department of State")).toBe("department-of-state");
  });

  // ── No-match fallback ─────────────────────────────────────────────────────
  it("returns slugified input when no alias matches", () => {
    expect(canonicalSlug("Some Unknown Org")).toBe("some-unknown-org");
  });

  it("returns empty string for empty input", () => {
    expect(canonicalSlug("")).toBe("");
  });

  it("handles already-slugified input", () => {
    expect(canonicalSlug("aclu")).toBe("american-civil-liberties-union");
    expect(canonicalSlug("federal-bureau-of-investigation")).toBe(
      "federal-bureau-of-investigation",
    );
  });

  it("is case-insensitive on parenthetical splits", () => {
    expect(canonicalSlug("aclu (American Civil Liberties Union)")).toBe(
      "american-civil-liberties-union",
    );
  });
});

describe("generateSlugCandidates", () => {
  it("returns a single slug for a plain name", () => {
    expect(generateSlugCandidates("Anthropic")).toEqual(["anthropic"]);
  });

  it("returns full slug, before-paren, and inside-paren", () => {
    const got = generateSlugCandidates("FBI (Federal Bureau of Investigation)");
    expect(got).toContain("fbi-federal-bureau-of-investigation");
    expect(got).toContain("fbi");
    expect(got).toContain("federal-bureau-of-investigation");
  });

  it("returns prefix-stripped variant", () => {
    const got = generateSlugCandidates("U.S. Department of Justice");
    expect(got).toContain("u-s-department-of-justice");
    expect(got).toContain("department-of-justice");
  });

  it("dedupes candidates", () => {
    const got = generateSlugCandidates("Anthropic");
    const set = new Set(got);
    expect(got.length).toBe(set.size);
  });

  it("returns empty array for empty input", () => {
    expect(generateSlugCandidates("")).toEqual([]);
  });
});

describe("canonicalSlug — edge cases & no-false-match", () => {
  it("'FBI Warning' (compound name with FBI prefix) does NOT match FBI", () => {
    expect(canonicalSlug("FBI Warning")).toBe("fbi-warning");
  });

  it("'Senate cafeteria' does NOT match the senate canonical", () => {
    expect(canonicalSlug("Senate cafeteria")).toBe("senate-cafeteria");
  });

  it("'Treasury bonds' does NOT match treasury canonical", () => {
    expect(canonicalSlug("Treasury bonds")).toBe("treasury-bonds");
  });

  it("does not truncate long compound names (slugify-60-char-cap regression)", () => {
    // Build a long name that, under apply-verdicts.ts's 60-char slugify, would
    // truncate. canonicalSlug uses fullSlug to avoid silent alias misses.
    const long =
      "Office of the Director of National Intelligence and Other Offices and Bodies";
    // The substring "office of the director of national intelligence" still
    // matches via the prefix-stripped path? Actually no — the candidate
    // generator only does parens-split + U.S.-prefix-strip, not arbitrary
    // substring splitting. So this should slug to its full form (no truncation).
    const got = canonicalSlug(long);
    expect(got.length).toBeGreaterThan(60);
    expect(got).toBe(
      "office-of-the-director-of-national-intelligence-and-other-offices-and-bodies",
    );
  });

  it("handles unicode (non-ASCII) input by collapsing to slug", () => {
    expect(canonicalSlug("Comisión Federal")).toBe("comisi-n-federal");
  });

  it("handles trailing/leading whitespace", () => {
    expect(canonicalSlug("  FBI  ")).toBe("federal-bureau-of-investigation");
  });

  it("returns the raw slug when no alias matches and no candidates collide", () => {
    expect(canonicalSlug("Some Brand New Org")).toBe("some-brand-new-org");
  });
});

describe("STAKEHOLDER_ALIASES dictionary integrity", () => {
  it("every canonical key is itself in its alias list", () => {
    for (const [canonical, aliases] of Object.entries(STAKEHOLDER_ALIASES)) {
      expect(
        aliases.includes(canonical),
        `canonical "${canonical}" must appear in its own alias list`,
      ).toBe(true);
    }
  });

  it("aliases are all in slug form (lowercase, hyphenated)", () => {
    for (const [canonical, aliases] of Object.entries(STAKEHOLDER_ALIASES)) {
      for (const a of aliases) {
        expect(
          a,
          `alias "${a}" of "${canonical}" must be slug-form`,
        ).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      }
    }
  });

  it("no two canonical entries share an alias", () => {
    const aliasOwner = new Map<string, string>();
    for (const [canonical, aliases] of Object.entries(STAKEHOLDER_ALIASES)) {
      for (const a of aliases) {
        const prev = aliasOwner.get(a);
        expect(prev, `alias "${a}" claimed by both "${prev}" and "${canonical}"`).toBeUndefined();
        aliasOwner.set(a, canonical);
      }
    }
  });
});
