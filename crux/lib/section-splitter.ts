/**
 * Section Splitter
 *
 * Parses MDX wiki pages into frontmatter, preamble, and ## sections.
 * Provides reassembly and footnote renumbering for the section-level
 * improve pipeline path.
 *
 * Key design choices:
 *  - Only splits on H2 (##) headings — H3+ headings stay within their
 *    parent section, preserving existing page structure.
 *  - Footnote renumbering handles both numeric [^1] and alphanumeric [^SRC-1]
 *    markers, converting everything to sequential [^1], [^2], ... after
 *    reassembly.  This bridges the gap between section-writer output and
 *    the pipeline's numeric footnote convention.
 *  - Source filtering scores sources by keyword overlap with the section
 *    heading so the most relevant sources are presented first per section.
 *
 * See issue #671.
 */

import type { SourceCacheEntry } from './section-writer.ts';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** A single ## section extracted from a wiki page. */
export interface ParsedSection {
  /** Slug-style ID derived from the heading text, e.g. 'key-challenges'. */
  id: string;
  /** The ## heading line itself, e.g. '## Key Challenges'. */
  heading: string;
  /** Full section content including the heading line (no trailing newline). */
  content: string;
}

/** A wiki page split into structural parts. */
export interface SplitPage {
  /** YAML frontmatter block (with --- delimiters), or '' if none. */
  frontmatter: string;
  /** Content before the first ## heading (imports, intro paragraph, etc.). */
  preamble: string;
  /** Parsed ## sections in document order. */
  sections: ParsedSection[];
}

// ---------------------------------------------------------------------------
// Heading → ID
// ---------------------------------------------------------------------------

/**
 * Convert a ## heading line to a slug-style section ID.
 * E.g. '## Key Challenges (2023–2025)' → 'key-challenges-2023-2025'
 */
export function headingToId(heading: string): string {
  return heading
    .replace(/^#+\s*/, '')        // strip leading # marks and whitespace
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')  // non-alphanumeric runs → dash
    .replace(/^-+|-+$/g, '');     // trim leading/trailing dashes
}

// ---------------------------------------------------------------------------
// Splitting
// ---------------------------------------------------------------------------

/**
 * Split MDX content into frontmatter, preamble, and ## sections.
 *
 * Only H2 (##) headings trigger a new section.  H3+ headings stay within
 * their parent section unchanged.
 */
export function splitIntoSections(content: string): SplitPage {
  // 1. Extract frontmatter (---…--- block at the very start)
  let frontmatter = '';
  let body = content;
  const fmMatch = content.match(/^(---\n[\s\S]*?\n---\n?)/);
  if (fmMatch) {
    frontmatter = fmMatch[1];
    body = content.slice(fmMatch[1].length);
  }

  // 2. Walk lines and accumulate sections
  const lines = body.split('\n');
  const sections: ParsedSection[] = [];
  const preambleLines: string[] = [];
  let currentLines: string[] | null = null;
  let currentHeading = '';
  let inCodeFence = false; // track ``` or ~~~ blocks to avoid splitting on H2s inside them

  for (const line of lines) {
    // Toggle code-fence state — both ``` and ~~~ fences are supported in MDX.
    if (/^(`{3,}|~{3,})/.test(line)) {
      inCodeFence = !inCodeFence;
    }

    if (!inCodeFence && /^## /.test(line)) {
      // Save in-progress section (not preamble)
      if (currentLines !== null) {
        sections.push({
          id: headingToId(currentHeading),
          heading: currentHeading,
          content: [currentHeading, ...currentLines].join('\n'),
        });
      }
      currentHeading = line;
      currentLines = [];
    } else if (currentLines !== null) {
      currentLines.push(line);
    } else {
      preambleLines.push(line);
    }
  }

  // Flush last section
  if (currentLines !== null && currentHeading) {
    sections.push({
      id: headingToId(currentHeading),
      heading: currentHeading,
      content: [currentHeading, ...currentLines].join('\n'),
    });
  }

  return {
    frontmatter,
    preamble: preambleLines.join('\n'),
    sections,
  };
}

// ---------------------------------------------------------------------------
// Reassembly
// ---------------------------------------------------------------------------

/**
 * Reassemble a split page back into a single MDX string.
 *
 * Parts are joined with double newlines; runs of 3+ newlines are collapsed
 * to 2.  The result always ends with exactly one newline.
 */
export function reassembleSections(split: SplitPage): string {
  const parts: string[] = [];

  if (split.frontmatter) parts.push(split.frontmatter.trimEnd());
  if (split.preamble.trim()) parts.push(split.preamble.trimEnd());
  for (const section of split.sections) parts.push(section.content.trimEnd());

  let result = parts.join('\n\n') + '\n';
  result = result.replace(/\n{3,}/g, '\n\n');
  return result;
}

// ---------------------------------------------------------------------------
// Footnote renumbering
// ---------------------------------------------------------------------------

/**
 * Renumber all footnotes in a document to sequential integers starting at 1.
 *
 * Handles both:
 *   - Numeric markers:       [^1], [^2]   (existing pipeline format)
 *   - Alphanumeric markers:  [^SRC-1]     (section-writer output format)
 *
 * Algorithm:
 *   1. Collect all definition lines: [^MARKER]: text
 *   2. Strip definitions from body.
 *   3. Walk inline refs [^MARKER] in order of first appearance; assign new
 *      sequential numbers.
 *   4. Replace all inline refs with [^N].
 *   5. Rebuild definition block at document end using new numbers.
 *
 * If there are no footnote markers, the content is returned unchanged.
 * If a ref has no matching definition, the ref is kept with its new number
 * but no definition is emitted (avoids silent data loss).
 */
export function renumberFootnotes(content: string): string {
  // Step 1: collect definitions
  const defRe = /^\[\^([^\]]+)\]:\s*(.+)$/gm;
  const defs = new Map<string, string>(); // marker → definition text
  let m: RegExpExecArray | null;

  defRe.lastIndex = 0;
  while ((m = defRe.exec(content)) !== null) {
    // Keep the first definition for a given marker (earlier in doc wins)
    if (!defs.has(m[1])) defs.set(m[1], m[2]);
  }

  if (defs.size === 0) {
    // No definitions — check if there are any inline refs anyway
    if (!/\[\^[^\]]+\]/.test(content)) return content;
    // There are refs with no defs — still renumber for consistency
  }

  // Step 2: strip all definition lines from content
  let stripped = content.replace(/^\[\^([^\]]+)\]:\s*.+\n?/gm, '');
  // Collapse blank lines that appear after removing defs
  stripped = stripped.replace(/\n{3,}/g, '\n\n').trimEnd();

  // Step 3: assign new numbers by first-appearance order of inline refs
  const inlineRe = /\[\^([^\]]+)\]/g;
  const mapping = new Map<string, number>(); // marker → new number
  let counter = 1;

  inlineRe.lastIndex = 0;
  while ((m = inlineRe.exec(stripped)) !== null) {
    const marker = m[1];
    if (!mapping.has(marker)) {
      mapping.set(marker, counter++);
    }
  }

  if (mapping.size === 0) return stripped + '\n';

  // Step 4: replace inline refs
  const renumbered = stripped.replace(/\[\^([^\]]+)\]/g, (_, marker: string) => {
    const num = mapping.get(marker);
    return num !== undefined ? `[^${num}]` : `[^${marker}]`;
  });

  // Step 5: rebuild definitions block in numeric order
  const defLines: string[] = [];
  const sorted = [...mapping.entries()].sort((a, b) => a[1] - b[1]);
  for (const [marker, num] of sorted) {
    const defText = defs.get(marker);
    if (defText) defLines.push(`[^${num}]: ${defText}`);
  }

  if (defLines.length === 0) return renumbered + '\n';
  return renumbered + '\n\n' + defLines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Source filtering
// ---------------------------------------------------------------------------

/**
 * Rank source cache entries by relevance to a section.
 *
 * Scoring (additive):
 *   +2 per heading keyword found in source title or facts
 *   +1 per heading keyword found in source content (first 1 000 chars)
 *
 * Keywords are words in the heading that are longer than 3 characters.
 * If no scoring occurs (no keyword overlap), sources are returned in their
 * original order.
 */
export function filterSourcesForSection(
  section: ParsedSection,
  sources: SourceCacheEntry[],
): SourceCacheEntry[] {
  if (sources.length === 0) return [];

  const headingWords = section.heading
    .replace(/^#+\s*/, '')
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 3);

  if (headingWords.length === 0) return sources;

  const scored = sources.map(src => {
    let score = 0;
    const titleLower = src.title.toLowerCase();
    const factsText = (src.facts ?? []).join(' ').toLowerCase();
    const contentSnippet = (src.content ?? '').toLowerCase().slice(0, 1_000);

    for (const word of headingWords) {
      if (titleLower.includes(word)) score += 2;
      if (factsText.includes(word)) score += 2;
      if (contentSnippet.includes(word)) score += 1;
    }
    return { src, score };
  });

  const anyScore = scored.some(s => s.score > 0);
  if (!anyScore) return sources;

  return scored.sort((a, b) => b.score - a.score).map(s => s.src);
}
