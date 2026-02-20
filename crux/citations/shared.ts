/**
 * Shared Citation Utilities
 *
 * Common helpers used across multiple citation pipeline scripts.
 * Extracted to avoid duplication.
 */

import { readFileSync } from 'fs';
import { basename } from 'path';
import { CONTENT_DIR_ABS } from '../lib/content-types.ts';
import { findMdxFiles } from '../lib/file-utils.ts';
import { stripFrontmatter } from '../lib/patterns.ts';
import { extractCitationsFromContent } from '../lib/citation-archive.ts';
import type { Colors } from '../lib/output.ts';

// ---------------------------------------------------------------------------
// Page discovery
// ---------------------------------------------------------------------------

export interface PageWithCitations {
  pageId: string;
  path: string;
  citationCount: number;
}

/**
 * Find all knowledge-base pages that contain at least one citation.
 * Returns sorted by citation count descending.
 */
export function findPagesWithCitations(): PageWithCitations[] {
  const files = findMdxFiles(CONTENT_DIR_ABS);
  const results: PageWithCitations[] = [];

  for (const f of files) {
    if (!f.includes('/knowledge-base/')) continue;
    if (basename(f).startsWith('index.')) continue;

    try {
      const raw = readFileSync(f, 'utf-8');
      const body = stripFrontmatter(raw);
      const citations = extractCitationsFromContent(body);
      if (citations.length > 0) {
        results.push({
          pageId: basename(f, '.mdx'),
          path: f,
          citationCount: citations.length,
        });
      }
    } catch {
      // Skip unreadable files
    }
  }

  return results.sort((a, b) => b.citationCount - a.citationCount);
}

// ---------------------------------------------------------------------------
// Batch progress logging
// ---------------------------------------------------------------------------

/**
 * Log batch timing and ETA for multi-page processing loops.
 * Call after each batch completes.
 */
export function logBatchProgress(
  c: Colors,
  opts: {
    batchIndex: number;
    concurrency: number;
    totalPages: number;
    runStartMs: number;
    batchStartMs: number;
  },
): void {
  const pagesCompleted = Math.min(opts.batchIndex + opts.concurrency, opts.totalPages);
  const elapsed = (Date.now() - opts.runStartMs) / 1000;
  const batchSec = (Date.now() - opts.batchStartMs) / 1000;
  const avgPerPage = elapsed / pagesCompleted;
  const remaining = avgPerPage * (opts.totalPages - pagesCompleted);
  const etaStr = remaining > 0
    ? `ETA ${Math.ceil(remaining / 60)}m ${Math.round(remaining % 60)}s`
    : 'done';
  console.log(
    `${c.dim}  batch ${batchSec.toFixed(0)}s | elapsed ${Math.floor(elapsed / 60)}m ${Math.round(elapsed % 60)}s | ${etaStr}${c.reset}`,
  );
  console.log('');
}
