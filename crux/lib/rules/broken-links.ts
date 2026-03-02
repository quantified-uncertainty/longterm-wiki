/**
 * Rule: Broken Internal Links
 *
 * Detects markdown links whose targets don't resolve to any file:
 * - MDX/MD files in content/docs/
 * - Next.js app pages in apps/web/src/app/
 *
 * Skips: external URLs, anchors, mailto, tel, images, template variables.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { createRule, Issue, Severity, type ContentFile, type ValidationEngine } from '../validation/validation-engine.ts';
import { isInCodeBlock, isInComment, getLineNumber, shouldSkipValidation } from '../mdx-utils.ts';
import { MARKDOWN_LINK_RE } from '../patterns.ts';
import { CONTENT_DIR_ABS, PROJECT_ROOT } from '../content-types.ts';

const APP_DIR = join(PROJECT_ROOT, 'apps/web/src/app');

/**
 * Check if a link target resolves to any file.
 */
function linkTargetExists(href: string): boolean {
  let path = href.split('#')[0].split('?')[0];

  // Skip placeholder/template links
  if (path.includes('${') || path.includes('...')) return true;

  path = path.replace(/\/$/, '');
  if (path.startsWith('/')) path = path.slice(1);

  const candidates = [
    join(CONTENT_DIR_ABS, path + '.mdx'),
    join(CONTENT_DIR_ABS, path + '.md'),
    join(CONTENT_DIR_ABS, path, 'index.mdx'),
    join(CONTENT_DIR_ABS, path, 'index.md'),
    join(APP_DIR, path, 'page.tsx'),
    join(APP_DIR, path, 'page.jsx'),
  ];

  return candidates.some((p) => existsSync(p));
}

/**
 * Returns true for hrefs we should skip entirely.
 */
function shouldSkipHref(href: string): boolean {
  return (
    href.startsWith('http://') ||
    href.startsWith('https://') ||
    href.startsWith('#') ||
    href.startsWith('mailto:') ||
    href.startsWith('tel:') ||
    /\.(png|jpg|jpeg|gif|svg|webp|pdf|mp4|zip)$/i.test(href)
  );
}

export const brokenLinksRule = createRule({
  id: 'broken-links',
  name: 'Broken Internal Links',
  description: 'Detect markdown links pointing to non-existent pages',

  check(content: ContentFile, _engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];
    const body = content.body;

    // Skip documentation/stub pages
    if (shouldSkipValidation(content.frontmatter)) return issues;

    for (const match of body.matchAll(MARKDOWN_LINK_RE)) {
      const [, text, href] = match;
      const position = match.index;

      if (shouldSkipHref(href)) continue;
      if (isInCodeBlock(body, position) || isInComment(body, position)) continue;

      if (!linkTargetExists(href)) {
        const lineNum = getLineNumber(body, position);
        issues.push(new Issue({
          rule: 'broken-links',
          file: content.path,
          line: lineNum,
          message: `Broken link: [${text}](${href}) — target does not exist`,
          severity: Severity.ERROR,
        }));
      }
    }

    return issues;
  },
});

export default brokenLinksRule;
