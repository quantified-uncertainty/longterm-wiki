import { describe, it, expect } from "vitest";
import { decide, preFilterBatch, extractKeyTokens, type PreFilterClaim } from "../pre-filter.ts";

describe("extractKeyTokens", () => {
  it("extracts 4-digit years, long acronyms, and capitalized phrases", () => {
    const tokens = extractKeyTokens("In 2008 the FISA Amendments Act passed.");
    expect(tokens).toContain("2008");
    expect(tokens).toContain("FISA");
    // 3-char acronyms like NSA are dropped (MIN_TOKEN_LEN=4); that's by design.
    expect(tokens).toContain("Amendments Act");
  });
});

describe("decide — base behavior", () => {
  const claim: PreFilterClaim = {
    claimText: "The FISA Amendments Act of 2008 codified Section 702.",
    proposedValue: null,
    resourceId: "r1",
    sourceUrl: "https://example.com/1",
  };

  it("keeps claims whose tokens hit the source content", () => {
    const dec = decide(claim, "FISA Amendments Act of 2008 ...");
    expect(dec.keep).toBe(true);
    expect(dec.hits.length).toBeGreaterThan(0);
  });

  it("drops claims whose tokens are absent from source", () => {
    const dec = decide(claim, "Some unrelated content about agriculture.");
    expect(dec.keep).toBe(false);
    expect(dec.missing.length).toBeGreaterThan(0);
  });

  it("keeps claims with no extractable tokens (no signal either way)", () => {
    const noToken: PreFilterClaim = {
      claimText: "the law is broad in scope",
      resourceId: "r1",
      sourceUrl: "https://example.com/1",
    };
    const dec = decide(noToken, "anything goes here");
    expect(dec.keep).toBe(true);
    expect(dec.tokens).toEqual([]);
  });
});

describe("decide — requiredPatterns (QUA-875 position-stem check)", () => {
  it("drops a stakeholder claim when the position stem is absent from source", () => {
    const claim: PreFilterClaim = {
      claimText: "ACLU opposes 702 surveillance.",
      resourceId: "r1",
      sourceUrl: "https://example.com/1",
      requiredPatterns: ["\\boppos"],
    };
    // Source mentions ACLU but never uses "oppose" / "opposes" / "opposition".
    const source = "The ACLU has filed multiple lawsuits regarding Section 702 surveillance practices.";
    const dec = decide(claim, source);
    expect(dec.keep).toBe(false);
    expect(dec.missingRequired).toEqual(["\\boppos"]);
    expect(dec.missing).toContain("\\boppos");
  });

  it("keeps a stakeholder claim when the position stem appears in source", () => {
    const claim: PreFilterClaim = {
      claimText: "ACLU opposes 702 surveillance.",
      resourceId: "r1",
      sourceUrl: "https://example.com/1",
      requiredPatterns: ["\\boppos"],
    };
    const source = "The ACLU strongly opposes the renewal of FISA Section 702.";
    const dec = decide(claim, source);
    expect(dec.keep).toBe(true);
    expect(dec.missingRequired).toEqual([]);
  });

  it("matches stems case-insensitively", () => {
    const claim: PreFilterClaim = {
      claimText: "Group supports the law.",
      resourceId: "r1",
      sourceUrl: "https://example.com/1",
      requiredPatterns: ["\\bsupport"],
    };
    const source = "The Group SUPPORTED renewal in 2024.";
    const dec = decide(claim, source);
    expect(dec.keep).toBe(true);
  });

  it("uses word boundaries to avoid false positives (neutralize ≠ neutral)", () => {
    // Hostile-review MEDIUM #3: a security article saying "the program seeks
    // to neutralize threats" should NOT satisfy a "neutral" position
    // requirement.
    const claim: PreFilterClaim = {
      claimText: "The agency is neutral on the bill.",
      resourceId: "r1",
      sourceUrl: "https://example.com/1",
      requiredPatterns: ["\\bneutral\\b"],
    };
    const source = "The program seeks to neutralize threats and neutralized prior attacks.";
    const dec = decide(claim, source);
    expect(dec.keep).toBe(false);
    expect(dec.missingRequired).toContain("\\bneutral\\b");
  });

  it("matches whole-word neutral when present", () => {
    const claim: PreFilterClaim = {
      claimText: "The agency is neutral on the bill.",
      resourceId: "r1",
      sourceUrl: "https://example.com/1",
      requiredPatterns: ["\\bneutral\\b"],
    };
    const source = "The agency took a neutral stance.";
    const dec = decide(claim, source);
    expect(dec.keep).toBe(true);
  });

  it("treats invalid regex source as missing (fail-closed)", () => {
    const claim: PreFilterClaim = {
      claimText: "ACLU opposes the law.",
      resourceId: "r1",
      sourceUrl: "https://example.com/1",
      requiredPatterns: ["[unclosed"],
    };
    const source = "The ACLU strongly opposes the law.";
    const dec = decide(claim, source);
    expect(dec.keep).toBe(false);
    expect(dec.missingRequired).toEqual(["[unclosed"]);
  });

  it("requires ALL requiredPatterns to be present (drops if any missing)", () => {
    const claim: PreFilterClaim = {
      claimText: "Group A and Group B both opposed.",
      resourceId: "r1",
      sourceUrl: "https://example.com/1",
      requiredPatterns: ["\\bgroup a\\b", "missing-stem"],
    };
    const source = "Group A opposed the bill.";
    const dec = decide(claim, source);
    expect(dec.keep).toBe(false);
    expect(dec.missingRequired).toEqual(["missing-stem"]);
  });

  it("drops on missing required token even when other tokens hit", () => {
    // The base token check passes (year 2008 present) but the required
    // stem is missing — required is a hard gate.
    const claim: PreFilterClaim = {
      claimText: "ACLU opposes the 2008 FISA Amendments.",
      resourceId: "r1",
      sourceUrl: "https://example.com/1",
      requiredPatterns: ["\\boppos"],
    };
    const source = "The 2008 FISA Amendments Act addressed surveillance issues.";
    const dec = decide(claim, source);
    expect(dec.keep).toBe(false);
  });

  it("keeps a no-token claim when its required pattern is present", () => {
    const claim: PreFilterClaim = {
      claimText: "the group supports it",
      resourceId: "r1",
      sourceUrl: "https://example.com/1",
      requiredPatterns: ["\\bsupport"],
    };
    const source = "the group supports the new law";
    const dec = decide(claim, source);
    expect(dec.keep).toBe(true);
  });
});

describe("preFilterBatch", () => {
  it("includes missingRequired on per-claim decisions", () => {
    const claims: PreFilterClaim[] = [
      {
        claimText: "ACLU opposes the law.",
        resourceId: "u1",
        sourceUrl: "u1",
        requiredPatterns: ["\\boppos"],
      },
    ];
    const content = new Map([["u1", "ACLU has commented on the law."]]);
    const result = preFilterBatch(claims, content);
    expect(result.kept).toEqual([]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].missingRequired).toEqual(["\\boppos"]);
  });

  it("drops position-bearing claims with no source content (defensive)", () => {
    // Hostile-review MEDIUM #2: a claim that ASKED for a position-stem check
    // is uniquely susceptible to fabrication. If we can't verify the source
    // content, downstream can't either — drop instead of letting through.
    const claims: PreFilterClaim[] = [
      {
        claimText: "Some position-bearing claim.",
        resourceId: "missing-url",
        sourceUrl: "missing-url",
        requiredPatterns: ["\\boppos"],
      },
    ];
    const content = new Map<string, string>(); // empty
    const result = preFilterBatch(claims, content);
    expect(result.kept).toEqual([]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].missingRequired).toEqual(["\\boppos"]);
  });

  it("keeps claims without requiredPatterns when source content is missing", () => {
    // Existing behavior: claims that don't ask for a hard match (the
    // common case for non-stakeholder claims) still pass through to the
    // verifier when the source content is unavailable.
    const claims: PreFilterClaim[] = [
      {
        claimText: "Some ordinary claim.",
        resourceId: "missing-url",
        sourceUrl: "missing-url",
      },
    ];
    const content = new Map<string, string>();
    const result = preFilterBatch(claims, content);
    expect(result.kept).toHaveLength(1);
    expect(result.dropped).toEqual([]);
  });
});
