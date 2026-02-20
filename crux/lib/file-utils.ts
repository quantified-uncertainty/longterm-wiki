/**
 * File Utilities for Scripts
 *
 * Common file discovery and traversal functions used across validators and generators.
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { basename, join } from 'path';
import { CONTENT_DIR_ABS } from './content-types.ts';

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
