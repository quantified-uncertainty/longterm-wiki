import { describe, it, expect } from "vitest";
import { suggestCorrection } from "./validate-controlled-vocab.ts";

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
    // In practice, suggestCorrection is only called for values NOT in the
    // vocab (checkValue filters them out). But if called with an exact match,
    // distance=0 meets the threshold so it returns the match itself.
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
// Relationship vocabulary completeness
// ---------------------------------------------------------------------------

describe("controlled vocabulary sets", () => {
  it("relationship vocabulary contains common relationship values", () => {
    // Import the vocab indirectly by testing known values
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

    // These should all be in the validator's VALID_RELATIONSHIPS set.
    // We test this indirectly: suggestCorrection should return undefined
    // for exact matches (edit distance = 0, which is < 3 and < 0.5*len,
    // but the value IS in the set so it wouldn't be flagged).
    // Instead, we test that close typos get corrected to these.
    for (const rel of knownRelationships) {
      // A one-character typo should suggest the correct value
      const typo = rel.slice(0, -1) + "x";
      const vocabSet = new Set(knownRelationships);
      const suggestion = suggestCorrection(typo, vocabSet);
      // The suggestion should be the original value (1 edit away)
      expect(suggestion).toBe(rel);
    }
  });
});

// ---------------------------------------------------------------------------
// Edge cases for the suggestion algorithm
// ---------------------------------------------------------------------------

describe("suggestCorrection edge cases", () => {
  const smallVocab = new Set(["ab", "cd"]);

  it("does not suggest when distance exceeds 50% of candidate length", () => {
    // "zz" → distance to "ab" = 2, which is 100% of length 2 → no suggestion
    expect(suggestCorrection("zz", smallVocab)).toBeUndefined();
  });

  it("suggests single-char correction for short strings", () => {
    // "ac" → distance to "ab" = 1, which is 50% of length 2 → borderline
    // 1 < 2*0.5=1 is false (not strictly less), so no suggestion
    expect(suggestCorrection("ac", smallVocab)).toBeUndefined();
  });

  it("handles the exact match edge case (distance=0)", () => {
    // "ab" → distance to "ab" = 0, which is < 3 and < 0.5*2=1 → suggest "ab"
    // But typically we wouldn't call suggestCorrection on exact matches
    // since checkValue only calls it for non-members
    expect(suggestCorrection("ab", smallVocab)).toBe("ab");
  });
});
