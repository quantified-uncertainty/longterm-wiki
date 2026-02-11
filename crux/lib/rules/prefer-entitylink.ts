/**
 * Rule: Prefer EntityLink Over Markdown Links
 *
 * Detects internal markdown links that should use EntityLink component instead:
 * - [text](/knowledge-base/...) → <EntityLink id="...">text</EntityLink>
 * - [text](/responses/...) → <EntityLink id="...">text</EntityLink>
 * - [text](/risks/...) → <EntityLink id="...">text</EntityLink>
 *
 * EntityLink provides consistent styling, automatic title lookup, and better
 * maintainability for internal cross-references.
 */

import { createRule, Issue, Severity, type ContentFile, type ValidationEngine } from '../validation-engine.ts';
import { isInCodeBlock, isInComment, getLineNumber, shouldSkipValidation } from '../mdx-utils.ts';

// Internal paths that should use EntityLink
const INTERNAL_PATH_PATTERNS = [
  /^\/knowledge-base\//,
  /^\/responses\//,
  /^\/risks\//,
  /^\/organizations\//,
  /^\/people\//,
  /^\/capabilities\//,
  /^\/metrics\//,
  /^\/debates\//,
];

// Paths to exclude from EntityLink requirement (structural navigation, not semantic entities)
const EXCLUDED_PATH_PATTERNS = [
  // Table, matrix, and graph view pages
  /\/table\/?$/,
  /\/matrix\/?$/,
  /\/graph\/?$/,
  // Top-level section index pages (no entity IDs)
  /^\/knowledge-base\/risks\/?$/,
  /^\/knowledge-base\/responses\/?$/,
  /^\/knowledge-base\/models\/?$/,
  /^\/knowledge-base\/organizations\/?$/,
  /^\/knowledge-base\/people\/?$/,
  /^\/knowledge-base\/capabilities\/?$/,
  // Architecture and deployment tables
  /^\/knowledge-base\/architecture-scenarios\/table\/?$/,
  /^\/knowledge-base\/deployment-architectures\/table\/?$/,
];

/**
 * Extract a suggested entity ID from a path
 */
function suggestEntityId(path: string): string {
  // Remove leading slash and trailing slash
  let id = path.replace(/^\//, '').replace(/\/$/, '');

  // Remove knowledge-base prefix if present
  id = id.replace(/^knowledge-base\//, '');

  // Convert path separators to reasonable ID format
  // e.g., "organizations/safety-orgs/miri" stays as-is for lookup
  return id;
}

export const preferEntityLinkRule = createRule({
  id: 'prefer-entitylink',
  name: 'Prefer EntityLink Over Markdown Links',
  description: 'Internal links should use EntityLink component for consistency',

  check(content: ContentFile, engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];
    const body = content.body;

    // Skip documentation, stub, and internal pages
    if (shouldSkipValidation(content.frontmatter) ||
        content.relativePath.includes('/internal/')) {
      return issues;
    }

    // Match markdown links: [text](path)
    const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
    let match: RegExpExecArray | null;

    while ((match = linkRegex.exec(body)) !== null) {
      const [fullMatch, text, href] = match;
      const position = match.index;

      // Skip if in code block or comment
      if (isInCodeBlock(body, position) || isInComment(body, position)) {
        continue;
      }

      // Check if this is an internal path that should use EntityLink
      const cleanHref = href.split('#')[0].split('?')[0]; // Remove anchors and query strings

      const isInternalPath = INTERNAL_PATH_PATTERNS.some(pattern => pattern.test(cleanHref));
      const isExcludedPath = EXCLUDED_PATH_PATTERNS.some(pattern => pattern.test(cleanHref));

      if (isInternalPath && !isExcludedPath) {
        const suggestedId = suggestEntityId(cleanHref);
        const lineNum = getLineNumber(body, position);

        issues.push(new Issue({
          rule: this.id,
          file: content.path,
          line: lineNum,
          message: `Use EntityLink instead of markdown link: [${text}](${href}) → <EntityLink id="${suggestedId}">${text}</EntityLink>`,
          severity: Severity.WARNING,
        }));
      }
    }

    return issues;
  },
});

export default preferEntityLinkRule;
