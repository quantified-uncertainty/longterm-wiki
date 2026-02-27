/**
 * CI Content Checks for Auto-Update Pages
 *
 * Testable TypeScript implementations of content quality checks that run
 * during the auto-update pipeline. These replace inline shell scripts in
 * GitHub Actions workflows.
 *
 * Checks:
 *   1. Truncation detection — flags pages that shrank significantly
 *   2. Dangling footnotes — finds orphaned [^N] refs with no definition
 *
 * Usage (via crux CLI):
 *   pnpm crux auto-update content-checks --diff                 # Check changed pages
 *   pnpm crux auto-update content-checks --diff --json          # JSON output
 *   pnpm crux auto-update content-checks page-a page-b          # Check specific pages
 */

import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { basename } from 'path';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { findPageFile } from '../lib/file-utils.ts';

// ── Types ────────────────────────────────────────────────────────────────────

export interface TruncationResult {
  pageId: string;
  beforeWords: number;
  afterWords: number;
  dropPercent: number;
  status: 'ok' | 'warning' | 'blocked';
}

export interface FootnoteResult {
  pageId: string;
  orphanedRefs: string[];
  orphanedDefs: string[];
  status: 'ok' | 'blocked';
}

export interface PageCheckResult {
  pageId: string;
  truncation: TruncationResult;
  footnotes: FootnoteResult;
  passed: boolean;
}

export interface ContentChecksResult {
  pages: PageCheckResult[];
  totalPages: number;
  truncationBlocked: string[];
  truncationWarned: string[];
  footnoteBlocked: string[];
  passed: boolean;
  markdownSummary: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const TRUNCATION_BLOCK_THRESHOLD = 30; // % shrinkage that blocks
const TRUNCATION_WARN_THRESHOLD = 15;  // % shrinkage that warns

// ── Footnote detection (pure functions, testable) ────────────────────────────

/** Matches inline footnote refs [^MARKER] (not on definition lines). */
const INLINE_REF_RE = /\[\^([^\]]+)\](?!:)/g;

/** Matches footnote definition lines [^MARKER]: */
const DEF_RE = /^\[\^([^\]]+)\]:\s?/gm;

/**
 * Extract footnote refs and defs from markdown content.
 * Skips code fences and SRC-style markers.
 */
export function extractFootnotes(content: string): { refs: Set<string>; defs: Set<string> } {
  const refs = new Set<string>();
  const defs = new Set<string>();
  const lines = content.split('\n');
  let inCodeFence = false;

  for (const line of lines) {
    if (line.trim().startsWith('```') || line.trim().startsWith('~~~')) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;

    // Collect definitions
    DEF_RE.lastIndex = 0;
    let defMatch: RegExpExecArray | null;
    while ((defMatch = DEF_RE.exec(line)) !== null) {
      if (!/^SRC-|^S\d+-SRC-/.test(defMatch[1])) {
        defs.add(defMatch[1]);
      }
    }

    // Collect inline refs (skip definition lines)
    if (!/^\[\^[^\]]+\]:\s?/.test(line)) {
      INLINE_REF_RE.lastIndex = 0;
      let refMatch: RegExpExecArray | null;
      while ((refMatch = INLINE_REF_RE.exec(line)) !== null) {
        if (!/^SRC-|^S\d+-SRC-/.test(refMatch[1])) {
          refs.add(refMatch[1]);
        }
      }
    }
  }

  return { refs, defs };
}

/**
 * Find orphaned footnote references (refs without definitions).
 */
export function findOrphanedRefs(content: string): { orphanedRefs: string[]; orphanedDefs: string[] } {
  const { refs, defs } = extractFootnotes(content);

  const orphanedRefs = [...refs].filter(r => !defs.has(r)).sort();
  const orphanedDefs = [...defs].filter(d => !refs.has(d)).sort();

  return { orphanedRefs, orphanedDefs };
}

// ── Truncation detection ─────────────────────────────────────────────────────

/** Count words in a string (matches shell `wc -w` behavior). */
export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Check a single page for truncation by comparing word count against a base version.
 */
export function checkTruncation(
  currentContent: string,
  baseContent: string | null,
): TruncationResult & { pageId: string } {
  const afterWords = countWords(currentContent);
  const beforeWords = baseContent ? countWords(baseContent) : 0;

  if (beforeWords === 0) {
    return { pageId: '', beforeWords: 0, afterWords, dropPercent: 0, status: 'ok' };
  }

  const dropPercent = Math.round(((beforeWords - afterWords) / beforeWords) * 100);

  let status: TruncationResult['status'] = 'ok';
  if (dropPercent >= TRUNCATION_BLOCK_THRESHOLD) {
    status = 'blocked';
  } else if (dropPercent >= TRUNCATION_WARN_THRESHOLD) {
    status = 'warning';
  }

  return { pageId: '', beforeWords, afterWords, dropPercent, status };
}

// ── Git helpers ──────────────────────────────────────────────────────────────

function getChangedPageIds(baseBranch: string): string[] {
  try {
    // Use unstaged diff (working tree vs HEAD) for auto-update pipeline context
    // where changes haven't been committed yet
    const diff = execFileSync('git', [
      'diff', '--name-only', 'HEAD', '--', 'content/docs/',
    ], { cwd: PROJECT_ROOT, encoding: 'utf-8' }).trim();

    if (!diff) return [];

    return diff
      .split('\n')
      .filter(f => f.endsWith('.mdx'))
      .map(f => basename(f, '.mdx'))
      .filter(id => id !== 'index');
  } catch {
    return [];
  }
}

function getBaseContent(pageId: string): string | null {
  try {
    // Get the file content from HEAD (before working tree changes)
    const files = execFileSync('git', [
      'ls-files', '--full-name', `content/docs/**/${pageId}.mdx`,
    ], { cwd: PROJECT_ROOT, encoding: 'utf-8' }).trim();

    const filePath = files.split('\n')[0];
    if (!filePath) return null;

    return execFileSync('git', [
      'show', `HEAD:${filePath}`,
    ], { cwd: PROJECT_ROOT, encoding: 'utf-8' });
  } catch {
    return null;
  }
}

// ── Main pipeline ────────────────────────────────────────────────────────────

export function checkPage(pageId: string): PageCheckResult {
  const filePath = findPageFile(pageId);
  if (!filePath) {
    return {
      pageId,
      truncation: { pageId, beforeWords: 0, afterWords: 0, dropPercent: 0, status: 'ok' },
      footnotes: { pageId, orphanedRefs: [], orphanedDefs: [], status: 'ok' },
      passed: true,
    };
  }

  const currentContent = readFileSync(filePath, 'utf-8');
  const baseContent = getBaseContent(pageId);

  // Truncation check
  const truncation = checkTruncation(currentContent, baseContent);
  truncation.pageId = pageId;

  // Footnote check
  const { orphanedRefs, orphanedDefs } = findOrphanedRefs(currentContent);
  const footnotes: FootnoteResult = {
    pageId,
    orphanedRefs,
    orphanedDefs,
    status: orphanedRefs.length > 0 ? 'blocked' : 'ok',
  };

  const passed = truncation.status !== 'blocked' && footnotes.status !== 'blocked';

  return { pageId, truncation, footnotes, passed };
}

export function runContentChecks(options: {
  pageIds?: string[];
  baseBranch?: string;
}): ContentChecksResult {
  const baseBranch = options.baseBranch ?? 'main';

  let pageIds = options.pageIds ?? [];
  if (pageIds.length === 0) {
    pageIds = getChangedPageIds(baseBranch);
  }

  if (pageIds.length === 0) {
    return {
      pages: [],
      totalPages: 0,
      truncationBlocked: [],
      truncationWarned: [],
      footnoteBlocked: [],
      passed: true,
      markdownSummary: 'No pages to check.',
    };
  }

  const results = pageIds.map(id => checkPage(id));

  const truncationBlocked = results
    .filter(r => r.truncation.status === 'blocked')
    .map(r => r.pageId);
  const truncationWarned = results
    .filter(r => r.truncation.status === 'warning')
    .map(r => r.pageId);
  const footnoteBlocked = results
    .filter(r => r.footnotes.status === 'blocked')
    .map(r => r.pageId);

  const passed = truncationBlocked.length === 0 && footnoteBlocked.length === 0;

  return {
    pages: results,
    totalPages: pageIds.length,
    truncationBlocked,
    truncationWarned,
    footnoteBlocked,
    passed,
    markdownSummary: buildMarkdownSummary(results, passed),
  };
}

// ── Markdown summary ─────────────────────────────────────────────────────────

function buildMarkdownSummary(results: PageCheckResult[], passed: boolean): string {
  const lines: string[] = [];

  lines.push('## Content Quality Checks\n');

  if (passed) {
    lines.push('All pages passed content quality checks.\n');
  } else {
    lines.push('> **Content quality issues detected.** Some pages have truncation or dangling footnotes.\n');
  }

  lines.push('| Page | Words (before → after) | Shrinkage | Orphaned Footnotes | Status |');
  lines.push('|------|------------------------|-----------|-------------------|--------|');

  for (const r of results) {
    const t = r.truncation;
    const f = r.footnotes;
    const wordsCol = t.beforeWords > 0 ? `${t.beforeWords} → ${t.afterWords}` : 'new page';
    const shrinkCol = t.dropPercent > 0 ? `-${t.dropPercent}%` : '—';
    const footnoteCol = f.orphanedRefs.length > 0 ? `${f.orphanedRefs.length} orphaned` : '—';
    const statusCol = r.passed ? 'PASS' : 'FAIL';

    lines.push(`| \`${r.pageId}\` | ${wordsCol} | ${shrinkCol} | ${footnoteCol} | ${statusCol} |`);
  }

  return lines.join('\n');
}
