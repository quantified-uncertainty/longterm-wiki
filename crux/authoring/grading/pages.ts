/**
 * Page collection and classification for the grading pipeline.
 *
 * Scans the content directory, extracts frontmatter, and builds
 * a structured list of pages for processing.
 */

import { readFileSync } from 'fs';
import { relative, basename, dirname } from 'path';
import { CONTENT_DIR } from '../../lib/content-types.ts';
import { parseFrontmatter } from '../../lib/mdx-utils.ts';
import { findMdxFiles } from '../../lib/file-utils.ts';
import type { Frontmatter, PageInfo } from './types.ts';

/**
 * Detect page type based on filename and frontmatter.
 * - 'overview': index.mdx files (navigation pages)
 * - 'stub': explicitly marked in frontmatter
 * - 'content': default
 */
function detectPageType(id: string, frontmatter: Frontmatter): string {
  if (id === 'index') return 'overview';
  if (frontmatter.pageType === 'stub') return 'stub';
  return 'content';
}

/** Scan content directory and collect all pages. */
export function collectPages(): PageInfo[] {
  const files = findMdxFiles(CONTENT_DIR);
  const pages: PageInfo[] = [];

  for (const fullPath of files) {
    const content = readFileSync(fullPath, 'utf-8');
    const fm = parseFrontmatter(content) as Frontmatter;
    const entry = basename(fullPath);
    const id = basename(entry, entry.endsWith('.mdx') ? '.mdx' : '.md');

    const relPath = relative(CONTENT_DIR, fullPath);
    const pathParts = dirname(relPath).split('/').filter(p => p && p !== '.');
    const category = pathParts[0] || 'other';
    const subcategory = pathParts[1] || null;
    const urlPrefix = '/' + pathParts.join('/');

    const isModel = relPath.includes('/models') || fm.ratings !== undefined;
    const pageType = detectPageType(id, fm);

    pages.push({
      id,
      filePath: fullPath,
      relativePath: relPath,
      urlPath: id === 'index' ? `${urlPrefix}/` : `${urlPrefix}/${id}/`,
      title: fm.title || id.replace(/-/g, ' '),
      category,
      subcategory,
      isModel,
      pageType,
      contentFormat: (fm.contentFormat as string) || 'article',
      currentReaderImportance: fm.readerImportance ?? null,
      currentQuality: fm.quality ?? null,
      currentRatings: fm.ratings ?? null,
      content,
      frontmatter: fm,
    });
  }

  return pages;
}
