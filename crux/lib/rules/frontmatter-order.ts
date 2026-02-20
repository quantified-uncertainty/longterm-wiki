/**
 * Frontmatter Field Order Validation Rule
 *
 * Non-blocking (WARNING) rule that flags frontmatter fields that are not
 * in the canonical order defined in crux/lib/frontmatter-order.ts.
 *
 * Auto-fixable via `pnpm crux fix frontmatter-order --apply`.
 *
 * See: https://github.com/quantified-uncertainty/longterm-wiki/issues/398
 */

import { Severity, Issue, type ContentFile, type ValidationEngine } from '../validation-engine.ts';
import { getFieldSortIndex } from '../frontmatter-order.ts';

/**
 * Extract top-level frontmatter field names from raw file content,
 * preserving their source order.
 */
function extractFieldOrder(raw: string): string[] {
  const lines = raw.split('\n');
  if (lines[0] !== '---') return [];

  const fields: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') break;
    const match = lines[i].match(/^([a-zA-Z_][\w]*):/);
    if (match) {
      fields.push(match[1]);
    }
  }
  return fields;
}

export const frontmatterOrderRule = {
  id: 'frontmatter-order',
  name: 'Frontmatter Field Order',
  description: 'Check that frontmatter fields follow canonical ordering (identity first, volatile last)',
  severity: Severity.WARNING,

  check(contentFile: ContentFile, _engine: ValidationEngine): Issue[] {
    const fields = extractFieldOrder(contentFile.raw);
    if (fields.length < 2) return [];

    // Check if fields are in canonical order
    for (let i = 1; i < fields.length; i++) {
      const prevIdx = getFieldSortIndex(fields[i - 1]);
      const currIdx = getFieldSortIndex(fields[i]);
      if (prevIdx > currIdx) {
        return [
          new Issue({
            rule: 'frontmatter-order',
            file: contentFile.path,
            line: 1,
            message: `Frontmatter fields out of canonical order: "${fields[i - 1]}" (group ${prevIdx}) appears before "${fields[i]}" (group ${currIdx}). Fix with: pnpm crux fix frontmatter-order --apply`,
            severity: Severity.WARNING,
          }),
        ];
      }
    }

    return [];
  },
};
