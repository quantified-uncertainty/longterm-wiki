import { describe, it, expect } from "vitest";
import {
  applyVerdictsToOrganization,
  applyVerdictsToPolicy,
  canonicalizePersonKey,
  extractStructuredDate,
  MIN_POSITION_CONFIDENCE,
  normalizeProductDescription,
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

// ─── extractStructuredDate (QUA-937) ──────────────────────────────────────

describe("extractStructuredDate", () => {
  it("returns full ISO when proposedValue is exactly an ISO date", () => {
    expect(extractStructuredDate("2026-01-30")).toBe("2026-01-30");
  });

  it("finds ISO date embedded in narrative prose", () => {
    expect(
      extractStructuredDate(
        "Claude helped NASA travel 400m. Source updated 2026-01-30 per release notes.",
      ),
    ).toBe("2026-01-30");
  });

  it("parses Month Day, Year written out", () => {
    expect(extractStructuredDate("Date January 30, 2026")).toBe("2026-01-30");
    expect(extractStructuredDate("Feb 12, 2026")).toBe("2026-02-12");
    expect(extractStructuredDate("September 1 2024")).toBe("2024-09-01");
  });

  it("falls back to YYYY-MM for month-only precision", () => {
    expect(extractStructuredDate("January 2021")).toBe("2021-01");
    expect(extractStructuredDate("Sept 2024")).toBe("2024-09");
  });

  it("falls back to bare year when nothing tighter is available", () => {
    expect(extractStructuredDate("Spun out of OpenAI in 2021")).toBe("2021");
  });

  it("returns null when no date is present", () => {
    expect(extractStructuredDate("Claude helped the rover")).toBeNull();
    expect(extractStructuredDate("")).toBeNull();
    expect(extractStructuredDate(null)).toBeNull();
    expect(extractStructuredDate(undefined)).toBeNull();
  });

  it("rejects out-of-range ISO dates and falls through", () => {
    // Not a valid month — falls through to year fallback.
    expect(extractStructuredDate("2026-13-30")).toBe("2026");
  });

  it("rejects calendar-impossible full dates and falls through to coarser precision", () => {
    // Feb 31 / Apr 31 / Feb 29 (non-leap) — fail full-date validation, then
    // the YYYY-MM regex still matches the year-month prefix, which is the most
    // confident sub-precision the source actually supports.
    expect(extractStructuredDate("2026-02-31")).toBe("2026-02");
    expect(extractStructuredDate("2024-04-31")).toBe("2024-04");
    expect(extractStructuredDate("2023-02-29")).toBe("2023-02"); // not a leap year
    // "Feb 30, 2026" — month-day-year regex match fails calendar validation;
    // no YYYY-MM in the string, no Month-Year pattern (the comma breaks it),
    // so falls through to the bare-year branch.
    expect(extractStructuredDate("Feb 30, 2026")).toBe("2026");
  });

  it("accepts leap-year Feb 29", () => {
    expect(extractStructuredDate("2024-02-29")).toBe("2024-02-29");
    expect(extractStructuredDate("February 29, 2024")).toBe("2024-02-29");
  });

  it("accepts pre-1900 founding years", () => {
    expect(extractStructuredDate("Founded in 1865")).toBe("1865");
    expect(extractStructuredDate("Established 1850")).toBe("1850");
  });

  it("ignores ancient/future-bound years outside [1800-2099]", () => {
    expect(extractStructuredDate("written in 1066")).toBeNull();
    expect(extractStructuredDate("dated 2150")).toBeNull();
  });

  it("rejects out-of-range years in YYYY-MM-DD and YYYY-MM forms", () => {
    expect(extractStructuredDate("0000-01-01")).toBeNull();
    expect(extractStructuredDate("9999-12-31")).toBeNull();
    expect(extractStructuredDate("0000-01")).toBeNull();
  });

  it("extracts the date from an ISO 8601 timestamp with time component", () => {
    expect(extractStructuredDate("2024-06-15T10:30:00Z")).toBe("2024-06-15");
    expect(extractStructuredDate("2024-06-15T10:30:00.123Z")).toBe("2024-06-15");
    expect(extractStructuredDate("2024-06-15T10:30:00+02:00")).toBe("2024-06-15");
  });

  it("does not match dates with non-hyphen separators (e.g. URL slashes)", () => {
    // URL paths like /2024/06/15/ should fall through to the year fallback.
    expect(extractStructuredDate("https://example.com/2024/06/15/article")).toBe("2024");
  });

  it("ignores prose tokens that look almost like dates", () => {
    expect(extractStructuredDate("Founded2021Spunout")).toBeNull();
    expect(extractStructuredDate("v1-foo-bar")).toBeNull();
  });

  it("tries candidates in order, returning the first match", () => {
    expect(extractStructuredDate(null, "2026-01-30", "Claude helped")).toBe("2026-01-30");
    expect(extractStructuredDate("no date here", "January 2021")).toBe("2021-01");
  });
});

// ─── normalizeProductDescription (QUA-938) ─────────────────────────────────

describe("normalizeProductDescription", () => {
  it("strips leading dots and ellipses", () => {
    expect(
      normalizeProductDescription("...Claude is a model built for safety and helpfulness."),
    ).toBe("Claude is a model built for safety and helpfulness.");
    expect(
      normalizeProductDescription("…Claude is a model built for safety and helpfulness."),
    ).toBe("Claude is a model built for safety and helpfulness.");
    expect(
      normalizeProductDescription(",  Claude is a model built for safety and helpfulness."),
    ).toBe("Claude is a model built for safety and helpfulness.");
  });

  it("collapses mid-text ellipses", () => {
    expect(
      normalizeProductDescription("Claude is...a model built for safety and honesty."),
    ).toBe("Claude is a model built for safety and honesty.");
    expect(
      normalizeProductDescription("Claude is … a model built for safety and honesty."),
    ).toBe("Claude is a model built for safety and honesty.");
  });

  it("returns null for empty/null/undefined inputs", () => {
    expect(normalizeProductDescription(null)).toBeNull();
    expect(normalizeProductDescription(undefined)).toBeNull();
    expect(normalizeProductDescription("")).toBeNull();
    expect(normalizeProductDescription("   ")).toBeNull();
    expect(normalizeProductDescription("...")).toBeNull();
    expect(normalizeProductDescription("...,, …")).toBeNull();
  });

  it("returns null for descriptions under 8 words", () => {
    expect(normalizeProductDescription("Claude is good.")).toBeNull();
    expect(normalizeProductDescription("Claude is a frontier model from Anthropic.")).toBeNull();
  });

  it("accepts descriptions with at least 8 words and a verb", () => {
    expect(
      normalizeProductDescription("Claude is a family of large language models from Anthropic."),
    ).toBe("Claude is a family of large language models from Anthropic.");
  });

  it("returns null for noun-phrase fragments without a verb", () => {
    expect(
      normalizeProductDescription("An overview of the company's flagship items and consumer solutions worldwide today."),
    ).toBeNull();
  });

  it("trims overlong descriptions to the first sentence", () => {
    const long =
      "Claude is a family of large language models from Anthropic built for helpfulness. " +
      "It supports multiple modalities and has many use cases across industries. ".repeat(5);
    const result = normalizeProductDescription(long);
    expect(result).toBe(
      "Claude is a family of large language models from Anthropic built for helpfulness.",
    );
  });

  it("hard-truncates when no sentence terminator exists in the first 300 chars", () => {
    const long = ("Claude is a family of language models from Anthropic " as string).repeat(20);
    const result = normalizeProductDescription(long);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(300);
  });

  it("normalizes whitespace", () => {
    expect(
      normalizeProductDescription("Claude   is\t a\nfamily   of large language models from Anthropic."),
    ).toBe("Claude is a family of large language models from Anthropic.");
  });

  it("recognizes contractions as containing a verb (QUA-938 review fix)", () => {
    // "isn't" / "doesn't" / "won't" must be detected as containing the
    // verb stem after stripping the contraction suffix.
    expect(
      normalizeProductDescription("Claude isn't just a chatbot but a full coding assistant today."),
    ).toBe("Claude isn't just a chatbot but a full coding assistant today.");
    expect(
      normalizeProductDescription("Claude doesn't merely answer queries — it writes complete code."),
    ).toBe("Claude doesn't merely answer queries — it writes complete code.");
    // Curly-quote apostrophes (U+2019) are common in copy-paste from web sources.
    expect(
      normalizeProductDescription("Claude isn’t just a chatbot but a full coding assistant today."),
    ).toBe("Claude isn’t just a chatbot but a full coding assistant today.");
  });

  it("does not pass noun-only phrases that previously slipped through (QUA-938 review fix)", () => {
    // These should NOT be accepted — bare-stem ambiguous nouns ("design",
    // "support", "use", "release", "target", "process", "offer") were
    // dropped from COMMON_VERBS so a noun phrase using them is rejected.
    expect(
      normalizeProductDescription("A clean design from Anthropic for the modern enterprise era today now."),
    ).toBeNull();
    expect(
      normalizeProductDescription("A flexible support contract for enterprise customers and the public sector."),
    ).toBeNull();
    expect(
      normalizeProductDescription("A new release of the open-source toolchain for developers in industry."),
    ).toBeNull();
  });

  it("strips trailing comma fragments", () => {
    expect(
      normalizeProductDescription("Claude is a family of large language models from Anthropic,"),
    ).toBe("Claude is a family of large language models from Anthropic");
    expect(
      normalizeProductDescription("Claude is a family of large language models from Anthropic,   "),
    ).toBe("Claude is a family of large language models from Anthropic");
  });

  it("rejects descriptions containing launch-date or revenue indicators (QUA-938 write-path enforcement)", () => {
    // Mixed launch-date + revenue blurb — the canonical bad example from QUA-938.
    expect(
      normalizeProductDescription(
        "Claude Code was made available in June 2025 with run-rate revenue of $2.5 billion.",
      ),
    ).toBeNull();
    // Four-digit year alone is sufficient to reject.
    expect(
      normalizeProductDescription(
        "Claude is a family of large language models released in 2024 by Anthropic.",
      ),
    ).toBeNull();
    // Dollar sign (monetary indicator).
    expect(
      normalizeProductDescription(
        "Claude is a subscription assistant priced at $20 per month for individual users.",
      ),
    ).toBeNull();
    // Revenue keyword.
    expect(
      normalizeProductDescription(
        "Claude is Anthropic's flagship model and the primary driver of revenue for the company.",
      ),
    ).toBeNull();
    // Month name (non-May).
    expect(
      normalizeProductDescription(
        "Claude is a model that was launched in January by the Anthropic team for safety researchers.",
      ),
    ).toBeNull();
    // Clean description — should still pass.
    expect(
      normalizeProductDescription(
        "Claude is a family of large language models tuned for helpfulness, harmlessness, and honesty.",
      ),
    ).toBe(
      "Claude is a family of large language models tuned for helpfulness, harmlessness, and honesty.",
    );
    // "may" as a modal verb (not a month) — should NOT be rejected.
    expect(
      normalizeProductDescription(
        "Claude is a family of large language models that may be used across many enterprise workflows.",
      ),
    ).toBe(
      "Claude is a family of large language models that may be used across many enterprise workflows.",
    );
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

  // ─── Stakeholder canonicalization (QUA-872) ──────────────────────────────
  describe("stakeholder canonicalization", () => {
    it("collapses FISC and foreign-intelligence-surveillance-court targetFields", () => {
      const entity: PolicyEntity = { id: "fisa-702", type: "policy" };
      const result = applyVerdictsToPolicy(entity, [
        v({
          targetField: "stakeholder.fisc",
          displayHint: "Foreign Intelligence Surveillance Court (FISC)",
          extractedValue: "Approves Section 702 targeting procedures.",
        }),
        v({
          targetField: "stakeholder.foreign-intelligence-surveillance-court",
          displayHint: "Foreign Intelligence Surveillance Court",
          extractedValue: "Reviews FBI queries of US-person data.",
        }),
      ]);
      expect(result.entity.stakeholders).toHaveLength(1);
      expect(result.applied[0].action).toBe("added");
      expect(result.applied[1].action).toMatch(/updated|skipped/);
    });

    it("collapses FBI vs Federal Bureau of Investigation vs FBI (Federal Bureau of Investigation)", () => {
      const entity: PolicyEntity = { id: "fisa-702", type: "policy" };
      const result = applyVerdictsToPolicy(entity, [
        v({
          targetField: "stakeholder.fbi",
          displayHint: "FBI",
          extractedValue: "Queries Section 702 data for FBI investigations.",
        }),
        v({
          targetField: "stakeholder.federal-bureau-of-investigation",
          displayHint: "Federal Bureau of Investigation",
          extractedValue: "A much more comprehensive description of FBI's role here.",
        }),
        v({
          targetField: "stakeholder.fbi-federal-bureau-of-investigation",
          displayHint: "FBI (Federal Bureau of Investigation)",
          extractedValue: "Performs queries of 702 data.",
        }),
      ]);
      expect(result.entity.stakeholders).toHaveLength(1);
    });

    it("collapses DOJ vs U.S. Department of Justice vs Department of Justice", () => {
      const entity: PolicyEntity = { id: "fisa-702", type: "policy" };
      const result = applyVerdictsToPolicy(entity, [
        v({
          targetField: "stakeholder.doj",
          displayHint: "DOJ",
          extractedValue: "Oversight role in 702.",
        }),
        v({
          targetField: "stakeholder.us-department-of-justice",
          displayHint: "U.S. Department of Justice",
          extractedValue: "Oversees compliance.",
        }),
        v({
          targetField: "stakeholder.department-of-justice",
          displayHint: "Department of Justice",
          extractedValue: "Reports semiannually to Congress.",
        }),
      ]);
      expect(result.entity.stakeholders).toHaveLength(1);
    });

    it("collapses ACLU and EFF aliases", () => {
      const entity: PolicyEntity = { id: "fisa-702", type: "policy" };
      const result = applyVerdictsToPolicy(entity, [
        v({
          targetField: "stakeholder.aclu",
          displayHint: "ACLU",
          extractedValue: "Opposes Section 702 reauthorization.",
        }),
        v({
          targetField: "stakeholder.american-civil-liberties-union",
          displayHint: "American Civil Liberties Union",
          extractedValue: "Litigates FISA cases.",
        }),
        v({
          targetField: "stakeholder.eff",
          displayHint: "EFF",
          extractedValue: "Advocates for end to backdoor searches.",
        }),
        v({
          targetField: "stakeholder.electronic-frontier-foundation",
          displayHint: "Electronic Frontier Foundation",
          extractedValue: "Files amicus briefs in FISC.",
        }),
      ]);
      expect(result.entity.stakeholders).toHaveLength(2);
      const names = result.entity.stakeholders!.map((s) => s.name).sort();
      // Display names come from the *first* verdict that won the slot.
      expect(names).toEqual(["ACLU", "EFF"]);
    });

    it("collapses NSA, ODNI, CIA aliases", () => {
      const entity: PolicyEntity = { id: "fisa-702", type: "policy" };
      const result = applyVerdictsToPolicy(entity, [
        v({ targetField: "stakeholder.nsa", displayHint: "NSA", extractedValue: "Collects signals." }),
        v({
          targetField: "stakeholder.national-security-agency",
          displayHint: "National Security Agency",
          extractedValue: "Operates upstream collection.",
        }),
        v({ targetField: "stakeholder.odni", displayHint: "ODNI", extractedValue: "Coordinates IC." }),
        v({ targetField: "stakeholder.dni", displayHint: "DNI", extractedValue: "Reports to Congress." }),
        v({ targetField: "stakeholder.cia", displayHint: "CIA", extractedValue: "Targets foreigners." }),
        v({
          targetField: "stakeholder.central-intelligence-agency",
          displayHint: "Central Intelligence Agency",
          extractedValue: "Operates abroad.",
        }),
      ]);
      expect(result.entity.stakeholders).toHaveLength(3);
      const names = result.entity.stakeholders!.map((s) => s.name).sort();
      expect(names).toEqual(["CIA", "NSA", "ODNI"]);
    });

    it("FISA-702 adversarial input — full duplicate scenario from QUA-872", () => {
      const entity: PolicyEntity = { id: "fisa-702", type: "policy" };
      // Two slugs proposed for FISC, two for DOJ, three for FBI — the case
      // documented in the ticket. Should collapse to 3 entries total.
      const result = applyVerdictsToPolicy(entity, [
        v({
          targetField: "stakeholder.fisc",
          displayHint: "Foreign Intelligence Surveillance Court (FISC)",
          extractedValue: "Approves targeting procedures.",
        }),
        v({
          targetField: "stakeholder.foreign-intelligence-surveillance-court",
          displayHint: "Foreign Intelligence Surveillance Court (FISC)",
          extractedValue: "Reviews queries.",
        }),
        v({
          targetField: "stakeholder.doj",
          displayHint: "Department of Justice (DOJ)",
          extractedValue: "Oversight reports.",
        }),
        v({
          targetField: "stakeholder.us-department-of-justice",
          displayHint: "Department of Justice (DOJ)",
          extractedValue: "Compliance oversight.",
        }),
        v({
          targetField: "stakeholder.fbi",
          displayHint: "FBI",
          extractedValue: "Queries 702 data.",
        }),
        v({
          targetField: "stakeholder.federal-bureau-of-investigation",
          displayHint: "FBI (Federal Bureau of Investigation)",
          extractedValue: "Investigates threats.",
        }),
        v({
          targetField: "stakeholder.fbi-federal-bureau-of-investigation",
          displayHint: "Federal Bureau of Investigation",
          extractedValue: "Performs U.S.-person queries.",
        }),
      ]);
      // Three canonical stakeholders, no duplicates.
      expect(result.entity.stakeholders).toHaveLength(3);
      const names = result.entity.stakeholders!.map((s) => s.name);
      // Each name should be unique under canonicalSlug.
      const canonicals = new Set(names.map((n) =>
        n.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
      ));
      expect(canonicals.size).toBe(3);
    });

    it("dedupes against pre-existing stakeholders with alias name", () => {
      const entity: PolicyEntity = {
        id: "fisa-702",
        type: "policy",
        stakeholders: [{ name: "FBI", position: "support", reason: "Existing" }],
      };
      const result = applyVerdictsToPolicy(entity, [
        v({
          targetField: "stakeholder.federal-bureau-of-investigation",
          displayHint: "Federal Bureau of Investigation",
          extractedValue: "Much more detailed and comprehensive description of FBI role here.",
        }),
      ]);
      expect(result.entity.stakeholders).toHaveLength(1);
      expect(result.entity.stakeholders![0].name).toBe("FBI");
      expect(result.entity.stakeholders![0].reason).toMatch(/comprehensive description/);
      expect(result.applied[0].action).toBe("updated");
    });

    it("uses resolveStakeholderEntity to attach entityId on new stakeholder", () => {
      const entity: PolicyEntity = { id: "fisa-702", type: "policy" };
      const result = applyVerdictsToPolicy(
        entity,
        [
          v({
            targetField: "stakeholder.fbi",
            displayHint: "FBI",
            extractedValue: "Queries 702 data.",
          }),
        ],
        {
          resolveStakeholderEntity: (canon) =>
            canon === "federal-bureau-of-investigation" ? "sid_fbi123" : null,
        },
      );
      expect(result.entity.stakeholders).toHaveLength(1);
      expect(result.entity.stakeholders![0].entityId).toBe("sid_fbi123");
    });

    it("backfills entityId on existing stakeholder match", () => {
      const entity: PolicyEntity = {
        id: "fisa-702",
        type: "policy",
        stakeholders: [{ name: "FBI", position: "support", reason: "Long enough existing reason." }],
      };
      const result = applyVerdictsToPolicy(
        entity,
        [
          v({
            targetField: "stakeholder.federal-bureau-of-investigation",
            displayHint: "Federal Bureau of Investigation",
            // Shorter than existing — would normally skip.
            extractedValue: "Short.",
          }),
        ],
        {
          resolveStakeholderEntity: (canon) =>
            canon === "federal-bureau-of-investigation" ? "sid_fbi123" : null,
        },
      );
      expect(result.entity.stakeholders![0].entityId).toBe("sid_fbi123");
      expect(result.applied[0].action).toBe("updated");
    });

    it("does not corrupt entries with no canonical match", () => {
      const entity: PolicyEntity = { id: "x", type: "policy" };
      const result = applyVerdictsToPolicy(entity, [
        v({
          targetField: "stakeholder.some-novel-org",
          displayHint: "Some Novel Org",
          extractedValue: "Reason 1.",
        }),
        v({
          targetField: "stakeholder.another-novel-org",
          displayHint: "Another Novel Org",
          extractedValue: "Reason 2.",
        }),
      ]);
      expect(result.entity.stakeholders).toHaveLength(2);
    });
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
        extractedValue: "Claude 3.5 Sonnet is a frontier large language model from Anthropic.",
        displayHint: "Claude 3.5 Sonnet",
        sourceUrl: "https://anthropic.com/news/claude-3-5",
      }),
    ]);
    expect(result.entity.products).toHaveLength(1);
    expect(result.entity.products![0]).toEqual({
      name: "Claude 3.5 Sonnet",
      description: "Claude 3.5 Sonnet is a frontier large language model from Anthropic.",
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
        extractedValue: "Claude 3.5 Sonnet is a much longer and more detailed description.",
        displayHint: "Claude 3.5 Sonnet",
      }),
    ]);
    expect(result.entity.products).toHaveLength(1);
    expect(result.entity.products![0].description).toBe(
      "Claude 3.5 Sonnet is a much longer and more detailed description.",
    );
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
      v({
        targetField: "product.p",
        extractedValue: "Shorter but it is a complete sentence about the product.",
      }),
    ]);
    expect(result.applied[0]).toMatchObject({ action: "skipped", reason: "existing description longer" });
  });

  it("strips leading ellipsis fragments from product descriptions (QUA-938)", () => {
    const entity: OrganizationEntity = { id: "x", type: "organization" };
    const result = applyVerdictsToOrganization(entity, [
      v({
        targetField: "product.claude",
        extractedValue: "...exemplified by Claude, a family of large language models built for safety.",
        displayHint: "Claude",
      }),
    ]);
    expect(result.entity.products).toHaveLength(1);
    expect(result.entity.products![0].description).toBe(
      "exemplified by Claude, a family of large language models built for safety.",
    );
    expect(result.applied[0].action).toBe("added");
  });

  it("collapses mid-text ellipses in product descriptions (QUA-938)", () => {
    const entity: OrganizationEntity = { id: "x", type: "organization" };
    const result = applyVerdictsToOrganization(entity, [
      v({
        targetField: "product.claude",
        extractedValue: "Claude is a family of models...trained for helpfulness, harmlessness, and honesty.",
        displayHint: "Claude",
      }),
    ]);
    expect(result.entity.products![0].description).toBe(
      "Claude is a family of models trained for helpfulness, harmlessness, and honesty.",
    );
  });

  it("skips product descriptions that are too thin (QUA-938)", () => {
    const entity: OrganizationEntity = { id: "x", type: "organization" };
    const result = applyVerdictsToOrganization(entity, [
      v({
        targetField: "product.claude",
        extractedValue: "Claude large-language model",
        displayHint: "Claude",
      }),
    ]);
    expect(result.entity.products ?? []).toHaveLength(0);
    expect(result.applied[0]).toMatchObject({
      action: "skipped",
      reason: "description too thin",
    });
  });

  it("skips product descriptions with no recognizable verb (QUA-938)", () => {
    const entity: OrganizationEntity = { id: "x", type: "organization" };
    const result = applyVerdictsToOrganization(entity, [
      v({
        targetField: "product.thing",
        extractedValue: "An overview of the company's flagship items and consumer solutions today.",
        displayHint: "Thing",
      }),
    ]);
    expect(result.entity.products ?? []).toHaveLength(0);
    expect(result.applied[0]).toMatchObject({
      action: "skipped",
      reason: "description too thin",
    });
  });

  it("trims overlong product descriptions to the first sentence (QUA-938)", () => {
    const entity: OrganizationEntity = { id: "x", type: "organization" };
    const longDesc =
      "Claude is a family of large language models from Anthropic designed for helpfulness, harmlessness, and honesty across many domains. " +
      "It was first released in 2023 and has since gone through several major versions. ".repeat(3);
    const result = applyVerdictsToOrganization(entity, [
      v({
        targetField: "product.claude",
        extractedValue: longDesc,
        displayHint: "Claude",
      }),
    ]);
    const desc = result.entity.products![0].description!;
    expect(desc.length).toBeLessThanOrEqual(300);
    expect(desc).toMatch(/^Claude is a family/);
    expect(desc).toMatch(/\.$/);
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

  it("adds keyDate when proposedValue is already a full ISO date", () => {
    const entity: OrganizationEntity = { id: "x", type: "organization" };
    const result = applyVerdictsToOrganization(entity, [
      v({
        targetField: "keyDate.claude-mars",
        proposedValue: "2026-01-30",
        displayHint: "Claude Assists NASA Mars Mission",
      }),
    ]);
    expect(result.entity.keyDates).toEqual([
      {
        date: "2026-01-30",
        description: "Claude Assists NASA Mars Mission",
        source: "https://example.com",
      },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("parses ISO date out of narrative proposedValue (QUA-937)", () => {
    const entity: OrganizationEntity = { id: "x", type: "organization" };
    const result = applyVerdictsToOrganization(entity, [
      v({
        targetField: "keyDate.claude-mars",
        proposedValue:
          "Claude on Mars - The first AI-assisted drive on another planet. Claude helped NASA's Perseverance rover travel four hundred meters on Mars. Date January 30, 2026",
        displayHint: "Claude Assists NASA Mars Mission",
      }),
    ]);
    expect(result.entity.keyDates).toEqual([
      {
        date: "2026-01-30",
        description: "Claude Assists NASA Mars Mission",
        source: "https://example.com",
      },
    ]);
  });

  it("falls back to YYYY-MM when only month-precision is present", () => {
    const entity: OrganizationEntity = { id: "x", type: "organization" };
    const result = applyVerdictsToOrganization(entity, [
      v({
        targetField: "keyDate.founded",
        proposedValue: "January 2021",
        displayHint: "Founded as Anthropic PBC",
      }),
    ]);
    expect(result.entity.keyDates).toEqual([
      {
        date: "2021-01",
        description: "Founded as Anthropic PBC",
        source: "https://example.com",
      },
    ]);
  });

  it("falls back to YYYY when only a bare year is present", () => {
    const entity: OrganizationEntity = { id: "x", type: "organization" };
    const result = applyVerdictsToOrganization(entity, [
      v({
        targetField: "keyDate.spinoff",
        proposedValue: "Spun out of OpenAI in 2021",
        displayHint: "Spun out of OpenAI",
      }),
    ]);
    expect(result.entity.keyDates).toEqual([
      {
        date: "2021",
        description: "Spun out of OpenAI",
        source: "https://example.com",
      },
    ]);
  });

  it("drops keyDate with no parseable date, warns, and emits skip reason", () => {
    const entity: OrganizationEntity = { id: "x", type: "organization" };
    const result = applyVerdictsToOrganization(entity, [
      v({
        targetField: "keyDate.unknown",
        proposedValue: "Claude assisted the rover",
        claimText: "narrative without any date",
        displayHint: "Mars Mission",
      }),
    ]);
    expect(result.entity.keyDates ?? []).toHaveLength(0);
    expect(result.applied[0]).toMatchObject({
      action: "skipped",
      reason: "no parseable date",
    });
    expect(result.warnings).toEqual([
      expect.stringContaining("keyDate.unknown"),
    ]);
  });

  it("skips keyDate when proposedValue and extractedValue are both null", () => {
    const entity: OrganizationEntity = { id: "x", type: "organization" };
    const result = applyVerdictsToOrganization(entity, [
      v({
        targetField: "keyDate.founded",
        extractedValue: null,
        proposedValue: null,
        claimText: "no dates anywhere here",
      }),
    ]);
    expect(result.entity.keyDates ?? []).toHaveLength(0);
    expect(result.applied[0]).toMatchObject({ action: "skipped", reason: "no parseable date" });
  });

  it("backfills empty date on existing keyDate entry with parseable proposedValue", () => {
    const entity: OrganizationEntity = {
      id: "x",
      type: "organization",
      keyDates: [{ date: "", description: "Founded as Anthropic PBC" }],
    };
    const result = applyVerdictsToOrganization(entity, [
      v({
        targetField: "keyDate.founded-as-anthropic-pbc",
        proposedValue: "2021-01-15",
        displayHint: "Founded as Anthropic PBC",
      }),
    ]);
    expect(result.entity.keyDates).toEqual([
      {
        date: "2021-01-15",
        description: "Founded as Anthropic PBC",
        source: "https://example.com",
      },
    ]);
    expect(result.applied[0]).toMatchObject({ action: "updated" });
  });

  it("warns when existing keyDate has no date AND new prose has no parseable date", () => {
    const entity: OrganizationEntity = {
      id: "x",
      type: "organization",
      keyDates: [
        { date: "", description: "Mars Mission", source: "https://existing.example.com" },
      ],
    };
    const result = applyVerdictsToOrganization(entity, [
      v({
        targetField: "keyDate.mars-mission",
        proposedValue: "Claude assisted the rover",
        displayHint: "Mars Mission",
        sourceUrl: "https://existing.example.com",
      }),
    ]);
    // Existing entry preserved unchanged (still has empty date, same source).
    expect(result.entity.keyDates).toEqual([
      { date: "", description: "Mars Mission", source: "https://existing.example.com" },
    ]);
    expect(result.applied[0]).toMatchObject({ action: "skipped", reason: "duplicate keyDate" });
    expect(result.warnings).toEqual([
      expect.stringContaining("keyDate.mars-mission"),
    ]);
  });

  it("backfills missing source on existing keyDate even when prose is unparseable", () => {
    // Source backfill is independent of date parseability — a verdict can
    // legitimately add provenance to an entry that already has a date but no
    // source recorded.
    const entity: OrganizationEntity = {
      id: "x",
      type: "organization",
      keyDates: [{ date: "2021-01", description: "Founded" }],
    };
    const result = applyVerdictsToOrganization(entity, [
      v({
        targetField: "keyDate.founded",
        proposedValue: "Founded sometime in the past", // unparseable date
        displayHint: "Founded",
      }),
    ]);
    expect(result.entity.keyDates).toEqual([
      { date: "2021-01", description: "Founded", source: "https://example.com" },
    ]);
    expect(result.applied[0]).toMatchObject({ action: "updated" });
    // No warning — existing entry already had a good date.
    expect(result.warnings).toEqual([]);
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
        extractedValue: "Claude 3.5 Sonnet is a newer model from Anthropic.",
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

// ─── stakeholder position classification (QUA-875) ─────────────────────────

const baseEntity: PolicyEntity = {
  id: "fisa-702",
  type: "policy",
  title: "FISA Section 702",
  stakeholders: [],
};

function verdict(overrides: Partial<VerifiedVerdict>): VerifiedVerdict {
  return {
    targetField: "stakeholder.american-civil-liberties-union",
    claimText: "ACLU has sued the NSA over 702 surveillance.",
    extractedValue: null,
    proposedValue: "ACLU has challenged 702 surveillance in federal court.",
    sourceUrl: "https://example.com/aclu-702",
    status: "verified",
    displayHint: "American Civil Liberties Union",
    ...overrides,
  };
}

describe("applyVerdictsToPolicy — stakeholder positions", () => {
  it("applies the extractor's confident position to a new stakeholder", () => {
    const result = applyVerdictsToPolicy(baseEntity, [
      verdict({ position: "oppose", positionConfidence: 0.9 }),
    ]);
    expect(result.applied).toEqual([
      { targetField: "stakeholder.american-civil-liberties-union", action: "added" },
    ]);
    expect(result.entity.stakeholders).toHaveLength(1);
    const sh = result.entity.stakeholders![0];
    expect(sh.name).toBe("American Civil Liberties Union");
    expect(sh.position).toBe("oppose");
    expect(sh.importance).toBe("medium");
    expect(sh.reason).toBe("ACLU has challenged 702 surveillance in federal court.");
  });

  it("omits position entirely when extractor returns null (no 'reform' default)", () => {
    const result = applyVerdictsToPolicy(baseEntity, [
      verdict({ position: null, positionConfidence: null }),
    ]);
    expect(result.entity.stakeholders).toHaveLength(1);
    const sh = result.entity.stakeholders![0];
    expect(sh.name).toBe("American Civil Liberties Union");
    // Critical: no fallback to "reform". The previous behavior was to set
    // position: "reform" when unknown, which produced obviously-wrong values
    // (NSA marked "reform"). After QUA-875 we leave it unset.
    expect(sh.position).toBeUndefined();
    expect("position" in sh).toBe(false);
    expect(sh.reason).toBe("ACLU has challenged 702 surveillance in federal court.");
  });

  it("treats below-threshold confidence as no opinion (omits position)", () => {
    const result = applyVerdictsToPolicy(baseEntity, [
      verdict({ position: "oppose", positionConfidence: 0.3 }),
    ]);
    const sh = result.entity.stakeholders![0];
    expect(sh.position).toBeUndefined();
    expect("position" in sh).toBe(false);
  });

  it("applies position at exactly the threshold", () => {
    const result = applyVerdictsToPolicy(baseEntity, [
      verdict({ position: "support", positionConfidence: MIN_POSITION_CONFIDENCE }),
    ]);
    const sh = result.entity.stakeholders![0];
    expect(sh.position).toBe("support");
  });

  it("uses extractor's value over any prior default — extractor is single source of truth", () => {
    // Acceptance criterion 3: "position mismatched between extractor and apply-step
    // → take extractor's value". The legacy code unconditionally wrote "reform";
    // the new code writes whatever the extractor (with confidence) classified,
    // even when that classification differs from the old hardcoded default.
    const cases: Array<{ pos: "support" | "oppose" | "reform" | "neutral"; expected: string }> = [
      { pos: "support", expected: "support" },
      { pos: "oppose", expected: "oppose" },
      { pos: "neutral", expected: "neutral" },
      { pos: "reform", expected: "reform" },
    ];
    for (const c of cases) {
      const result = applyVerdictsToPolicy(baseEntity, [
        verdict({
          targetField: `stakeholder.test-${c.pos}`,
          displayHint: `Test ${c.pos}`,
          position: c.pos,
          positionConfidence: 0.9,
        }),
      ]);
      const sh = result.entity.stakeholders![0];
      expect(sh.position).toBe(c.expected);
    }
  });

  it("backfills position on an existing stakeholder that has no position set", () => {
    const seeded: PolicyEntity = {
      ...baseEntity,
      stakeholders: [
        {
          name: "American Civil Liberties Union",
          importance: "medium",
          reason: "short",
        },
      ],
    };
    const result = applyVerdictsToPolicy(seeded, [
      verdict({ position: "oppose", positionConfidence: 0.9 }),
    ]);
    expect(result.entity.stakeholders).toHaveLength(1);
    const sh = result.entity.stakeholders![0];
    expect(sh.position).toBe("oppose");
    // The reason was shorter than the new value, so it gets updated.
    expect(sh.reason).toBe("ACLU has challenged 702 surveillance in federal court.");
  });

  it("backfills position even when existing reason is LONGER than new value", () => {
    // QUA-875 hostile-review HIGH #1: position backfill must not be gated on
    // reason replacement. If the existing reason is longer, we skip the reason
    // update — but a missing position should still be filled in when the
    // extractor is confident. Otherwise high-confidence positions are silently
    // discarded for any stakeholder that already has a thorough description.
    const seeded: PolicyEntity = {
      ...baseEntity,
      stakeholders: [
        {
          name: "American Civil Liberties Union",
          importance: "medium",
          reason:
            "A long, detailed, human-curated reason that exceeds anything the new verdict will say. Lots of context, history, and references. Already comprehensive and not in need of replacement.",
          // No position field — eligible for backfill.
        },
      ],
    };
    const result = applyVerdictsToPolicy(seeded, [
      verdict({ position: "oppose", positionConfidence: 0.9 }),
    ]);
    const sh = result.entity.stakeholders![0];
    // Reason is preserved (it was longer)
    expect(sh.reason).toMatch(/^A long, detailed/);
    // Position IS backfilled even though reason wasn't replaced
    expect(sh.position).toBe("oppose");
  });

  it("does NOT overwrite a curated position with a less-confident guess", () => {
    const seeded: PolicyEntity = {
      ...baseEntity,
      stakeholders: [
        {
          name: "American Civil Liberties Union",
          position: "oppose", // Human-curated
          importance: "medium",
          reason: "short",
        },
      ],
    };
    // Even with high confidence, the existing position wins. The apply step
    // never overwrites a position field that was already set.
    const result = applyVerdictsToPolicy(seeded, [
      verdict({ position: "support", positionConfidence: 0.95 }),
    ]);
    const sh = result.entity.stakeholders![0];
    expect(sh.position).toBe("oppose");
  });

  it("does not write position on existing stakeholder when extractor is below threshold", () => {
    const seeded: PolicyEntity = {
      ...baseEntity,
      stakeholders: [
        {
          name: "American Civil Liberties Union",
          importance: "medium",
          reason: "short",
        },
      ],
    };
    const result = applyVerdictsToPolicy(seeded, [
      verdict({ position: "oppose", positionConfidence: 0.4 }),
    ]);
    const sh = result.entity.stakeholders![0];
    expect(sh.position).toBeUndefined();
  });

  it("ignores position fields on non-stakeholder verdicts", () => {
    // Defense-in-depth: even if position somehow leaks onto a provision verdict,
    // it must not affect the provision branch.
    const result = applyVerdictsToPolicy(baseEntity, [
      verdict({
        targetField: "provision.targeting-non-us-persons",
        displayHint: "Targeting Non-US Persons",
        proposedValue: "Authorizes targeting non-US persons abroad.",
        position: "oppose",
        positionConfidence: 0.9,
      }),
    ]);
    expect(result.entity.provisions).toHaveLength(1);
    expect(result.entity.stakeholders).toEqual([]);
    const prov = result.entity.provisions![0];
    expect(prov.title).toBe("Targeting Non-US Persons");
    // Provisions don't have a position field; this is just a sanity check.
    expect("position" in prov).toBe(false);
  });

  it("only applies verdicts with verified or partial status", () => {
    const result = applyVerdictsToPolicy(baseEntity, [
      verdict({ status: "contradicted", position: "oppose", positionConfidence: 0.9 }),
      verdict({ status: "unverifiable", position: "support", positionConfidence: 0.9 }),
    ]);
    expect(result.entity.stakeholders).toEqual([]);
    expect(result.applied).toEqual([]);
  });

  it("handles partial verdicts the same as verified", () => {
    const result = applyVerdictsToPolicy(baseEntity, [
      verdict({ status: "partial", position: "oppose", positionConfidence: 0.9 }),
    ]);
    const sh = result.entity.stakeholders![0];
    expect(sh.position).toBe("oppose");
  });

  it("preserves stakeholder order across multiple verdicts", () => {
    const result = applyVerdictsToPolicy(baseEntity, [
      verdict({
        targetField: "stakeholder.nsa",
        displayHint: "National Security Agency",
        position: "support",
        positionConfidence: 0.9,
      }),
      verdict({
        targetField: "stakeholder.american-civil-liberties-union",
        displayHint: "ACLU",
        position: "oppose",
        positionConfidence: 0.9,
      }),
    ]);
    expect(result.entity.stakeholders!.map((s) => s.position)).toEqual(["support", "oppose"]);
  });
});
