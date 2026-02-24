/**
 * Rule: DataInfoBox Entity ID Match
 *
 * Validates that DataInfoBox components on a page reference the page's own
 * numericId. If a page has `numericId: E887` in frontmatter, any
 * `<DataInfoBox entityId="E886">` would be pointing to a different entity,
 * causing a visible render error.
 *
 * Rationale: DataInfoBox is typically used once per page to render the
 * page's own entity info. Mismatched IDs mean users see data for the wrong
 * entity, which happened with longtermist-value-comparisons (E886 vs E887).
 *
 * Resolves: https://github.com/quantified-uncertainty/longterm-wiki/issues/918
 */

import { createRule, Issue, Severity } from '../validation-engine.ts';
import type { ContentFile, ValidationEngine } from '../validation-engine.ts';

export const datainfoboxEntityMatchRule = createRule({
  id: 'datainfobox-entity-match',
  name: 'DataInfoBox Entity ID Match',
  description: 'Flag DataInfoBox components with entityId that does not match the page\'s own numericId',

  check(content: ContentFile, _engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];

    // Only check pages with a numericId in frontmatter
    const pageNumericId = content.frontmatter?.numericId as string | undefined;
    if (!pageNumericId) return issues;

    // Skip internal/ pages (templates and docs that embed multiple DataInfoBoxes).
    const rel = content.relativePath;
    if (rel.startsWith('internal/')) {
      return issues;
    }

    const body = content.body;

    // Match: entityId="E123" (double-quote form — the only form used in this codebase).
    // Note: The regex character class includes ' and ` as delimiters, but JSX expression
    // forms like entityId={'E123'} would not be correctly captured by this pattern.
    // In practice all DataInfoBox uses double-quote syntax so this is sufficient.
    const datainfoboxPattern = /<DataInfoBox\b[^>]*entityId=["'{`]([^"'{`]+)["'{`][^>]*>/gi;

    let match: RegExpExecArray | null;
    datainfoboxPattern.lastIndex = 0;

    while ((match = datainfoboxPattern.exec(body)) !== null) {
      const entityId = match[1].trim();

      if (entityId !== pageNumericId) {
        const linesBefore = body.substring(0, match.index).split('\n');
        const lineNumber = linesBefore.length;

        issues.push(new Issue({
          rule: this.id,
          file: content.path,
          line: lineNumber,
          message: `DataInfoBox entityId="${entityId}" does not match page numericId="${pageNumericId}". This will display data for the wrong entity.`,
          severity: Severity.ERROR,
        }));
      }
    }

    return issues;
  },
});

export default datainfoboxEntityMatchRule;
