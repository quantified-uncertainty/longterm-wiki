/**
 * Rule: Prefer EntityLink Over Markdown Links
 *
 * Detects internal markdown links that should use EntityLink component instead:
 * - [text](/knowledge-base/...) → <EntityLink id="...">text</EntityLink>
 * - [text](/responses/...) → <EntityLink id="...">text</EntityLink>
 * - [text](/risks/...) → <EntityLink id="...">text</EntityLink>
 *
 * Severity:
 * - ERROR: Link points to a registered entity (in idRegistry) — blocking in CI
 * - WARNING: Link points to an internal path but entity is not registered — advisory
 *
 * EntityLink provides consistent styling, automatic title lookup, and better
 * maintainability for internal cross-references.
 */

import { createRule, Issue, Severity, FixType, type ContentFile, type ValidationEngine } from '../validation-engine.ts';
import { isInCodeBlock, isInComment, getLineNumber, shouldSkipValidation } from '../mdx-utils.ts';
import { MARKDOWN_LINK_RE } from '../patterns.ts';
import { loadPathRegistry } from '../content-types.ts';

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

// Module-level cache: built once per process from pathRegistry.json
let reversePathMap: Record<string, string> | null = null;

/**
 * Build reverse map from URL path → entity slug, using the pathRegistry.
 * Cached after first call.
 */
function getReversePathMap(): Record<string, string> {
  if (reversePathMap !== null) return reversePathMap;

  const pathRegistry = loadPathRegistry();
  reversePathMap = {};
  for (const [slug, path] of Object.entries(pathRegistry)) {
    // Skip index entries (e.g. __index__/knowledge-base/capabilities)
    if (slug.startsWith('__index__/')) continue;
    const normalized = path.endsWith('/') ? path : path + '/';
    reversePathMap[normalized] = slug;
    reversePathMap[path.replace(/\/$/, '')] = slug;
  }
  return reversePathMap;
}

/**
 * Extract a suggested entity ID from a path (fallback when not in registry)
 */
function suggestEntityId(path: string): string {
  // Remove leading slash and trailing slash
  let id = path.replace(/^\//, '').replace(/\/$/, '');

  // Remove knowledge-base prefix if present
  id = id.replace(/^knowledge-base\//, '');

  return id;
}

export const preferEntityLinkRule = createRule({
  id: 'prefer-entitylink',
  name: 'Prefer EntityLink Over Markdown Links',
  description: 'Internal links to registered entities must use EntityLink component',

  check(content: ContentFile, engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];
    const body = content.body;

    // Skip documentation, stub, and internal pages
    if (shouldSkipValidation(content.frontmatter) ||
        content.relativePath.includes('/internal/')) {
      return issues;
    }

    const reverseMap = getReversePathMap();
    const idRegistry = engine.idRegistry;

    // Match markdown links: [text](path)
    for (const match of body.matchAll(MARKDOWN_LINK_RE)) {
      const [fullMatch, text, href] = match;
      const position = match.index;

      // Skip if in code block or comment
      if (isInCodeBlock(body, position) || isInComment(body, position)) {
        continue;
      }

      // Remove anchors and query strings for path lookup
      const cleanHref = href.split('#')[0].split('?')[0];

      const isInternalPath = INTERNAL_PATH_PATTERNS.some(pattern => pattern.test(cleanHref));
      const isExcludedPath = EXCLUDED_PATH_PATTERNS.some(pattern => pattern.test(cleanHref));

      if (!isInternalPath || isExcludedPath) continue;

      const lineNum = getLineNumber(body, position);

      // Look up the URL in the reverse path map to get the entity slug
      const normalizedHref = cleanHref.endsWith('/') ? cleanHref : cleanHref + '/';
      const entitySlug = reverseMap[normalizedHref] ?? reverseMap[cleanHref];

      if (entitySlug && idRegistry?.bySlug[entitySlug]) {
        // Registered entity — blocking error with auto-fix
        issues.push(new Issue({
          rule: this.id,
          file: content.path,
          line: lineNum,
          message: `Use EntityLink instead of markdown link: [${text}](${href}) — replace with <EntityLink id="${entitySlug}">${text}</EntityLink>`,
          severity: Severity.ERROR,
          fix: {
            type: FixType.REPLACE_TEXT,
            oldText: fullMatch,
            newText: `<EntityLink id="${entitySlug}">${text}</EntityLink>`,
          },
        }));
      } else {
        // Internal path but not a registered entity — advisory warning
        const suggestedId = entitySlug ?? suggestEntityId(cleanHref);
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
