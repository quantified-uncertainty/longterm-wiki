/**
 * Rule: Internal Link Validation
 *
 * Validates that internal markdown links resolve to existing content:
 * - [text](/knowledge-base/path/) links point to real files
 * - Links have trailing slashes (Astro/Starlight convention)
 * - Links don't include file extensions
 */

import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { createRule, Issue, Severity } from '../validation-engine.js';
import { isInCodeBlock } from '../mdx-utils.mjs';

const CONTENT_DIR = join(process.cwd(), 'content/docs');
const PAGES_DIR = join(process.cwd(), 'src/pages');

/**
 * Check if an internal link resolves to an existing file
 */
function resolveLink(href, sourceFile) {
  // Remove anchor and query string
  let path = href.split('#')[0].split('?')[0];

  // Skip placeholder links
  if (path.includes('...')) {
    return { exists: true, isPlaceholder: true };
  }

  // Remove trailing slash for file lookup
  path = path.replace(/\/$/, '');

  // Handle relative paths
  if (path.startsWith('./') || path.startsWith('../')) {
    const sourceDir = dirname(sourceFile);
    path = join(sourceDir, path);
    path = path.replace(CONTENT_DIR + '/', '').replace(CONTENT_DIR, '');
  } else if (path.startsWith('/')) {
    path = path.slice(1);
  }

  // Check various possible file locations
  const possiblePaths = [
    join(CONTENT_DIR, path + '.mdx'),
    join(CONTENT_DIR, path + '.md'),
    join(CONTENT_DIR, path, 'index.mdx'),
    join(CONTENT_DIR, path, 'index.md'),
    join(PAGES_DIR, path + '.astro'),
    join(PAGES_DIR, path, 'index.astro'),
  ];

  for (const p of possiblePaths) {
    if (existsSync(p)) {
      return { exists: true, resolvedPath: p };
    }
  }

  return { exists: false };
}

export const internalLinksRule = createRule({
  id: 'internal-links',
  name: 'Internal Link Validation',
  description: 'Verify internal markdown links resolve to existing content',

  check(content, engine) {
    const issues = [];
    const body = content.body;

    // Match markdown links: [text](path)
    const linkRegex = /\[([^\]]*)\]\(([^)]+)\)/g;
    let match;
    let position = 0;
    const lines = body.split('\n');

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      const lineNum = lineIdx + 1;

      // Skip if in code block
      if (isInCodeBlock(body, position)) {
        position += line.length + 1;
        continue;
      }

      linkRegex.lastIndex = 0;
      while ((match = linkRegex.exec(line)) !== null) {
        const [fullMatch, text, href] = match;

        // Skip external links, anchors, mailto, tel
        if (href.startsWith('http://') ||
            href.startsWith('https://') ||
            href.startsWith('#') ||
            href.startsWith('mailto:') ||
            href.startsWith('tel:')) {
          continue;
        }

        // Skip template variables
        if (href.includes('${')) {
          continue;
        }

        // Skip image links
        if (href.match(/\.(png|jpg|jpeg|gif|svg|webp)$/i)) {
          continue;
        }

        // Check if link resolves
        const resolution = resolveLink(href, content.path);

        if (!resolution.exists) {
          issues.push(new Issue({
            rule: this.id,
            file: content.path,
            line: lineNum,
            message: `Broken link: "${href}" (text: "${text}")`,
            severity: Severity.ERROR,
          }));
        }

        // Check conventions
        if (!href.endsWith('/') && !href.includes('#') && !href.includes('.') && !href.includes('?')) {
          issues.push(new Issue({
            rule: this.id,
            file: content.path,
            line: lineNum,
            message: `Missing trailing slash: "${href}"`,
            severity: Severity.WARNING,
          }));
        }
      }

      position += line.length + 1;
    }

    return issues;
  },
});

export default internalLinksRule;
