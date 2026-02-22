/**
 * Content chunking for enrichment LLM calls.
 *
 * Splits MDX content into sections small enough to fit in a single LLM call,
 * without the 6000-char truncation that silently drops mentions in long pages.
 *
 * Design choices:
 *  - Splits at H2 boundaries (via section-splitter) so each chunk is a
 *    coherent section, not an arbitrary window.
 *  - Excludes frontmatter from LLM chunks: it contains only YAML metadata
 *    and the LLM system prompt already says to skip it.
 *  - Falls back to line-boundary splitting for sections > MAX_CHUNK_SIZE,
 *    avoiding mid-entity-name or mid-tag cuts.
 *
 * See issue #673.
 */

import { splitIntoSections } from './section-splitter.ts';

/** Maximum content size (chars) sent to the LLM per call. Larger content is split. */
export const MAX_CHUNK_SIZE = 5000;

/**
 * Split MDX content into chunks for LLM processing.
 *
 * Returns one chunk per H2 section (plus an intro chunk for preamble text).
 * Frontmatter is excluded — it is YAML metadata that the LLM prompt already
 * instructs the model to skip, so sending it wastes tokens.
 * Falls back to line-boundary splitting at MAX_CHUNK_SIZE for large sections.
 *
 * Exported for testing.
 */
export function splitContentForEnrichment(content: string): string[] {
  if (content.length <= MAX_CHUNK_SIZE) return [content];

  const { preamble, sections } = splitIntoSections(content);
  const chunks: string[] = [];

  // Intro chunk: preamble only (text before first H2).
  // Frontmatter is intentionally excluded — see module docstring.
  if (preamble.trim()) chunks.push(preamble);

  // Each H2 section becomes its own chunk.
  for (const section of sections) {
    if (section.content.length <= MAX_CHUNK_SIZE) {
      chunks.push(section.content);
    } else {
      // Very large section: split at line boundaries near MAX_CHUNK_SIZE.
      // Splitting at arbitrary byte positions can bisect entity names, JSX tags,
      // or backtick-delimited spans, causing the LLM to miss or corrupt them.
      let i = 0;
      while (i < section.content.length) {
        let end = i + MAX_CHUNK_SIZE;
        if (end < section.content.length) {
          // Walk back to the last newline to avoid mid-line cuts.
          const lastNewline = section.content.lastIndexOf('\n', end);
          if (lastNewline > i) end = lastNewline + 1; // include the newline
        }
        chunks.push(section.content.slice(i, end));
        i = end;
      }
    }
  }

  return chunks.filter(c => c.trim());
}
