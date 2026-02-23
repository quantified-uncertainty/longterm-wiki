/**
 * Footnote Integrity Validation Rule
 *
 * Detects:
 * 1. Orphaned inline refs: [^N] with no matching [^N]: definition
 * 2. Orphaned definitions: [^N]: with no inline [^N] reference
 * 3. Leaked SRC-style markers: [^SRC-N] that should have been renumbered
 *
 * Severity: ERROR for leaked SRC markers (pipeline bug), WARNING for orphans.
 *
 * See issue #820.
 */

import { Severity, Issue } from '../validation-engine.ts';
import type { ContentFile, ValidationEngine } from '../validation-engine.ts';

/** Matches inline footnote refs [^MARKER] (not inside definition lines). */
const INLINE_REF_RE = /\[\^([^\]]+)\](?!:)/g;

/** Matches footnote definition lines [^MARKER]: text */
const DEF_RE = /^\[\^([^\]]+)\]:\s/gm;

/** Matches SRC-style markers that should have been renumbered. */
const SRC_MARKER_RE = /\[\^(SRC-\d+|S\d+-SRC-\d+)\]/g;

export const footnoteIntegrityRule = {
  id: 'footnote-integrity',
  name: 'Footnote Integrity',
  description: 'Detect orphaned footnote refs/definitions and leaked SRC-style markers',
  severity: Severity.WARNING,

  check(contentFile: ContentFile, _engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];
    const body = contentFile.body || '';
    if (!body) return issues;

    // Skip internal documentation pages
    if (contentFile.path.includes('/internal/')) return issues;

    const lines = body.split('\n');

    // Track code fence state to skip footnote-like patterns inside code
    let inCodeFence = false;

    // Collect refs and defs across the whole document
    const inlineRefs = new Set<string>();
    const definedMarkers = new Set<string>();
    const srcMarkersFound: Array<{ marker: string; line: number }> = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.trim().startsWith('```') || line.trim().startsWith('~~~')) {
        inCodeFence = !inCodeFence;
        continue;
      }
      if (inCodeFence) continue;

      // Check for leaked SRC-style markers
      SRC_MARKER_RE.lastIndex = 0;
      let srcMatch: RegExpExecArray | null;
      while ((srcMatch = SRC_MARKER_RE.exec(line)) !== null) {
        srcMarkersFound.push({ marker: srcMatch[1], line: i + 1 });
      }

      // Collect definition markers
      DEF_RE.lastIndex = 0;
      let defMatch: RegExpExecArray | null;
      while ((defMatch = DEF_RE.exec(line)) !== null) {
        definedMarkers.add(defMatch[1]);
      }

      // Collect inline ref markers (exclude definition lines)
      if (!/^\[\^[^\]]+\]:\s/.test(line)) {
        INLINE_REF_RE.lastIndex = 0;
        let refMatch: RegExpExecArray | null;
        while ((refMatch = INLINE_REF_RE.exec(line)) !== null) {
          inlineRefs.add(refMatch[1]);
        }
      }
    }

    // Check 1: Leaked SRC-style markers (ERROR — pipeline bug)
    for (const { marker, line } of srcMarkersFound) {
      issues.push(new Issue({
        rule: 'footnote-integrity',
        file: contentFile.path,
        line,
        message: `Leaked pipeline marker [^${marker}] — should have been renumbered to [^N] by renumberFootnotes()`,
        severity: Severity.ERROR,
      }));
    }

    // Check 2: Orphaned inline refs (ref exists, no definition)
    for (const ref of inlineRefs) {
      if (!definedMarkers.has(ref) && !/^SRC-|^S\d+-SRC-/.test(ref)) {
        issues.push(new Issue({
          rule: 'footnote-integrity',
          file: contentFile.path,
          message: `Orphaned footnote reference [^${ref}] — no matching definition [^${ref}]:`,
          severity: Severity.WARNING,
        }));
      }
    }

    // Check 3: Orphaned definitions (def exists, no inline ref)
    for (const def of definedMarkers) {
      if (!inlineRefs.has(def) && !/^SRC-|^S\d+-SRC-/.test(def)) {
        issues.push(new Issue({
          rule: 'footnote-integrity',
          file: contentFile.path,
          message: `Orphaned footnote definition [^${def}]: — no inline reference [^${def}] found in body`,
          severity: Severity.WARNING,
        }));
      }
    }

    return issues;
  },
};

export default footnoteIntegrityRule;
