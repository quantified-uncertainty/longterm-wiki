/**
 * Pre-processes MDX content to expand `[^fact:FACTID]` markers into standard
 * markdown footnotes with KB fact metadata (source URL, source quote, date, notes).
 *
 * This runs before the reference preprocessor. It produces standard markdown
 * footnote syntax that remark-gfm can handle natively.
 *
 * Example:
 *   Input:  Revenue was \$6.4B[^fact:f_i59sRXPSZw] in 2024.
 *   Output: Revenue was \$6.4B[^fact-f_i59sRXPSZw] in 2024.
 *
 *           [^fact-f_i59sRXPSZw]: [Source](https://example.com) — *"Quote text"* (as of 2024-12)
 */

import type { Fact } from "@longterm-wiki/kb";

/**
 * Regex matching `[^fact:FACTID]` usage sites in MDX content.
 * Captures the fact ID (e.g. "f_i59sRXPSZw") in group 1.
 * Does NOT match definition forms `[^fact:FACTID]: ...`.
 */
const FACT_FOOTNOTE_RE = /\[\^fact:([a-zA-Z0-9_]+)\](?!:)/g;

/**
 * A function that looks up a KB fact by ID.
 * Injected as a dependency to keep this module pure and testable.
 */
export type FactLookupFn = (factId: string) => Fact | undefined;

/**
 * Escape Markdown special characters in source quotes to prevent them from
 * being interpreted as formatting. Characters escaped: \ * ` _ [ ]
 */
export function escapeMarkdownInQuote(text: string): string {
  return text.replace(/([\\*`_\[\]])/g, "\\$1");
}

/**
 * Escape `<` characters that could trigger JSX/HTML parsing in MDX footnote
 * definitions. Reuses the same logic as the reference preprocessor.
 */
function sanitizeFootnoteText(text: string): string {
  return text
    .replace(/<(?=[a-zA-Z/])/g, "\\<")
    .replace(/\r?\n+/g, " "); // Flatten newlines — multiline text breaks footnote definitions
}

/**
 * Build a footnote definition string from a KB Fact.
 *
 * Format: [Source](url) — *"source quote"* (as of DATE) — notes
 *
 * Components are omitted if their data is not available.
 */
export function buildFactFootnoteDefinition(fact: Fact): string {
  const parts: string[] = [];

  if (fact.source) {
    if (fact.source.startsWith("http")) {
      parts.push(`[Source](${fact.source})`);
    } else {
      parts.push(`Source: ${fact.source}`);
    }
  }

  if (fact.sourceQuote) {
    parts.push(`*"${escapeMarkdownInQuote(fact.sourceQuote)}"*`);
  }

  if (fact.asOf) {
    parts.push(`(as of ${fact.asOf})`);
  }

  if (fact.notes) {
    parts.push(fact.notes);
  }

  const text = parts.join(" \u2014 ") || `KB fact ${fact.id}`;
  return sanitizeFootnoteText(text);
}

export interface FactFootnoteResult {
  /** The transformed MDX content with footnote references and definitions. */
  content: string;
  /** Set of fact IDs that were successfully resolved. */
  resolvedFactIds: Set<string>;
  /** Set of fact IDs that could not be found in KB data. */
  unresolvedFactIds: Set<string>;
}

/**
 * Pre-process MDX content, expanding `[^fact:FACTID]` markers into standard
 * markdown footnotes.
 *
 * This function is **pure** when given a factLookup function — it does not
 * perform side effects or make network calls.
 *
 * @param mdxContent - Raw MDX source text
 * @param factLookup - Function to look up a Fact by ID
 * @returns The transformed content and metadata about resolved/unresolved facts
 */
export function preprocessFactFootnotes(
  mdxContent: string,
  factLookup: FactLookupFn
): FactFootnoteResult {
  const resolvedFactIds = new Set<string>();
  const unresolvedFactIds = new Set<string>();

  // Mask code blocks and inline code to avoid matching markers inside them
  const masked = mdxContent
    .replace(/```[\s\S]*?```/g, (m) => "\0".repeat(m.length))
    .replace(/`[^`]+`/g, (m) => "\0".repeat(m.length));

  // Collect all unique fact IDs used in the content (scanning masked version)
  const usedFactIds = new Set<string>();
  for (const m of masked.matchAll(FACT_FOOTNOTE_RE)) {
    usedFactIds.add(m[1]);
  }

  // If no fact footnotes found, return unchanged
  if (usedFactIds.size === 0) {
    return { content: mdxContent, resolvedFactIds, unresolvedFactIds };
  }

  // Replace [^fact:FACTID] with [^fact-FACTID] only outside code blocks.
  // Split content into code/non-code segments, only replace in non-code.
  const CODE_SEGMENT_RE = /(```[\s\S]*?```|`[^`]+`)/g;
  let transformed = "";
  let lastIndex = 0;
  for (const seg of mdxContent.matchAll(CODE_SEGMENT_RE)) {
    // Process non-code text before this code segment
    const before = mdxContent.slice(lastIndex, seg.index!);
    transformed += before.replace(FACT_FOOTNOTE_RE, (_m, fid: string) => `[^fact-${fid}]`);
    // Keep code segment unchanged
    transformed += seg[0];
    lastIndex = seg.index! + seg[0].length;
  }
  // Process remaining non-code text after the last code segment
  transformed += mdxContent.slice(lastIndex).replace(FACT_FOOTNOTE_RE, (_m, fid: string) => `[^fact-${fid}]`);

  // Build footnote definitions
  const footnoteLines: string[] = [];
  const sortedFactIds = Array.from(usedFactIds).sort();

  for (const factId of sortedFactIds) {
    const fact = factLookup(factId);
    let definitionText: string;

    if (fact) {
      resolvedFactIds.add(factId);
      definitionText = buildFactFootnoteDefinition(fact);
    } else {
      unresolvedFactIds.add(factId);
      definitionText = `Fact ${factId} (not found in KB data)`;
    }

    footnoteLines.push(`[^fact-${factId}]: ${definitionText}`);
  }

  // Append footnote definitions at the end with a blank line separator
  const trimmed = transformed.trimEnd();
  transformed = trimmed + "\n\n" + footnoteLines.join("\n") + "\n";

  return { content: transformed, resolvedFactIds, unresolvedFactIds };
}
