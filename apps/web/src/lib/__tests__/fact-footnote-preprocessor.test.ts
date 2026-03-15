import { describe, it, expect } from "vitest";
import {
  preprocessFactFootnotes,
  buildFactFootnoteDefinition,
  escapeMarkdownInQuote,
  type FactLookupFn,
} from "../fact-footnote-preprocessor";
import type { Fact } from "@longterm-wiki/factbase";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFact(overrides: Partial<Fact> & { id: string }): Fact {
  return {
    subjectId: "test-entity",
    propertyId: "test-property",
    value: { type: "text", value: "test" },
    ...overrides,
  };
}

function makeLookup(facts: Record<string, Fact>): FactLookupFn {
  return (factId: string) => facts[factId];
}

const emptyLookup: FactLookupFn = () => undefined;

// ---------------------------------------------------------------------------
// Tests: preprocessFactFootnotes
// ---------------------------------------------------------------------------

describe("preprocessFactFootnotes", () => {
  it("replaces [^fact:ID] with [^fact-ID] and appends footnote definition with full metadata", () => {
    const content = "Revenue was \\$1B[^fact:f_i59sRXPSZw] in 2024.";
    const lookup = makeLookup({
      f_i59sRXPSZw: makeFact({
        id: "f_i59sRXPSZw",
        propertyId: "revenue",
        value: { type: "number", value: 1000000000 },
        source: "https://example.com/report",
        sourceQuote: "Anthropic reported revenue of $1B",
        asOf: "2024-12",
        notes: "Annual revenue figure",
      }),
    });

    const result = preprocessFactFootnotes(content, lookup);

    // Reference should be converted from colon to hyphen
    expect(result.content).toContain("Revenue was \\$1B[^fact-f_i59sRXPSZw] in 2024.");
    expect(result.content).not.toContain("[^fact:f_i59sRXPSZw]");

    // Footnote definition should include all metadata
    expect(result.content).toContain("[^fact-f_i59sRXPSZw]:");
    expect(result.content).toContain("[Source](https://example.com/report)");
    expect(result.content).toContain('*"Anthropic reported revenue of $1B"*');
    expect(result.content).toContain("(as of 2024-12)");
    expect(result.content).toContain("Annual revenue figure");

    expect(result.resolvedFactIds.has("f_i59sRXPSZw")).toBe(true);
    expect(result.unresolvedFactIds.size).toBe(0);
  });

  it("handles fact with only source URL (no quote, no asOf, no notes)", () => {
    const content = "Fact[^fact:f_simple].";
    const lookup = makeLookup({
      f_simple: makeFact({
        id: "f_simple",
        source: "https://example.com/data",
      }),
    });

    const result = preprocessFactFootnotes(content, lookup);

    expect(result.content).toContain("[^fact-f_simple]: [Source](https://example.com/data)");
    expect(result.content).not.toContain("as of");
    expect(result.content).not.toContain('*"');
    expect(result.resolvedFactIds.has("f_simple")).toBe(true);
  });

  it("handles fact with no source at all (generates fallback with available metadata)", () => {
    const content = "Value[^fact:f_nosource].";
    const lookup = makeLookup({
      f_nosource: makeFact({
        id: "f_nosource",
        asOf: "2025-01",
        notes: "Estimated figure",
      }),
    });

    const result = preprocessFactFootnotes(content, lookup);

    expect(result.content).toContain("[^fact-f_nosource]:");
    expect(result.content).toContain("(as of 2025-01)");
    expect(result.content).toContain("Estimated figure");
    expect(result.content).not.toContain("[Source]");
    expect(result.resolvedFactIds.has("f_nosource")).toBe(true);
  });

  it("handles fact with no metadata at all (generates fallback text)", () => {
    const content = "Value[^fact:f_empty].";
    const lookup = makeLookup({
      f_empty: makeFact({
        id: "f_empty",
      }),
    });

    const result = preprocessFactFootnotes(content, lookup);

    expect(result.content).toContain("[^fact-f_empty]: KB fact f_empty");
    expect(result.resolvedFactIds.has("f_empty")).toBe(true);
  });

  it("handles multiple fact footnotes in one document", () => {
    const content = [
      "Revenue was \\$1B[^fact:f_rev] in 2024.",
      "Headcount reached 1,000[^fact:f_hc] employees.",
      "Valuation hit \\$10B[^fact:f_val].",
    ].join("\n");

    const lookup = makeLookup({
      f_rev: makeFact({
        id: "f_rev",
        source: "https://example.com/rev",
        asOf: "2024-12",
      }),
      f_hc: makeFact({
        id: "f_hc",
        source: "https://example.com/hc",
        notes: "Approximate headcount",
      }),
      f_val: makeFact({
        id: "f_val",
        sourceQuote: "Valued at $10B",
        asOf: "2024-06",
      }),
    });

    const result = preprocessFactFootnotes(content, lookup);

    // All three should be replaced
    expect(result.content).toContain("[^fact-f_rev]");
    expect(result.content).toContain("[^fact-f_hc]");
    expect(result.content).toContain("[^fact-f_val]");
    expect(result.content).not.toContain("[^fact:f_");

    // All three definitions should be present
    expect(result.content).toContain("[^fact-f_hc]:");
    expect(result.content).toContain("[^fact-f_rev]:");
    expect(result.content).toContain("[^fact-f_val]:");

    expect(result.resolvedFactIds.size).toBe(3);
  });

  it("handles fact ID that does not exist in KB data", () => {
    const content = "Unknown value[^fact:f_nonexistent].";

    const result = preprocessFactFootnotes(content, emptyLookup);

    // Should still convert the reference syntax
    expect(result.content).toContain("[^fact-f_nonexistent]");
    expect(result.content).not.toContain("[^fact:f_nonexistent]");

    // Should generate a warning footnote
    expect(result.content).toContain("[^fact-f_nonexistent]: Fact f_nonexistent (not found in KB data)");

    expect(result.unresolvedFactIds.has("f_nonexistent")).toBe(true);
    expect(result.resolvedFactIds.size).toBe(0);
  });

  it("returns content unchanged when there are no [^fact:] markers", () => {
    const content = "# Title\n\nSome paragraph without fact footnotes.";
    const result = preprocessFactFootnotes(content, emptyLookup);

    expect(result.content).toBe(content);
    expect(result.resolvedFactIds.size).toBe(0);
    expect(result.unresolvedFactIds.size).toBe(0);
  });

  it("handles empty content", () => {
    const result = preprocessFactFootnotes("", emptyLookup);
    expect(result.content).toBe("");
    expect(result.resolvedFactIds.size).toBe(0);
  });

  it("does not match [^fact:ID]: definition forms", () => {
    // If someone manually wrote a definition, the regex should not match it as a usage
    const content = "Use[^fact:f_test] here.\n\n[^fact:f_test]: Manual definition.";
    const lookup = makeLookup({
      f_test: makeFact({
        id: "f_test",
        source: "https://example.com",
      }),
    });

    const result = preprocessFactFootnotes(content, lookup);

    // The usage should be converted
    expect(result.content).toContain("Use[^fact-f_test] here.");
    // The manual definition line should still have the original syntax
    // (since it ends with : and our regex doesn't match that)
    expect(result.content).toContain("[^fact:f_test]: Manual definition.");
  });

  it("handles the same fact ID used multiple times", () => {
    const content = "First[^fact:f_dup] and again[^fact:f_dup].";
    const lookup = makeLookup({
      f_dup: makeFact({
        id: "f_dup",
        source: "https://example.com/dup",
      }),
    });

    const result = preprocessFactFootnotes(content, lookup);

    // Both should be converted
    expect(result.content).toContain("First[^fact-f_dup] and again[^fact-f_dup].");

    // Only one footnote definition
    const defCount = (result.content.match(/\[\^fact-f_dup\]:/g) || []).length;
    expect(defCount).toBe(1);

    expect(result.resolvedFactIds.size).toBe(1);
  });

  it("preserves existing [^N] footnotes", () => {
    const content = [
      "Existing footnote[^1] and a fact[^fact:f_new].",
      "",
      "[^1]: Existing source",
    ].join("\n");

    const lookup = makeLookup({
      f_new: makeFact({
        id: "f_new",
        source: "https://example.com/new",
      }),
    });

    const result = preprocessFactFootnotes(content, lookup);

    // Existing footnote should remain untouched
    expect(result.content).toContain("Existing footnote[^1]");
    expect(result.content).toContain("[^1]: Existing source");

    // New fact footnote should be added
    expect(result.content).toContain("[^fact-f_new]:");
  });

  it("does not interfere with existing [^kb-] markers", () => {
    const content = "KB ref[^kb-f_abc123] and fact ref[^fact:f_xyz].";
    const lookup = makeLookup({
      f_xyz: makeFact({
        id: "f_xyz",
        source: "https://example.com",
      }),
    });

    const result = preprocessFactFootnotes(content, lookup);

    // KB marker should remain unchanged
    expect(result.content).toContain("[^kb-f_abc123]");
    // Fact marker should be converted
    expect(result.content).toContain("[^fact-f_xyz]");
    expect(result.content).not.toContain("[^fact:f_xyz]");
  });

  it("generates footnotes in sorted order by fact ID", () => {
    const content = "Z[^fact:f_zzz] A[^fact:f_aaa] M[^fact:f_mmm].";
    const lookup = makeLookup({
      f_zzz: makeFact({ id: "f_zzz", asOf: "2025-01" }),
      f_aaa: makeFact({ id: "f_aaa", asOf: "2025-02" }),
      f_mmm: makeFact({ id: "f_mmm", asOf: "2025-03" }),
    });

    const result = preprocessFactFootnotes(content, lookup);

    // Find the positions of footnote definitions
    const posA = result.content.indexOf("[^fact-f_aaa]:");
    const posM = result.content.indexOf("[^fact-f_mmm]:");
    const posZ = result.content.indexOf("[^fact-f_zzz]:");

    expect(posA).toBeLessThan(posM);
    expect(posM).toBeLessThan(posZ);
  });

  it("escapes angle brackets in source quotes that could break MDX", () => {
    const content = "Fact[^fact:f_esc].";
    const lookup = makeLookup({
      f_esc: makeFact({
        id: "f_esc",
        sourceQuote: "Revenue was <EntityLink>high</EntityLink>",
        source: "https://example.com",
      }),
    });

    const result = preprocessFactFootnotes(content, lookup);

    expect(result.content).toContain("\\<EntityLink");
    expect(result.content).toContain("\\</EntityLink");
  });

  it("handles non-URL source text", () => {
    const content = "Fact[^fact:f_nonurl].";
    const lookup = makeLookup({
      f_nonurl: makeFact({
        id: "f_nonurl",
        source: "Internal company report, 2024",
        asOf: "2024-06",
      }),
    });

    const result = preprocessFactFootnotes(content, lookup);

    expect(result.content).toContain("Source: Internal company report, 2024");
    expect(result.content).not.toContain("[Source]");
  });
});

// ---------------------------------------------------------------------------
// Tests: buildFactFootnoteDefinition
// ---------------------------------------------------------------------------

describe("buildFactFootnoteDefinition", () => {
  it("builds full definition with all fields", () => {
    const fact = makeFact({
      id: "f_full",
      source: "https://example.com/report",
      sourceQuote: "Revenue reached $1B",
      asOf: "2024-12",
      notes: "Annual figure",
    });

    const def = buildFactFootnoteDefinition(fact);

    expect(def).toBe(
      '[Source](https://example.com/report) \u2014 *"Revenue reached $1B"* \u2014 (as of 2024-12) \u2014 Annual figure'
    );
  });

  it("builds definition with only source URL", () => {
    const fact = makeFact({
      id: "f_urlonly",
      source: "https://example.com/data",
    });

    const def = buildFactFootnoteDefinition(fact);
    expect(def).toBe("[Source](https://example.com/data)");
  });

  it("builds definition with only sourceQuote", () => {
    const fact = makeFact({
      id: "f_quoteonly",
      sourceQuote: "Important quote here",
    });

    const def = buildFactFootnoteDefinition(fact);
    expect(def).toBe('*"Important quote here"*');
  });

  it("builds definition with only asOf", () => {
    const fact = makeFact({
      id: "f_asofonly",
      asOf: "2025-01",
    });

    const def = buildFactFootnoteDefinition(fact);
    expect(def).toBe("(as of 2025-01)");
  });

  it("returns fallback text when no metadata available", () => {
    const fact = makeFact({ id: "f_nada" });

    const def = buildFactFootnoteDefinition(fact);
    expect(def).toBe("KB fact f_nada");
  });

  it("handles non-URL source text", () => {
    const fact = makeFact({
      id: "f_textref",
      source: "SEC filing Q4 2024",
    });

    const def = buildFactFootnoteDefinition(fact);
    expect(def).toBe("Source: SEC filing Q4 2024");
  });

  it("escapes Markdown special characters in sourceQuote", () => {
    const fact = makeFact({
      id: "f_mdchars",
      source: "https://example.com",
      sourceQuote: "Revenue was *very* high with `code` and _emphasis_ [link]",
    });

    const def = buildFactFootnoteDefinition(fact);

    // Special chars should be escaped
    expect(def).toContain("\\*very\\*");
    expect(def).toContain("\\`code\\`");
    expect(def).toContain("\\_emphasis\\_");
    expect(def).toContain("\\[link\\]");
    // The outer italic markers should still be present
    expect(def).toContain('*"Revenue');
    expect(def).toContain('\\]"*');
  });

  it("escapes backslashes in sourceQuote", () => {
    const fact = makeFact({
      id: "f_backslash",
      sourceQuote: "path\\to\\file",
    });

    const def = buildFactFootnoteDefinition(fact);
    expect(def).toContain("path\\\\to\\\\file");
  });
});

// ---------------------------------------------------------------------------
// Tests: escapeMarkdownInQuote
// ---------------------------------------------------------------------------

describe("escapeMarkdownInQuote", () => {
  it("escapes asterisks", () => {
    expect(escapeMarkdownInQuote("*bold*")).toBe("\\*bold\\*");
  });

  it("escapes backticks", () => {
    expect(escapeMarkdownInQuote("`code`")).toBe("\\`code\\`");
  });

  it("escapes underscores", () => {
    expect(escapeMarkdownInQuote("_italic_")).toBe("\\_italic\\_");
  });

  it("escapes square brackets", () => {
    expect(escapeMarkdownInQuote("[link](url)")).toBe("\\[link\\](url)");
  });

  it("escapes backslashes", () => {
    expect(escapeMarkdownInQuote("a\\b")).toBe("a\\\\b");
  });

  it("returns plain text unchanged", () => {
    expect(escapeMarkdownInQuote("Revenue reached $1B")).toBe(
      "Revenue reached $1B"
    );
  });

  it("handles multiple special characters together", () => {
    expect(escapeMarkdownInQuote("*_`[\\")).toBe("\\*\\_\\`\\[\\\\");
  });

  it("handles empty string", () => {
    expect(escapeMarkdownInQuote("")).toBe("");
  });
});
