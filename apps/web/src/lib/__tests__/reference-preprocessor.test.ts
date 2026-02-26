import { describe, it, expect } from "vitest";
import {
  preprocessReferences,
  emptyReferenceData,
  type ReferenceData,
  type ClaimRefData,
  type CitationData,
} from "../reference-preprocessor";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReferenceData(
  claims: Record<string, ClaimRefData> = {},
  citations: Record<string, CitationData> = {}
): ReferenceData {
  return {
    claimReferences: new Map(Object.entries(claims)),
    citations: new Map(Object.entries(citations)),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("preprocessReferences", () => {
  // -----------------------------------------------------------------------
  // Pass-through behaviour
  // -----------------------------------------------------------------------

  it("returns content unchanged when there are no references at all", () => {
    const content = "# Title\n\nSome paragraph without any footnotes.";
    const { content: result, referenceMap } = preprocessReferences(
      content,
      emptyReferenceData()
    );
    expect(result).toBe(content);
    expect(referenceMap.size).toBe(0);
  });

  it("returns content unchanged when there are only legacy [^N] footnotes", () => {
    const content = [
      "This has a footnote[^1] and another[^2].",
      "",
      "[^1]: First source",
      "[^2]: Second source",
    ].join("\n");
    const { content: result, referenceMap } = preprocessReferences(
      content,
      emptyReferenceData()
    );
    expect(result).toBe(content);
    expect(referenceMap.size).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Claim references
  // -----------------------------------------------------------------------

  it("injects definitions for [^cr-XXXX] claim references", () => {
    const content = "Some claim[^cr-3d34] in the text.";
    const refData = makeReferenceData({
      "cr-3d34": {
        claimId: 42,
        claimText: "AI will transform industries",
        sourceUrl: "https://example.com/paper",
        sourceTitle: "AI Report 2025",
        verdict: "supported",
        verdictScore: 0.8,
      },
    });

    const { content: result, referenceMap } = preprocessReferences(content, refData);

    // Should replace [^cr-3d34] with [^1]
    expect(result).toContain("Some claim[^1] in the text.");
    // Should append footnote definition
    expect(result).toContain('[^1]: [AI Report 2025](https://example.com/paper)');
    expect(result).toContain('"AI will transform industries"');
    expect(result).toContain("(supported)");

    // referenceMap should have the entry
    expect(referenceMap.size).toBe(1);
    const entry = referenceMap.get(1);
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe("claim");
    expect(entry!.originalId).toBe("cr-3d34");
    expect(entry!.footnoteNumber).toBe(1);
    expect(entry!.data).toEqual(refData.claimReferences.get("cr-3d34"));
  });

  // -----------------------------------------------------------------------
  // Citation references
  // -----------------------------------------------------------------------

  it("injects definitions for [^rc-XXXX] citation references", () => {
    const content = "A cited fact[^rc-4552] here.";
    const refData = makeReferenceData(
      {},
      {
        "rc-4552": {
          title: "Nature Paper",
          url: "https://nature.com/paper",
          note: "Section 3",
          resourceId: "nature-paper-2025",
        },
      }
    );

    const { content: result, referenceMap } = preprocessReferences(content, refData);

    expect(result).toContain("A cited fact[^1] here.");
    expect(result).toContain("[^1]: [Nature Paper](https://nature.com/paper) — Section 3");

    const entry = referenceMap.get(1);
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe("citation");
    expect(entry!.originalId).toBe("rc-4552");
  });

  it("handles citation with only URL (no title)", () => {
    const content = "Fact[^rc-abc1].";
    const refData = makeReferenceData(
      {},
      { "rc-abc1": { url: "https://example.com/doc" } }
    );

    const { content: result } = preprocessReferences(content, refData);
    expect(result).toContain("[^1]: [https://example.com/doc](https://example.com/doc)");
  });

  it("handles citation with only title (no URL)", () => {
    const content = "Fact[^rc-abc2].";
    const refData = makeReferenceData(
      {},
      { "rc-abc2": { title: "Important Report", note: "Page 5" } }
    );

    const { content: result } = preprocessReferences(content, refData);
    expect(result).toContain("[^1]: Important Report — Page 5");
  });

  it("handles citation with only a note", () => {
    const content = "Fact[^rc-abc3].";
    const refData = makeReferenceData(
      {},
      { "rc-abc3": { note: "Personal communication" } }
    );

    const { content: result } = preprocessReferences(content, refData);
    expect(result).toContain("[^1]: Personal communication");
  });

  it("handles citation with no fields at all", () => {
    const content = "Fact[^rc-abc4].";
    const refData = makeReferenceData({}, { "rc-abc4": {} });

    const { content: result } = preprocessReferences(content, refData);
    expect(result).toContain("[^1]: Citation");
  });

  // -----------------------------------------------------------------------
  // Mixed old + new footnotes
  // -----------------------------------------------------------------------

  it("numbers new references after existing legacy footnotes", () => {
    const content = [
      "Legacy footnote[^1] and a claim[^cr-aa11] and citation[^rc-bb22].",
      "",
      "[^1]: Existing legacy source",
    ].join("\n");

    const refData = makeReferenceData(
      {
        "cr-aa11": {
          claimId: 1,
          claimText: "Claim A",
          sourceTitle: "Source A",
        },
      },
      {
        "rc-bb22": {
          title: "Source B",
          url: "https://example.com/b",
        },
      }
    );

    const { content: result, referenceMap } = preprocessReferences(content, refData);

    // Legacy [^1] should remain untouched
    expect(result).toContain("Legacy footnote[^1]");
    expect(result).toContain("[^1]: Existing legacy source");

    // New references should start at [^2] — old markers are gone
    expect(result).not.toContain("[^cr-aa11]");
    expect(result).not.toContain("[^rc-bb22]");

    // cr-aa11 sorts before rc-bb22 alphabetically
    expect(result).toContain("[^2]:");
    expect(result).toContain("[^3]:");

    expect(referenceMap.size).toBe(2);
    expect(referenceMap.get(2)?.originalId).toBe("cr-aa11");
    expect(referenceMap.get(3)?.originalId).toBe("rc-bb22");
  });

  it("handles legacy footnotes with gaps (e.g. [^1], [^5])", () => {
    const content = [
      "First[^1] then fifth[^5] then new[^cr-zz99].",
      "",
      "[^1]: Source 1",
      "[^5]: Source 5",
    ].join("\n");

    const refData = makeReferenceData({
      "cr-zz99": { claimId: 99, claimText: "New claim" },
    });

    const { content: result, referenceMap } = preprocessReferences(content, refData);

    // New reference should start at [^6] (highest existing is 5)
    expect(result).toContain("new[^6]");
    expect(referenceMap.get(6)?.originalId).toBe("cr-zz99");
  });

  // -----------------------------------------------------------------------
  // Sequential / deterministic numbering
  // -----------------------------------------------------------------------

  it("assigns numbers in sorted order of reference IDs", () => {
    // Insert references in reverse alphabetical order to test sorting
    const content = "Z[^rc-zzz] A[^cr-aaa] M[^rc-mmm].";
    const refData = makeReferenceData(
      { "cr-aaa": { claimId: 1, claimText: "A" } },
      {
        "rc-mmm": { title: "M" },
        "rc-zzz": { title: "Z" },
      }
    );

    const { referenceMap } = preprocessReferences(content, refData);

    // Sorted: cr-aaa < rc-mmm < rc-zzz
    expect(referenceMap.get(1)?.originalId).toBe("cr-aaa");
    expect(referenceMap.get(2)?.originalId).toBe("rc-mmm");
    expect(referenceMap.get(3)?.originalId).toBe("rc-zzz");
  });

  it("is deterministic — same input produces same output", () => {
    const content = "A[^cr-bb] B[^rc-aa].";
    const refData = makeReferenceData(
      { "cr-bb": { claimId: 2, claimText: "B" } },
      { "rc-aa": { title: "A" } }
    );

    const result1 = preprocessReferences(content, refData);
    const result2 = preprocessReferences(content, refData);

    expect(result1.content).toBe(result2.content);
    expect(Array.from(result1.referenceMap.entries())).toEqual(
      Array.from(result2.referenceMap.entries())
    );
  });

  // -----------------------------------------------------------------------
  // Multiple usages of the same reference
  // -----------------------------------------------------------------------

  it("handles the same reference ID used multiple times", () => {
    const content = "First[^cr-x1] and again[^cr-x1].";
    const refData = makeReferenceData({
      "cr-x1": { claimId: 1, claimText: "Shared claim", sourceTitle: "Paper" },
    });

    const { content: result, referenceMap } = preprocessReferences(content, refData);

    // Both should get the same number
    expect(result).toContain("First[^1] and again[^1].");
    // Only one definition
    const defCount = (result.match(/\[\^1\]:/g) || []).length;
    expect(defCount).toBe(1);
    expect(referenceMap.size).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Missing reference data
  // -----------------------------------------------------------------------

  it("handles missing claim reference data gracefully", () => {
    const content = "Unknown claim[^cr-missing].";
    // Reference data has no entry for cr-missing
    const refData = emptyReferenceData();

    const { content: result, referenceMap } = preprocessReferences(content, refData);

    expect(result).toContain("[^1]: Claim reference cr-missing (data unavailable)");
    expect(referenceMap.get(1)?.data).toBeNull();
    expect(referenceMap.get(1)?.kind).toBe("claim");
  });

  it("handles missing citation reference data gracefully", () => {
    const content = "Unknown cite[^rc-missing].";
    const refData = emptyReferenceData();

    const { content: result, referenceMap } = preprocessReferences(content, refData);

    expect(result).toContain("[^1]: Citation rc-missing (data unavailable)");
    expect(referenceMap.get(1)?.data).toBeNull();
    expect(referenceMap.get(1)?.kind).toBe("citation");
  });

  // -----------------------------------------------------------------------
  // Claim footnote formatting
  // -----------------------------------------------------------------------

  it("truncates long claim text at 200 characters", () => {
    const longText = "A".repeat(250);
    const content = "Claim[^cr-long1].";
    const refData = makeReferenceData({
      "cr-long1": { claimId: 1, claimText: longText },
    });

    const { content: result } = preprocessReferences(content, refData);

    // Should contain truncated text with ellipsis
    expect(result).toContain("A".repeat(197) + "...");
    expect(result).not.toContain("A".repeat(250));
  });

  it("builds claim footnote with source URL only (no title)", () => {
    const content = "Claim[^cr-url1].";
    const refData = makeReferenceData({
      "cr-url1": {
        claimId: 1,
        claimText: "The claim",
        sourceUrl: "https://example.com/source",
      },
    });

    const { content: result } = preprocessReferences(content, refData);
    expect(result).toContain("[Source](https://example.com/source)");
  });

  it("builds claim footnote with no source at all", () => {
    const content = "Claim[^cr-nosrc].";
    const refData = makeReferenceData({
      "cr-nosrc": {
        claimId: 1,
        claimText: "Just a claim",
      },
    });

    const { content: result } = preprocessReferences(content, refData);
    expect(result).toContain('"Just a claim"');
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  it("does not match definition-like patterns [^cr-XXXX]: in content", () => {
    // If someone manually wrote a definition (unusual), we should not double-process it.
    // The regex only matches usage sites [^cr-XXXX] not followed by ":"
    const content = "Use[^cr-def1] here.\n\n[^cr-def1]: Manual definition.";
    const refData = makeReferenceData({
      "cr-def1": { claimId: 1, claimText: "DB Claim" },
    });

    const { content: result } = preprocessReferences(content, refData);

    // The usage [^cr-def1] gets replaced with [^1]
    expect(result).toContain("Use[^1] here.");
    // The DB definition should be appended
    expect(result).toContain('[^1]: "DB Claim"');
    // The original manual definition still has [^cr-def1]: in it
    // (it won't be matched by the usage regex since it has trailing `:`)
    // NOTE: This is a known edge case - manual definitions for DB refs are not expected
  });

  it("handles empty content", () => {
    const { content, referenceMap } = preprocessReferences(
      "",
      emptyReferenceData()
    );
    expect(content).toBe("");
    expect(referenceMap.size).toBe(0);
  });

  it("handles content with only whitespace", () => {
    const { content, referenceMap } = preprocessReferences(
      "   \n\n  ",
      emptyReferenceData()
    );
    expect(content).toBe("   \n\n  ");
    expect(referenceMap.size).toBe(0);
  });

  it("preserves trailing newline structure", () => {
    const content = "Text[^cr-t1].\n";
    const refData = makeReferenceData({
      "cr-t1": { claimId: 1, claimText: "Test" },
    });

    const { content: result } = preprocessReferences(content, refData);

    // Should end with the footnote definition followed by a newline
    expect(result).toMatch(/\[\^1\]:.*\n$/);
    // Should have a blank line before footnote definitions
    expect(result).toContain("\n\n[^1]:");
  });
});

describe("emptyReferenceData", () => {
  it("returns empty maps", () => {
    const data = emptyReferenceData();
    expect(data.claimReferences.size).toBe(0);
    expect(data.citations.size).toBe(0);
  });
});
