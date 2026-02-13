/**
 * Page Resolution Utility
 *
 * Shared logic for finding wiki pages by ID/slug across the content directory.
 * Used by the visual pipeline scripts (create, review, improve, embed).
 */

import fs from 'fs';
import path from 'path';
import { CONTENT_DIR_ABS } from './content-types.ts';
import { findMdxFiles } from './file-utils.ts';
import { parseFrontmatter } from './mdx-utils.ts';

export interface PageInfo {
  filePath: string;
  content: string;
  slug: string;
  title: string;
  frontmatter: Record<string, unknown>;
}

/**
 * Find a page by its ID (slug, relative path, or full relative path).
 * Returns null if no matching page is found.
 */
export function findPageById(pageId: string): PageInfo | null {
  const files = findMdxFiles(CONTENT_DIR_ABS);

  for (const file of files) {
    const slug = path.basename(file, path.extname(file));
    const relPath = path.relative(CONTENT_DIR_ABS, file);
    const id = relPath.replace(/\.mdx?$/, '');

    if (slug === pageId || id === pageId || relPath === pageId) {
      const content = fs.readFileSync(file, 'utf-8');
      const frontmatter = parseFrontmatter(content);
      return {
        filePath: file,
        content,
        slug,
        title: (frontmatter.title as string) || slug,
        frontmatter,
      };
    }
  }
  return null;
}
