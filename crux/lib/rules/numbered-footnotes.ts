/**
 * Numbered Footnotes Validation Rule
 *
 * Detects old-style [^N] (numbered) footnotes that should be migrated to
 * DB-driven reference markers: [^cr-XXXX] for claim references and
 * [^rc-XXXX] for regular citations.
 *
 * Migration is complete — all pages have been converted to DB-driven footnotes.
 * This rule now enforces ERROR severity to prevent regression.
 *
 * Skips:
 * - Files in content/docs/internal/ (internal docs don't get migrated)
 * - Code blocks (fenced with ```)
 *
 * See issue #1162.
 */

import { Severity, Issue } from '../validation/validation-engine.ts';
import type { ContentFile, ValidationEngine } from '../validation/validation-engine.ts';

/** Matches inline numbered footnote references: [^1], [^23], etc. */
const NUMBERED_FOOTNOTE_REF_RE = /\[\^(\d+)\](?!:)/g;

/** Matches numbered footnote definitions: [^1]: ..., [^23]: ..., etc. */
const NUMBERED_FOOTNOTE_DEF_RE = /^\[\^(\d+)\]:/gm;

export const numberedFootnotesRule = {
  id: 'numbered-footnotes',
  name: 'Numbered Footnotes',
  description: 'Detect old-style [^N] footnotes that should be migrated to DB-driven [^cr-XXXX] / [^rc-XXXX] markers',
  severity: Severity.ERROR,

  check(contentFile: ContentFile, _engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];
    const body = contentFile.body || '';
    if (!body) return issues;

    // Skip internal documentation pages — they don't get migrated
    if (contentFile.path.includes('/internal/')) return issues;

    const lines = body.split('\n');
    let inCodeBlock = false;
    let numberedFootnoteCount = 0;
    const seenNumbers = new Set<string>();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Track code block boundaries
      if (line.trim().startsWith('```') || line.trim().startsWith('~~~')) {
        inCodeBlock = !inCodeBlock;
        continue;
      }
      if (inCodeBlock) continue;

      // Check for numbered footnote references
      NUMBERED_FOOTNOTE_REF_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = NUMBERED_FOOTNOTE_REF_RE.exec(line)) !== null) {
        seenNumbers.add(match[1]);
        numberedFootnoteCount++;
      }

      // Check for numbered footnote definitions
      NUMBERED_FOOTNOTE_DEF_RE.lastIndex = 0;
      while ((match = NUMBERED_FOOTNOTE_DEF_RE.exec(line)) !== null) {
        seenNumbers.add(match[1]);
        // Only count definitions that aren't already counted as refs
        if (!seenNumbers.has(match[1])) {
          numberedFootnoteCount++;
        }
      }
    }

    if (seenNumbers.size > 0) {
      issues.push(
        new Issue({
          rule: 'numbered-footnotes',
          file: contentFile.path,
          message: `Page has ${seenNumbers.size} old-style numbered footnote(s) ([^N]). Migrate to DB-driven markers: [^cr-XXXX] or [^rc-XXXX].`,
          severity: Severity.ERROR,
        })
      );
    }

    return issues;
  },
};

export default numberedFootnotesRule;
