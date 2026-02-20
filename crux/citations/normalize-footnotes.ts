/**
 * Normalize Footnote Formats
 *
 * Scans all MDX pages and normalizes footnote definitions to the preferred
 * format: [^N]: [Title](URL) - optional description
 *
 * Handles:
 *   - "text https://url" → "[text](url)"
 *   - "Author (Year). \"Title.\" https://url" → "[Title](url) - Author (Year)."
 *   - bare "https://url" (no title) → left as-is (needs manual title)
 *
 * Usage:
 *   pnpm crux citations normalize-footnotes              Report only
 *   pnpm crux citations normalize-footnotes --fix        Apply fixes
 *   pnpm crux citations normalize-footnotes --fix <id>   Fix one page
 */

import { readFileSync, writeFileSync } from 'fs';
import { basename } from 'path';
import { CONTENT_DIR_ABS } from '../lib/content-types.ts';
import { findMdxFiles } from '../lib/file-utils.ts';
import { getColors } from '../lib/output.ts';
import { parseCliArgs } from '../lib/cli.ts';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FootnoteFormat = 'markdown-link' | 'text-then-url' | 'bare-url' | 'no-url';

interface FootnoteInfo {
  lineNumber: number;
  footnoteNum: number;
  format: FootnoteFormat;
  originalLine: string;
  normalizedLine: string | null; // null if already normalized or can't be fixed
  url: string | null;
  linkText: string | null;
}

interface PageReport {
  pageId: string;
  filePath: string;
  footnotes: FootnoteInfo[];
  fixable: number;
  alreadyNormalized: number;
  noUrl: number;
}

// ---------------------------------------------------------------------------
// Classification + normalization
// ---------------------------------------------------------------------------

/** Classify and optionally normalize a footnote definition line. */
export function classifyFootnote(line: string): FootnoteInfo | null {
  const baseMatch = line.match(/^\[\^(\d+)\]:\s*(.*)/);
  if (!baseMatch) return null;

  const footnoteNum = parseInt(baseMatch[1], 10);
  const content = baseMatch[2].trim();
  const lineNumber = 0; // Filled in by caller

  // Pattern 1: Already has [Title](URL) — already normalized
  if (/^\[([^\]]*)\]\((https?:\/\/[^)]+)\)/.test(content) ||
      /\[([^\]]*)\]\((https?:\/\/[^)]+)\)/.test(content)) {
    return {
      lineNumber,
      footnoteNum,
      format: 'markdown-link',
      originalLine: line,
      normalizedLine: null,
      url: content.match(/\((https?:\/\/[^)]+)\)/)?.[1] ?? null,
      linkText: content.match(/\[([^\]]*)\]/)?.[1] ?? null,
    };
  }

  // Pattern 2: Text followed by bare URL at end
  const textUrlMatch = content.match(/^(.+?)\s+(https?:\/\/\S+)\s*$/);
  if (textUrlMatch) {
    const text = textUrlMatch[1].replace(/[,:.]+\s*$/, '').trim();
    const url = textUrlMatch[2];
    const title = extractBestTitle(text);
    const normalized = `[^${footnoteNum}]: [${title}](${url})`;

    return {
      lineNumber,
      footnoteNum,
      format: 'text-then-url',
      originalLine: line,
      normalizedLine: normalized,
      url,
      linkText: title,
    };
  }

  // Pattern 3: Bare URL only
  const bareUrlMatch = content.match(/^(https?:\/\/\S+)\s*$/);
  if (bareUrlMatch) {
    return {
      lineNumber,
      footnoteNum,
      format: 'bare-url',
      originalLine: line,
      normalizedLine: null, // Can't normalize without a title
      url: bareUrlMatch[1],
      linkText: null,
    };
  }

  // Pattern 4: No URL at all
  return {
    lineNumber,
    footnoteNum,
    format: 'no-url',
    originalLine: line,
    normalizedLine: null,
    url: null,
    linkText: content || null,
  };
}

/**
 * Extract the best title from descriptive text before a URL.
 *
 * Handles:
 *   - "TransformerLens GitHub repository" → "TransformerLens GitHub repository"
 *   - 'Author (Year). "Title." Journal' → "Title"
 *   - "FLI, \"2025 AI Safety Index,\" Summer 2025" → "2025 AI Safety Index"
 */
export function extractBestTitle(text: string): string {
  // Try to extract a quoted title (regular or unicode quotes)
  const quotedMatch = text.match(/"([^"]+)"/) || text.match(/\u201c([^\u201d]+)\u201d/);
  if (quotedMatch) {
    const title = quotedMatch[1].replace(/[.,]+$/, '').trim();
    const before = text.slice(0, text.indexOf(quotedMatch[0])).replace(/[,\s]+$/, '').trim();
    const afterStart = text.indexOf(quotedMatch[0]) + quotedMatch[0].length;
    const after = text.slice(afterStart).replace(/^[,.\s]+/, '').replace(/[,.\s]+$/, '').trim();

    // Build "Title (Author, Source)" style
    const cleanParts = [before, after]
      .filter(s => s && s.length > 3)
      .map(s => s.replace(/[.,]+$/, '').trim());
    const context = cleanParts.join(', ');
    return context ? `${title} (${context})` : title;
  }

  // No quoted title — use the whole text, cleaning up trailing punctuation
  return text.replace(/[,.:;\s]+$/, '').trim();
}

// ---------------------------------------------------------------------------
// Page analysis
// ---------------------------------------------------------------------------

function analyzePageFootnotes(filePath: string): PageReport {
  const pageId = basename(filePath, '.mdx');
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  const footnotes: FootnoteInfo[] = [];
  let fixable = 0;
  let alreadyNormalized = 0;
  let noUrl = 0;

  for (let i = 0; i < lines.length; i++) {
    const info = classifyFootnote(lines[i]);
    if (!info) continue;

    info.lineNumber = i + 1; // 1-indexed

    switch (info.format) {
      case 'markdown-link':
        alreadyNormalized++;
        break;
      case 'text-then-url':
        fixable++;
        break;
      case 'bare-url':
        // Could be fixable if we fetch the page title, but skip for now
        break;
      case 'no-url':
        noUrl++;
        break;
    }

    footnotes.push(info);
  }

  return { pageId, filePath, footnotes, fixable, alreadyNormalized, noUrl };
}

function applyFootnoteFixes(filePath: string, footnotes: FootnoteInfo[]): number {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  let fixCount = 0;

  for (const fn of footnotes) {
    if (!fn.normalizedLine) continue;
    const lineIdx = fn.lineNumber - 1;
    if (lines[lineIdx] === fn.originalLine) {
      lines[lineIdx] = fn.normalizedLine;
      fixCount++;
    }
  }

  if (fixCount > 0) {
    writeFileSync(filePath, lines.join('\n'), 'utf-8');
  }

  return fixCount;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const fix = args.fix === true;
  const json = args.json === true;
  const colors = getColors(json);
  const c = colors;

  const positional = (args._positional as string[]) || [];
  const targetPageId = positional[0];

  const allFiles = findMdxFiles(CONTENT_DIR_ABS);
  let files = allFiles;

  if (targetPageId) {
    files = allFiles.filter(f => basename(f, '.mdx') === targetPageId);
    if (files.length === 0) {
      console.error(`${c.red}Error: page "${targetPageId}" not found${c.reset}`);
      process.exit(1);
    }
  }

  const reports: PageReport[] = [];
  let totalFootnotes = 0;
  let totalFixable = 0;
  let totalNormalized = 0;
  let totalNoUrl = 0;
  let totalFixed = 0;

  for (const f of files) {
    const report = analyzePageFootnotes(f);
    if (report.footnotes.length === 0) continue;

    reports.push(report);
    totalFootnotes += report.footnotes.length;
    totalFixable += report.fixable;
    totalNormalized += report.alreadyNormalized;
    totalNoUrl += report.noUrl;

    if (fix && report.fixable > 0) {
      const fixed = applyFootnoteFixes(f, report.footnotes);
      totalFixed += fixed;
    }
  }

  if (json) {
    const summary = {
      totalPages: reports.length,
      totalFootnotes,
      alreadyNormalized: totalNormalized,
      fixable: totalFixable,
      noUrl: totalNoUrl,
      fixed: fix ? totalFixed : undefined,
      pages: reports
        .filter(r => r.fixable > 0 || r.noUrl > 0)
        .map(r => ({
          pageId: r.pageId,
          fixable: r.fixable,
          noUrl: r.noUrl,
          footnotes: r.footnotes
            .filter(fn => fn.format !== 'markdown-link')
            .map(fn => ({
              footnote: fn.footnoteNum,
              format: fn.format,
              original: fn.originalLine.slice(0, 120),
              normalized: fn.normalizedLine?.slice(0, 120) ?? null,
            })),
        })),
    };
    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
  }

  console.log(`\n${c.bold}${c.blue}Footnote Format Report${c.reset}\n`);
  console.log(`  Pages with footnotes:  ${reports.length}`);
  console.log(`  Total footnotes:       ${totalFootnotes}`);
  console.log(`  ${c.green}Already normalized:${c.reset}    ${totalNormalized} (${pct(totalNormalized, totalFootnotes)}%)`);
  console.log(`  ${c.yellow}Auto-fixable:${c.reset}          ${totalFixable} (${pct(totalFixable, totalFootnotes)}%)`);
  console.log(`  ${c.dim}No URL (manual only):${c.reset}   ${totalNoUrl} (${pct(totalNoUrl, totalFootnotes)}%)`);

  if (fix) {
    console.log(`\n  ${c.green}Fixed:${c.reset} ${totalFixed} footnotes`);
  }

  // Show pages with fixable footnotes
  const fixablePages = reports.filter(r => r.fixable > 0);
  if (fixablePages.length > 0 && !fix) {
    console.log(`\n${c.bold}Pages with auto-fixable footnotes:${c.reset}`);
    for (const report of fixablePages.sort((a, b) => b.fixable - a.fixable)) {
      console.log(`\n  ${c.bold}${report.pageId}${c.reset} (${report.fixable} fixable)`);
      for (const fn of report.footnotes) {
        if (fn.format !== 'text-then-url') continue;
        console.log(`    ${c.dim}[^${fn.footnoteNum}]${c.reset} ${fn.originalLine.slice(0, 100)}`);
        if (fn.normalizedLine) {
          console.log(`    ${c.green}→${c.reset} ${fn.normalizedLine.slice(0, 100)}`);
        }
      }
    }
    console.log(`\n  Run with ${c.bold}--fix${c.reset} to apply changes.\n`);
  }

  // Show pages with no-URL footnotes (for reference)
  const noUrlPages = reports.filter(r => r.noUrl > 0);
  if (noUrlPages.length > 0 && !fix) {
    console.log(`\n${c.bold}Pages with URL-less footnotes (manual review needed):${c.reset}`);
    for (const report of noUrlPages.sort((a, b) => b.noUrl - a.noUrl).slice(0, 10)) {
      console.log(`  ${report.pageId}: ${report.noUrl} footnotes without URLs`);
    }
    if (noUrlPages.length > 10) {
      console.log(`  ... and ${noUrlPages.length - 10} more pages`);
    }
  }

  console.log('');
}

function pct(n: number, total: number): string {
  if (total === 0) return '0';
  return Math.round((n / total) * 100).toString();
}

// Only run when executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
