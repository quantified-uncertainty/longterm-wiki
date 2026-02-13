#!/usr/bin/env node

/**
 * Related Pages Section Remover
 *
 * Removes manual "Related Pages", "See Also", and "Related Content" sections
 * from MDX files. These are now redundant because the RelatedPages React
 * component renders automatically at the bottom of every article page
 * (see app/src/app/wiki/[id]/page.tsx).
 *
 * Also cleans up unused Backlinks imports when no <Backlinks> usage remains.
 *
 * Usage:
 *   pnpm crux fix related-pages              # Preview changes (dry run)
 *   pnpm crux fix related-pages --apply      # Apply changes
 *   pnpm crux fix related-pages --verbose    # Show section content being removed
 *   pnpm crux fix related-pages --file=path  # Fix single file only
 */

import { readFileSync, writeFileSync } from 'fs';
import { relative } from 'path';
import { findMdxFiles } from '../lib/file-utils.ts';
import { getColors, formatPath } from '../lib/output.ts';
import { CONTENT_DIR_ABS as CONTENT_DIR } from '../lib/content-types.ts';
import { logBulkFixes } from '../lib/edit-log.ts';

const args: string[] = process.argv.slice(2);
const APPLY_MODE: boolean = args.includes('--apply');
const VERBOSE: boolean = args.includes('--verbose');
const HELP: boolean = args.includes('--help');
const SINGLE_FILE: string | undefined = args.find(a => a.startsWith('--file='))?.split('=')[1];

const colors = getColors();

if (HELP) {
  console.log(`
${colors.bold}Related Pages Section Remover${colors.reset}

Removes manual "Related Pages", "See Also", and "Related Content" sections
from MDX files. These sections are now redundant — the RelatedPages component
renders automatically at the bottom of every article page.

${colors.bold}Usage:${colors.reset}
  crux fix related-pages              Preview changes (dry run)
  crux fix related-pages --apply      Apply changes to files
  crux fix related-pages --verbose    Show removed content
  crux fix related-pages --file=path  Fix single file only

${colors.bold}What it removes:${colors.reset}
  - ## Related Pages sections (with EntityLink lists or <Backlinks>)
  - ## See Also sections
  - ## Related Content sections
  - Unused Backlinks imports (when no <Backlinks> usage remains)
  - Trailing horizontal rules (---) before the removed section
`);
  process.exit(0);
}

// Section heading patterns to remove
const SECTION_HEADINGS = [
  /^## Related Pages\s*$/,
  /^## See Also\s*$/,
  /^## Related Content\s*$/,
];

interface RemovalResult {
  filePath: string;
  sectionsRemoved: string[];
  backlinkImportCleaned: boolean;
  removedContent: string[];
}

/**
 * Find and remove a trailing section that matches one of our heading patterns.
 *
 * Strategy: Find the heading, then capture everything from that heading to
 * either the next ## heading or end of file. If there's a "## Sources" or
 * similar section after it, we stop there.
 */
function removeRelatedSections(content: string): {
  newContent: string;
  sectionsRemoved: string[];
  removedContent: string[];
} {
  const lines = content.split('\n');
  const sectionsRemoved: string[] = [];
  const removedContent: string[] = [];

  // Find all section start indices (## headings)
  const sectionStarts: { index: number; heading: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    if (/^## /.test(line)) {
      sectionStarts.push({ index: i, heading: line });
    }
  }

  // Identify sections to remove (work backwards to preserve indices)
  const rangesToRemove: { start: number; end: number; heading: string }[] = [];

  for (const { index, heading } of sectionStarts) {
    const isTarget = SECTION_HEADINGS.some(pattern => pattern.test(heading.trimEnd()));
    if (!isTarget) continue;

    // Find next ## heading (or end of file)
    const nextSection = sectionStarts.find(s => s.index > index);
    let endIndex = nextSection ? nextSection.index : lines.length;

    // Trim trailing blank lines from the section
    while (endIndex > index && lines[endIndex - 1].trim() === '') {
      endIndex--;
    }

    // Check if there's a horizontal rule (---) immediately before the heading
    let startIndex = index;
    let checkIdx = index - 1;
    // Skip blank lines before heading
    while (checkIdx >= 0 && lines[checkIdx].trim() === '') {
      checkIdx--;
    }
    // If the line before blank lines is ---, include it in the removal
    if (checkIdx >= 0 && /^---\s*$/.test(lines[checkIdx])) {
      startIndex = checkIdx;
      // Also remove blank lines between --- and heading
    }

    // Also remove blank lines before the start
    while (startIndex > 0 && lines[startIndex - 1].trim() === '') {
      startIndex--;
    }

    rangesToRemove.push({ start: startIndex, end: endIndex, heading });
  }

  // Sort ranges in reverse order so we can splice without index shifts
  rangesToRemove.sort((a, b) => b.start - a.start);

  for (const { start, end, heading } of rangesToRemove) {
    const removed = lines.slice(start, end);
    removedContent.push(removed.join('\n'));
    sectionsRemoved.push(heading);
    lines.splice(start, end - start);
  }

  // Also remove standalone <Backlinks /> lines (not inside a section we already removed)
  let backlinkLinesRemoved = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*<Backlinks\s*(?:entityId="[^"]*"\s*)?\/?>/.test(lines[i])) {
      lines.splice(i, 1);
      backlinkLinesRemoved++;
    }
  }
  if (backlinkLinesRemoved > 0) {
    sectionsRemoved.push('<Backlinks /> component');
  }

  if (sectionsRemoved.length === 0) {
    return { newContent: content, sectionsRemoved: [], removedContent: [] };
  }

  // Clean up: ensure file ends with exactly one newline
  let newContent = lines.join('\n');
  newContent = newContent.replace(/\n{3,}$/g, '\n');
  if (!newContent.endsWith('\n')) {
    newContent += '\n';
  }

  return { newContent, sectionsRemoved, removedContent };
}

/**
 * Remove Backlinks from import statement if no <Backlinks usage remains.
 */
function cleanBacklinksImport(content: string): { newContent: string; cleaned: boolean } {
  // Check if there are any <Backlinks usages in the content (outside imports)
  const contentWithoutImports = content.replace(/^import\s.*$/gm, '');
  const hasBacklinksUsage = /<Backlinks[\s/>]/.test(contentWithoutImports);

  if (hasBacklinksUsage) {
    return { newContent: content, cleaned: false };
  }

  // Check if Backlinks is imported
  const importPattern = /^(import\s*\{)([^}]*)(}\s*from\s*['"]@components\/wiki['"];?\s*)$/gm;
  let cleaned = false;
  let newContent = content;

  newContent = newContent.replace(importPattern, (match, prefix, imports, suffix) => {
    const importList: string[] = imports.split(',').map((s: string) => s.trim()).filter(Boolean);
    const hasBacklinks = importList.some((imp: string) => imp === 'Backlinks');

    if (!hasBacklinks) return match;

    const filtered = importList.filter((imp: string) => imp !== 'Backlinks');
    cleaned = true;

    if (filtered.length === 0) {
      // Remove entire import line
      return '';
    }

    return `${prefix}${filtered.join(', ')}${suffix}`;
  });

  // Clean up empty lines left by removed imports
  if (cleaned) {
    newContent = newContent.replace(/\n{3,}/g, '\n\n');
  }

  return { newContent, cleaned };
}

function processFile(filePath: string): RemovalResult | null {
  const content = readFileSync(filePath, 'utf-8');

  // Step 1: Remove related sections
  const { newContent: afterSections, sectionsRemoved, removedContent } = removeRelatedSections(content);

  // Step 2: Clean up Backlinks imports if no usage remains
  const { newContent: finalContent, cleaned: backlinkImportCleaned } = cleanBacklinksImport(afterSections);

  if (sectionsRemoved.length === 0 && !backlinkImportCleaned) {
    return null;
  }

  if (APPLY_MODE) {
    writeFileSync(filePath, finalContent);
  }

  return {
    filePath,
    sectionsRemoved,
    backlinkImportCleaned,
    removedContent,
  };
}

// Main
const files = SINGLE_FILE ? [SINGLE_FILE] : findMdxFiles(CONTENT_DIR);
const results: RemovalResult[] = [];
let totalSections = 0;
let totalImportCleanups = 0;

for (const file of files) {
  const result = processFile(file);
  if (result) {
    results.push(result);
    totalSections += result.sectionsRemoved.length;
    if (result.backlinkImportCleaned) totalImportCleanups++;
  }
}

// Output
if (results.length === 0) {
  console.log(`${colors.green}No manual related pages sections found.${colors.reset}`);
  process.exit(0);
}

console.log(`\n${colors.bold}Related Pages Section Cleanup${colors.reset}\n`);

for (const result of results) {
  const relPath = formatPath(result.filePath);
  const sectionNames = result.sectionsRemoved.map(s => s.replace('## ', '')).filter(Boolean);
  const descParts: string[] = [];
  if (sectionNames.length > 0) descParts.push(`removed ${sectionNames.join(', ')}`);
  if (result.backlinkImportCleaned) descParts.push('cleaned Backlinks import');
  const desc = descParts.join(' + ');

  const icon = APPLY_MODE ? `${colors.green}✓${colors.reset}` : `${colors.yellow}~${colors.reset}`;
  const prefix = APPLY_MODE ? '' : 'would: ';
  console.log(`  ${icon} ${relPath}: ${prefix}${desc}`);

  if (VERBOSE && result.removedContent.length > 0) {
    for (const removed of result.removedContent) {
      const preview = removed.split('\n').slice(0, 5).join('\n');
      console.log(`    ${colors.dim}${preview}${colors.reset}`);
      if (removed.split('\n').length > 5) {
        console.log(`    ${colors.dim}... (${removed.split('\n').length} lines total)${colors.reset}`);
      }
    }
  }
}

console.log(`\n${colors.bold}Summary:${colors.reset}`);
console.log(`  Files affected: ${results.length}`);
console.log(`  Sections removed: ${totalSections}`);
if (totalImportCleanups > 0) {
  console.log(`  Backlinks imports cleaned: ${totalImportCleanups}`);
}

if (!APPLY_MODE) {
  console.log(`\n${colors.yellow}Dry run — no files modified. Use --apply to apply changes.${colors.reset}`);
} else if (results.length > 0) {
  logBulkFixes(
    results.map(r => r.filePath),
    {
      tool: 'crux-fix',
      agency: 'automated',
      note: 'Removed redundant related-pages section',
    },
  );
}
