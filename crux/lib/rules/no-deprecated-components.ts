/**
 * Rule: No Deprecated Components
 *
 * Catches usage of deprecated MDX components that have been replaced.
 * Currently detects:
 * - `<F e="..." f="...">` — the old inline fact component, replaced by `<KBF entity="..." property="..." />`
 *
 * Only matches the specific old fact syntax (`<F e=` or `<F f=`) to avoid
 * false positives on legitimate `<F>` HTML elements or abbreviations.
 * Skips fenced code blocks and internal/ pages (which may document the old system).
 */

import { createRule, Issue, Severity, type ContentFile, type ValidationEngine } from '../validation/validation-engine.ts';

/**
 * Matches `<F e="` or `<F f="` (the old fact component attribute patterns).
 * Does NOT match generic `<F>` which could be a legitimate HTML element.
 */
const DEPRECATED_F_RE = /<F\s+(?:e=|f=)/g;

export const noDeprecatedComponentsRule = createRule({
  id: 'no-deprecated-components',
  name: 'No Deprecated Components',
  description: 'Catch usage of deprecated MDX components (e.g. old <F e="..." f="..."> fact syntax)',

  check(content: ContentFile, _engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];

    // Skip internal documentation pages (may reference old syntax for documentation purposes)
    if (
      content.relativePath.startsWith('internal/') ||
      content.relativePath.includes('/internal/')
    ) {
      return issues;
    }

    const lines = content.body.split('\n');
    let inFencedBlock = false;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];

      // Track fenced code blocks (``` or ~~~)
      if (/^[ \t]*(`{3,}|~{3,})/.test(line)) {
        inFencedBlock = !inFencedBlock;
        continue;
      }
      if (inFencedBlock) continue;

      // Strip inline code spans before checking
      const strippedLine = line.replace(/`[^`]*`/g, '');

      DEPRECATED_F_RE.lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = DEPRECATED_F_RE.exec(strippedLine)) !== null) {
        issues.push(new Issue({
          rule: 'no-deprecated-components',
          file: content.path,
          line: lineIdx + 1,
          message: `Deprecated <F> fact component detected. Use <KBF entity="..." property="..." /> instead.`,
          severity: Severity.ERROR,
        }));
      }
    }

    return issues;
  },
});

export default noDeprecatedComponentsRule;
