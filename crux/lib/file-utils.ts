/**
 * File Utilities for Scripts
 *
 * Common file discovery and traversal functions used across validators and generators.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { basename, join } from 'path';
import { CONTENT_DIR_ABS } from './content-types.ts';
import { parseFrontmatter } from './mdx-utils.ts';

/**
 * Find all MDX/MD files recursively in a directory
 */
export function findMdxFiles(dir: string, results: string[] = []): string[] {
  if (!existsSync(dir)) return results;

  try {
    const files = readdirSync(dir);
    for (const file of files) {
      const filePath = join(dir, file);
      const stat = statSync(filePath);
      if (stat.isDirectory()) {
        findMdxFiles(filePath, results);
      } else if (file.endsWith('.mdx') || file.endsWith('.md')) {
        results.push(filePath);
      }
    }
  } catch {
    // Skip directories that can't be read (permissions, etc.)
  }
  return results;
}

/**
 * Find files matching specific extensions recursively
 */
export function findFiles(dir: string, extensions: string[], results: string[] = []): string[] {
  if (!existsSync(dir)) return results;

  try {
    const files = readdirSync(dir);
    for (const file of files) {
      const filePath = join(dir, file);
      const stat = statSync(filePath);
      if (stat.isDirectory()) {
        findFiles(filePath, extensions, results);
      } else if (extensions.some(ext => file.endsWith(ext))) {
        results.push(filePath);
      }
    }
  } catch {
    // Skip directories that can't be read
  }
  return results;
}

/**
 * Find the absolute path of a page's MDX file by its page ID.
 * Returns null if the page is not found.
 */
export function findPageFile(pageId: string): string | null {
  const files = findMdxFiles(CONTENT_DIR_ABS);
  for (const f of files) {
    if (basename(f, '.mdx') === pageId) return f;
  }
  return null;
}

/**
 * Build a Set of all wikiId values found in MDX frontmatter.
 * Used by link validators to recognize `/wiki/E*` dynamic routes.
 * Cached after first call.
 */
let _wikiIdCache: Set<string> | null = null;

export function getWikiIdSet(contentDir: string = CONTENT_DIR_ABS): Set<string> {
  if (_wikiIdCache) return _wikiIdCache;

  const ids = new Set<string>();
  const files = findMdxFiles(contentDir);

  for (const file of files) {
    try {
      const content = readFileSync(file, 'utf-8');
      const fm = parseFrontmatter(content);
      if (typeof fm.wikiId === 'string' && fm.wikiId) {
        ids.add(fm.wikiId);
      }
    } catch {
      // Skip files that can't be read
    }
  }

  _wikiIdCache = ids;
  return ids;
}

/**
 * Check if a `/wiki/Exxx` path resolves to a page with that wikiId.
 */
export function isValidWikiRoute(href: string, contentDir: string = CONTENT_DIR_ABS): boolean {
  // Match /wiki/E123 or /wiki/E123/ patterns
  const match = href.match(/^\/wiki\/(E\d+)\/?$/);
  if (!match) return false;
  return getWikiIdSet(contentDir).has(match[1]);
}

/**
 * Get all directories in a path (non-recursive)
 */
export function getDirectories(dir: string): string[] {
  if (!existsSync(dir)) return [];

  try {
    return readdirSync(dir)
      .map((file: string) => join(dir, file))
      .filter((dirPath: string) => statSync(dirPath).isDirectory());
  } catch {
    return [];
  }
}
