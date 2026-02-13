#!/usr/bin/env node

/**
 * Broken Link Fixer
 *
 * Fixes or removes broken internal links in MDX files.
 * Converts to EntityLink components when possible, falls back to plain text.
 *
 * Usage:
 *   node crux/fix-broken-links.ts                    # Report broken links
 *   node crux/fix-broken-links.ts --dry-run          # Show what would be fixed
 *   node crux/fix-broken-links.ts --fix              # Auto-fix (prefer EntityLink)
 *   node crux/fix-broken-links.ts --fix --remove     # Remove broken links entirely
 *   node crux/fix-broken-links.ts --interactive      # Ask about each file
 *
 * Strategies:
 *   Default: Convert to <EntityLink> if entity ID exists, else plain text
 *   --to-text     Always convert [text](broken) → text
 *   --remove      Remove broken links entirely
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { findMdxFiles } from './lib/file-utils.ts';
import { getColors } from './lib/output.ts';
import { CONTENT_DIR_ABS as CONTENT_DIR, loadPathRegistry, loadEntities } from './lib/content-types.ts';
import type { PathRegistry } from './lib/content-types.ts';
import { logBulkFixes } from './lib/edit-log.ts';

// Load path registry for EntityLink conversion
const pathRegistry: PathRegistry = loadPathRegistry();
const reverseRegistry: Record<string, string> = {}; // path -> entity ID
for (const [id, path] of Object.entries(pathRegistry)) {
  const normalized = path.replace(/\/$/, '');
  reverseRegistry[normalized] = id;
  reverseRegistry[normalized + '/'] = id;
  reverseRegistry[path] = id;
}

// Load entity titles for smart label detection
const entityTitles: Record<string, string> = {};
for (const entity of loadEntities()) {
  if (entity.id && entity.title) {
    entityTitles[entity.id] = entity.title;
  }
}

interface BrokenLink {
  fullMatch: string;
  text: string;
  href: string;
  line: number;
  column: number;
}

interface LinkCategory {
  action: 'to-entity-link' | 'to-text' | 'remove' | 'update-path';
  entityId?: string;
  newPath?: string;
  reason: string;
}

interface FixResult {
  content: string;
  fixCount: number;
}

interface ScanResults {
  filesScanned: number;
  filesWithBroken: number;
  totalBroken: number;
  fixed: number;
  toEntityLink: number;
  toText: number;
  removed: number;
  byCategory: Record<string, number>;
}

interface FileToFix {
  file: string;
  content: string;
  broken: BrokenLink[];
}

/**
 * Format an ID as a readable title (matches EntityLink.tsx)
 */
function formatIdAsTitle(id: string): string {
  return id
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Check if link text matches the entity's title (or formatted ID)
 */
function textMatchesEntityTitle(text: string, entityId: string): boolean {
  const title = entityTitles[entityId] || formatIdAsTitle(entityId);
  // Case-insensitive comparison, trim whitespace
  return text.trim().toLowerCase() === title.toLowerCase();
}

const args: string[] = process.argv.slice(2);
const DRY_RUN: boolean = args.includes('--dry-run');
const FIX_MODE: boolean = args.includes('--fix');
const INTERACTIVE: boolean = args.includes('--interactive');
const REMOVE_MODE: boolean = args.includes('--remove');
const TO_TEXT_MODE: boolean = args.includes('--to-text');
const colors = getColors();

/**
 * Check if a link target exists
 */
function linkExists(href: string): boolean {
  let path = href.split('#')[0].split('?')[0];
  if (path.includes('...') || path.includes('${')) return true;
  path = path.replace(/\/$/, '');
  if (path.startsWith('/')) path = path.slice(1);

  // Check content files and path registry
  const possiblePaths: string[] = [
    join(CONTENT_DIR, path + '.mdx'),
    join(CONTENT_DIR, path + '.md'),
    join(CONTENT_DIR, path, 'index.mdx'),
    join(CONTENT_DIR, path, 'index.md'),
  ];

  if (possiblePaths.some(p => existsSync(p))) return true;

  // Also check path registry (covers dynamic routes)
  const normalizedPath = '/' + path.replace(/\/$/, '') + '/';
  return Object.values(pathRegistry).includes(normalizedPath);
}

/**
 * Extract broken links from content
 */
function findBrokenLinks(content: string, _filePath: string): BrokenLink[] {
  const broken: BrokenLink[] = [];
  const linkRegex = /\[([^\]]*)\]\(([^)]+)\)/g;

  let lineNum = 0;
  let inCodeBlock = false;
  const lines = content.split('\n');

  for (const line of lines) {
    lineNum++;

    if (line.trim().startsWith('```') || line.trim().startsWith('~~~')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) continue;

    linkRegex.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = linkRegex.exec(line)) !== null) {
      const [fullMatch, text, href] = match;

      // Skip external links, anchors, mailto, images
      if (href.startsWith('http://') ||
          href.startsWith('https://') ||
          href.startsWith('#') ||
          href.startsWith('mailto:') ||
          href.startsWith('tel:') ||
          href.match(/\.(png|jpg|jpeg|gif|svg|webp|pdf)$/i)) {
        continue;
      }

      if (!linkExists(href)) {
        broken.push({
          fullMatch,
          text,
          href,
          line: lineNum,
          column: match.index,
        });
      }
    }
  }

  return broken;
}

/**
 * Normalize a link path for matching against registry
 */
function normalizePath(href: string): string {
  let path = href.split('#')[0].split('?')[0];
  if (!path.startsWith('/')) path = '/' + path;
  path = path.replace(/\/$/, '');
  return path;
}

/**
 * Find entity ID for a given href
 */
function findEntityId(href: string): string | null {
  const normalized = normalizePath(href);

  // Direct lookup
  if (reverseRegistry[normalized]) return reverseRegistry[normalized];
  if (reverseRegistry[normalized + '/']) return reverseRegistry[normalized + '/'];

  // Try with /knowledge-base prefix if missing
  if (!normalized.startsWith('/knowledge-base')) {
    const withPrefix = '/knowledge-base' + normalized;
    if (reverseRegistry[withPrefix]) return reverseRegistry[withPrefix];
    if (reverseRegistry[withPrefix + '/']) return reverseRegistry[withPrefix + '/'];
  }

  // For /knowledge-base/ links, try matching by last segment if:
  // 1. The last segment is an entity ID
  // 2. The entity's actual path is under the same top-level section
  // This handles cases like /knowledge-base/models/X/ -> /knowledge-base/models/subdir/X/
  if (normalized.startsWith('/knowledge-base/')) {
    const lastSegment = normalized.split('/').filter(Boolean).pop();
    if (lastSegment && pathRegistry[lastSegment]) {
      const entityPath = pathRegistry[lastSegment];
      // Extract top-level section (e.g., "models", "risks", "responses")
      const linkSection = normalized.split('/')[2]; // knowledge-base/SECTION/...
      const entitySection = entityPath.split('/')[2];

      // Only match if same top-level section (prevents cross-section mismatches)
      if (linkSection === entitySection) {
        return lastSegment;
      }
    }
  }

  return null;
}

/**
 * Categorize a broken link for auto-fix decisions
 */
function categorizeLink(href: string): LinkCategory {
  // First, check if we can convert to EntityLink
  const entityId = findEntityId(href);
  if (entityId && !TO_TEXT_MODE) {
    return { action: 'to-entity-link', entityId, reason: 'Convert to EntityLink' };
  }

  // Deleted sections - these should be removed or paths updated
  if (href.includes('/research-reports/')) {
    return { action: 'remove', reason: 'Section deleted' };
  }
  if (href.includes('/safety-approaches/')) {
    // Check if the alignment version exists
    const alignmentPath = href.replace('/safety-approaches/', '/alignment/');
    const alignmentEntityId = findEntityId(alignmentPath);
    if (alignmentEntityId) {
      return { action: 'to-entity-link', entityId: alignmentEntityId, reason: 'Section moved to alignment' };
    }
    return { action: 'to-text', reason: 'Section moved (no entity found)' };
  }

  // Planned but never created models - convert to plain text
  if (href.includes('/models/')) {
    return { action: 'to-text', reason: 'Model page not created' };
  }

  // Relative links that don't resolve
  if (href.startsWith('./') || href.startsWith('../')) {
    return { action: 'to-text', reason: 'Relative link broken' };
  }

  // Default: convert to plain text
  return { action: 'to-text', reason: 'Page not found' };
}

/**
 * Check if a file already imports EntityLink
 */
function hasEntityLinkImport(content: string): boolean {
  return content.includes('EntityLink') && content.includes('import');
}

/**
 * Add EntityLink import to file content
 */
function addEntityLinkImport(content: string, _filePath: string): string {
  // Check if there's already a wiki import
  const wikiImportRegex = /import\s*{([^}]+)}\s*from\s*['"]([^'"]*components\/wiki)['"]/;
  const match = content.match(wikiImportRegex);

  if (match) {
    // Add EntityLink to existing wiki import
    const imports = match[1];
    if (!imports.includes('EntityLink')) {
      const newImports = imports.trim() + ', EntityLink';
      return content.replace(wikiImportRegex, `import {${newImports}} from '${match[2]}'`);
    }
    return content;
  }

  // Add new import after frontmatter
  const frontmatterEnd = content.indexOf('---', 4);
  if (frontmatterEnd !== -1) {
    const insertPoint = content.indexOf('\n', frontmatterEnd) + 1;
    const importStatement = `import {EntityLink} from '@components/wiki';\n`;
    return content.slice(0, insertPoint) + importStatement + content.slice(insertPoint);
  }

  return content;
}

/**
 * Fix broken links in content
 */
function fixBrokenLinks(content: string, brokenLinks: BrokenLink[], strategy: string = 'to-text', filePath: string = ''): FixResult {
  let fixed = content;
  let fixCount = 0;
  let needsEntityLinkImport = false;

  // Sort by position descending to avoid offset issues
  const sorted = [...brokenLinks].sort((a, b) => {
    const lineA = a.line;
    const lineB = b.line;
    if (lineA !== lineB) return lineB - lineA;
    return b.column - a.column;
  });

  for (const link of sorted) {
    const category = categorizeLink(link.href);
    let replacement: string;

    if (strategy === 'remove' || category.action === 'remove') {
      // Remove the link entirely
      replacement = '';
    } else if (category.action === 'to-entity-link') {
      // Convert to EntityLink component
      // Use short form if text matches entity title, otherwise use label prop
      if (textMatchesEntityTitle(link.text, category.entityId!)) {
        replacement = `<EntityLink id="${category.entityId}" />`;
      } else {
        replacement = `<EntityLink id="${category.entityId}" label="${link.text}" />`;
      }
      needsEntityLinkImport = true;
    } else if (category.action === 'update-path') {
      // Update the path
      replacement = `[${link.text}](${category.newPath})`;
    } else {
      // Convert to plain text (default)
      replacement = link.text;
    }

    fixed = fixed.replace(link.fullMatch, replacement);
    fixCount++;
  }

  // Add EntityLink import if needed
  if (needsEntityLinkImport && !hasEntityLinkImport(fixed)) {
    fixed = addEntityLinkImport(fixed, filePath);
  }

  return { content: fixed, fixCount };
}

/**
 * Ask user about a file
 */
async function askUser(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase());
    });
  });
}

async function main(): Promise<void> {
  console.log(`${colors.blue}🔗 Broken Link Fixer${colors.reset}\n`);
  console.log(`${colors.dim}Loaded ${Object.keys(pathRegistry).length} entities from pathRegistry.json${colors.reset}`);
  console.log(`${colors.dim}Loaded ${Object.keys(entityTitles).length} entity titles from database.json${colors.reset}\n`);

  const files: string[] = findMdxFiles(CONTENT_DIR);
  const results: ScanResults = {
    filesScanned: files.length,
    filesWithBroken: 0,
    totalBroken: 0,
    fixed: 0,
    toEntityLink: 0,
    toText: 0,
    removed: 0,
    byCategory: {},
  };

  const filesToFix: FileToFix[] = [];
  const fixedFiles: string[] = [];

  // First pass: find all broken links
  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    const broken = findBrokenLinks(content, file);

    if (broken.length > 0) {
      results.filesWithBroken++;
      results.totalBroken += broken.length;

      // Categorize
      for (const link of broken) {
        const cat = categorizeLink(link.href);
        results.byCategory[cat.reason] = (results.byCategory[cat.reason] || 0) + 1;
        if (cat.action === 'to-entity-link') results.toEntityLink++;
        else if (cat.action === 'remove') results.removed++;
        else results.toText++;
      }

      filesToFix.push({ file, content, broken });
    }
  }

  // Report
  console.log(`${colors.dim}Files scanned: ${results.filesScanned}${colors.reset}`);
  console.log(`${colors.yellow}Files with broken links: ${results.filesWithBroken}${colors.reset}`);
  console.log(`${colors.red}Total broken links: ${results.totalBroken}${colors.reset}\n`);

  if (results.totalBroken > 0) {
    console.log(`${colors.cyan}By fix action:${colors.reset}`);
    if (results.toEntityLink > 0) console.log(`  ${colors.green}→ EntityLink: ${results.toEntityLink}${colors.reset}`);
    if (results.toText > 0) console.log(`  → Plain text: ${results.toText}`);
    if (results.removed > 0) console.log(`  ${colors.red}→ Remove: ${results.removed}${colors.reset}`);
    console.log();
  }

  if (Object.keys(results.byCategory).length > 0) {
    console.log(`${colors.cyan}By reason:${colors.reset}`);
    for (const [reason, count] of Object.entries(results.byCategory)) {
      console.log(`  ${reason}: ${count}`);
    }
    console.log();
  }

  if (!FIX_MODE && !DRY_RUN && !INTERACTIVE) {
    // Just report
    console.log(`${colors.dim}Broken links by file:${colors.reset}\n`);
    for (const { file, broken } of filesToFix.slice(0, 20)) {
      const relFile = file.replace(CONTENT_DIR + '/', '');
      console.log(`  ${colors.yellow}${relFile}${colors.reset} (${broken.length} broken)`);
      for (const link of broken.slice(0, 3)) {
        console.log(`    Line ${link.line}: ${link.href}`);
      }
      if (broken.length > 3) {
        console.log(`    ${colors.dim}... and ${broken.length - 3} more${colors.reset}`);
      }
    }
    if (filesToFix.length > 20) {
      console.log(`\n  ${colors.dim}... and ${filesToFix.length - 20} more files${colors.reset}`);
    }

    console.log(`\n${colors.dim}Run with --dry-run to preview fixes, or --fix to apply${colors.reset}`);
    return;
  }

  // Fix mode
  const strategy: string = REMOVE_MODE ? 'remove' : 'to-text';

  for (const { file, content, broken } of filesToFix) {
    const relFile = file.replace(CONTENT_DIR + '/', '');

    if (INTERACTIVE) {
      console.log(`\n${colors.cyan}${relFile}${colors.reset} (${broken.length} broken links)`);
      for (const link of broken) {
        const cat = categorizeLink(link.href);
        console.log(`  Line ${link.line}: [${link.text}](${link.href})`);
        console.log(`  ${colors.dim}→ ${cat.action}: ${cat.reason}${colors.reset}`);
      }

      const answer = await askUser('Fix this file? [y/n/s(kip all)/q(uit)] ');
      if (answer === 'q') {
        console.log('Quitting.');
        break;
      }
      if (answer === 's') {
        console.log('Skipping remaining files.');
        break;
      }
      if (answer !== 'y') {
        continue;
      }
    }

    const { content: fixed, fixCount } = fixBrokenLinks(content, broken, strategy, file);

    if (DRY_RUN) {
      console.log(`${colors.yellow}Would fix${colors.reset} ${relFile}: ${fixCount} links`);
      // Show a sample diff
      for (const link of broken.slice(0, 3)) {
        const cat = categorizeLink(link.href);
        let replacement: string = link.text;
        if (strategy === 'remove' || cat.action === 'remove') {
          replacement = '(removed)';
        } else if (cat.action === 'to-entity-link') {
          if (textMatchesEntityTitle(link.text, cat.entityId!)) {
            replacement = `<EntityLink id="${cat.entityId}" />`;
          } else {
            replacement = `<EntityLink id="${cat.entityId}" label="${link.text}" />`;
          }
        } else if (cat.action === 'update-path') {
          replacement = `[${link.text}](${cat.newPath})`;
        }
        console.log(`  ${colors.red}- ${link.fullMatch}${colors.reset}`);
        console.log(`  ${colors.green}+ ${replacement}${colors.reset} ${colors.dim}(${cat.reason})${colors.reset}`);
      }
    } else {
      writeFileSync(file, fixed);
      fixedFiles.push(file);
      results.fixed += fixCount;
      console.log(`${colors.green}Fixed${colors.reset} ${relFile}: ${fixCount} links`);
    }
  }

  // Summary
  console.log(`\n${'─'.repeat(50)}`);
  if (DRY_RUN) {
    console.log(`${colors.yellow}Dry run complete. Run with --fix to apply changes.${colors.reset}`);
  } else if (FIX_MODE) {
    console.log(`${colors.green}Fixed ${results.fixed} broken links${colors.reset}`);
    if (fixedFiles.length > 0) {
      logBulkFixes(fixedFiles, {
        tool: 'crux-fix',
        agency: 'automated',
        note: 'Fixed broken internal links',
      });
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
