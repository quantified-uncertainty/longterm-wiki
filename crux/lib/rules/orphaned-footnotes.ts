/**
 * Rule: Orphaned Footnotes
 *
 * Detects footnote definitions (e.g. [^7]: Some text) where the corresponding
 * reference (e.g. [^7]) never appears in the body text. These orphaned
 * definitions clutter the page and may confuse readers.
 *
 * The fix removes orphaned footnote definition lines and their continuation
 * lines (indented lines immediately following a definition).
 *
 * Severity: WARNING (quality issue, not a CI-blocking error).
 *
 * See issue #1216.
 */

import { createRule, Issue, Severity, FixType } from '../validation-engine.ts';
import type { ContentFile, ValidationEngine } from '../validation-engine.ts';

/** Matches a footnote definition line: [^MARKER]: text */
const DEF_RE = /^\[\^([^\]]+)\]:\s?/;

/** Matches an inline footnote reference [^MARKER] that is NOT a definition (no colon after). */
const INLINE_REF_RE = /\[\^([^\]]+)\](?!:)/g;

export const orphanedFootnotesRule = createRule({
  id: 'orphaned-footnotes',
  name: 'Orphaned Footnotes',
  description: 'Detect and remove footnote definitions with no matching reference in the body',

  check(content: ContentFile, _engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];
    const body = content.body || '';
    if (!body) return issues;

    // Skip internal documentation pages
    if (content.path.includes('/internal/')) return issues;

    const lines = body.split('\n');

    // Track code fence state to skip patterns inside code blocks
    let inCodeFence = false;

    // Collect all inline references across the document
    const inlineRefs = new Set<string>();
    // Collect all definition markers and their line positions
    const definitions: Array<{ marker: string; lineIndex: number }> = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.trim().startsWith('```') || line.trim().startsWith('~~~')) {
        inCodeFence = !inCodeFence;
        continue;
      }
      if (inCodeFence) continue;

      // Check if this line is a footnote definition
      const defMatch = DEF_RE.exec(line);
      if (defMatch) {
        definitions.push({ marker: defMatch[1], lineIndex: i });
        continue;
      }

      // Collect inline references (from non-definition lines)
      INLINE_REF_RE.lastIndex = 0;
      let refMatch: RegExpExecArray | null;
      while ((refMatch = INLINE_REF_RE.exec(line)) !== null) {
        inlineRefs.add(refMatch[1]);
      }
    }

    // Find orphaned definitions (defined but never referenced)
    for (const { marker, lineIndex } of definitions) {
      if (inlineRefs.has(marker)) continue;

      // This definition is orphaned. Find all lines that belong to it:
      // - The definition line itself
      // - Any continuation lines (indented lines immediately following)
      const defLines: number[] = [lineIndex];
      for (let j = lineIndex + 1; j < lines.length; j++) {
        const nextLine = lines[j];
        // Continuation lines are indented (start with spaces/tabs) and non-empty,
        // OR are completely blank (blank lines within a multi-line footnote).
        // A continuation stops when we hit a non-indented, non-blank line.
        if (nextLine === '' || /^\s+\S/.test(nextLine)) {
          // If it's a blank line, only include it if the NEXT non-blank line
          // is still a continuation (indented). Otherwise, it's the gap between
          // this footnote and the next content.
          if (nextLine === '') {
            // Look ahead to see if there's a continuation after the blank
            let k = j + 1;
            while (k < lines.length && lines[k] === '') k++;
            if (k < lines.length && /^\s+\S/.test(lines[k])) {
              defLines.push(j);
              continue;
            }
            // Blank line is not part of footnote continuation
            break;
          }
          defLines.push(j);
        } else {
          break;
        }
      }

      // Emit one issue per line, each with a REPLACE_LINE fix to clear it.
      // The first line gets the descriptive message; continuation lines are
      // marked as part of the same orphaned footnote.
      for (let idx = 0; idx < defLines.length; idx++) {
        const bodyLineNum = defLines[idx] + 1; // 1-indexed within body
        const isFirstLine = idx === 0;
        issues.push(new Issue({
          rule: 'orphaned-footnotes',
          file: content.path,
          line: bodyLineNum,
          message: isFirstLine
            ? `Orphaned footnote definition [^${marker}]: — no reference [^${marker}] found in body`
            : `Continuation of orphaned footnote [^${marker}]`,
          severity: Severity.WARNING,
          fix: {
            type: FixType.REPLACE_LINE,
            content: '',
          },
        }));
      }
    }

    return issues;
  },
});

export default orphanedFootnotesRule;
