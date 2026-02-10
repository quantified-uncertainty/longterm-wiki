#!/usr/bin/env node

/**
 * EntityLink Validator & Converter
 *
 * Scans MDX files for markdown links that could be converted to EntityLink components.
 * EntityLink uses entity IDs instead of paths, making links resilient to page moves.
 *
 * Usage:
 *   node scripts/validate/validate-entity-links.mjs           # Report convertible links
 *   node scripts/validate/validate-entity-links.mjs --fix     # Auto-convert links
 *   node scripts/validate/validate-entity-links.mjs --ci      # JSON output for CI
 *   node scripts/validate/validate-entity-links.mjs --broken  # Only show broken links
 *   node scripts/validate/validate-entity-links.mjs --strict  # Fail on convertible links too
 *
 * Exit codes:
 *   0 = No broken links (convertible links are warnings unless --strict)
 *   1 = Broken links found, or convertible links with --strict
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { findMdxFiles } from '../lib/file-utils.mjs';
import { getColors } from '../lib/output.mjs';
import { CONTENT_DIR, loadPathRegistry } from '../lib/content-types.js';

const args = process.argv.slice(2);
const CI_MODE = args.includes('--ci');
const FIX_MODE = args.includes('--fix');
const BROKEN_ONLY = args.includes('--broken');
const STRICT_MODE = args.includes('--strict');
const colors = getColors(CI_MODE);

// Load path registry (entity ID -> path mapping)
let pathRegistry = loadPathRegistry();
let reverseRegistry = {}; // path -> entity ID

// Build reverse mapping (path -> entity ID)
for (const [id, path] of Object.entries(pathRegistry)) {
  // Normalize path (ensure trailing slash)
  const normalizedPath = path.endsWith('/') ? path : path + '/';
  reverseRegistry[normalizedPath] = id;
  // Also store without trailing slash
  reverseRegistry[path.replace(/\/$/, '')] = id;
}

// Next.js app directory for standalone pages
const APP_DIR = join(process.cwd(), 'app/src/app');

/**
 * Extract all markdown links from file content
 */
function extractLinks(content, filePath) {
  const links = [];
  const linkRegex = /\[([^\]]*)\]\(([^)]+)\)/g;

  let lineNum = 0;
  let inCodeBlock = false;
  const lines = content.split('\n');

  for (const line of lines) {
    lineNum++;

    // Track code block state
    if (line.trim().startsWith('```') || line.trim().startsWith('~~~')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) continue;

    linkRegex.lastIndex = 0;
    let match;

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

      links.push({
        href,
        text,
        line: lineNum,
        column: match.index,
        fullMatch,
        file: filePath,
      });
    }
  }

  return links;
}

/**
 * Normalize a link path for matching against registry
 */
function normalizePath(href) {
  // Remove anchor and query string
  let path = href.split('#')[0].split('?')[0];

  // Ensure leading slash
  if (!path.startsWith('/')) {
    path = '/' + path;
  }

  // Ensure trailing slash
  if (!path.endsWith('/')) {
    path = path + '/';
  }

  return path;
}

/**
 * Check if a link target exists (file or page)
 */
function linkExists(href) {
  let path = href.split('#')[0].split('?')[0];

  // Skip placeholder links
  if (path.includes('...')) return true;

  // Remove trailing slash for file lookup
  path = path.replace(/\/$/, '');

  // Handle leading slash
  if (path.startsWith('/')) {
    path = path.slice(1);
  }

  const possiblePaths = [
    join(CONTENT_DIR, path + '.mdx'),
    join(CONTENT_DIR, path + '.md'),
    join(CONTENT_DIR, path, 'index.mdx'),
    join(CONTENT_DIR, path, 'index.md'),
    join(APP_DIR, path, 'page.tsx'),
    join(APP_DIR, path, 'page.jsx'),
  ];

  return possiblePaths.some(p => existsSync(p));
}

/**
 * Check if a file already imports EntityLink
 */
function hasEntityLinkImport(content) {
  return content.includes('EntityLink') && content.includes('import');
}

/**
 * Add EntityLink import to file content
 */
function addEntityLinkImport(content) {
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
    const importPath = "import {EntityLink} from '@components/wiki';\n";
    return content.slice(0, insertPoint) + importPath + content.slice(insertPoint);
  }

  return content;
}

/**
 * Convert a markdown link to EntityLink
 */
function convertToEntityLink(fullMatch, text, entityId) {
  // If text matches the entity title (common case), use simple form
  // Otherwise, use label prop
  return `<EntityLink id="${entityId}">${text}</EntityLink>`;
}

function main() {
  const results = {
    totalFiles: 0,
    totalLinks: 0,
    convertible: [],
    broken: [],
    alreadyEntityLink: 0,
    notInRegistry: 0,
  };

  if (!CI_MODE) {
    console.log(`${colors.blue}🔗 Auditing links for EntityLink conversion...${colors.reset}\n`);
    console.log(`${colors.dim}Loaded ${Object.keys(pathRegistry).length} entities from pathRegistry.json${colors.reset}\n`);
  }

  const files = findMdxFiles(CONTENT_DIR);
  results.totalFiles = files.length;

  const filesToFix = new Map(); // file -> array of fixes

  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    const links = extractLinks(content, file);

    for (const link of links) {
      results.totalLinks++;

      const normalizedPath = normalizePath(link.href);
      const entityId = reverseRegistry[normalizedPath] || reverseRegistry[normalizedPath.replace(/\/$/, '')];

      // Check if link is broken
      if (!linkExists(link.href)) {
        // Skip template variables
        if (link.href.includes('${')) continue;

        results.broken.push({
          file: link.file,
          line: link.line,
          href: link.href,
          text: link.text,
        });
        continue;
      }

      // Check if convertible to EntityLink
      if (entityId) {
        results.convertible.push({
          file: link.file,
          line: link.line,
          href: link.href,
          text: link.text,
          entityId,
          fullMatch: link.fullMatch,
        });

        if (FIX_MODE) {
          if (!filesToFix.has(file)) {
            filesToFix.set(file, []);
          }
          filesToFix.get(file).push({
            fullMatch: link.fullMatch,
            text: link.text,
            entityId,
          });
        }
      } else {
        results.notInRegistry++;
      }
    }
  }

  // Apply fixes if in fix mode
  if (FIX_MODE && filesToFix.size > 0) {
    let fixedFiles = 0;
    let fixedLinks = 0;

    for (const [file, fixes] of filesToFix) {
      let content = readFileSync(file, 'utf-8');
      let modified = false;

      // Add import if needed
      if (!hasEntityLinkImport(content)) {
        content = addEntityLinkImport(content);
        modified = true;
      }

      // Apply link conversions (in reverse order to preserve positions)
      for (const fix of fixes.reverse()) {
        const newLink = convertToEntityLink(fix.fullMatch, fix.text, fix.entityId);
        content = content.replace(fix.fullMatch, newLink);
        fixedLinks++;
        modified = true;
      }

      if (modified) {
        writeFileSync(file, content);
        fixedFiles++;
      }
    }

    if (!CI_MODE) {
      console.log(`${colors.green}✅ Fixed ${fixedLinks} links in ${fixedFiles} files${colors.reset}\n`);
    }
  }

  // Output results
  if (CI_MODE) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    // Print broken links
    if (results.broken.length > 0) {
      console.log(`${colors.red}❌ Broken links (${results.broken.length}):${colors.reset}\n`);
      for (const link of results.broken.slice(0, 20)) {
        const relFile = link.file.replace(CONTENT_DIR + '/', '');
        console.log(`  ${colors.yellow}${relFile}:${link.line}${colors.reset}`);
        console.log(`    → ${link.href}`);
      }
      if (results.broken.length > 20) {
        console.log(`  ${colors.dim}... and ${results.broken.length - 20} more${colors.reset}`);
      }
      console.log();
    }

    // Print convertible links (unless --broken flag)
    if (!BROKEN_ONLY && results.convertible.length > 0 && !FIX_MODE) {
      console.log(`${colors.yellow}⚠️  Convertible to EntityLink (${results.convertible.length}):${colors.reset}\n`);

      // Group by file for cleaner output
      const byFile = new Map();
      for (const link of results.convertible) {
        const relFile = link.file.replace(CONTENT_DIR + '/', '');
        if (!byFile.has(relFile)) {
          byFile.set(relFile, []);
        }
        byFile.get(relFile).push(link);
      }

      let shown = 0;
      for (const [file, links] of byFile) {
        if (shown >= 10) break;
        console.log(`  ${colors.cyan}${file}${colors.reset}`);
        for (const link of links.slice(0, 3)) {
          console.log(`    Line ${link.line}: [${link.text}](${link.href})`);
          console.log(`           → <EntityLink id="${link.entityId}">${link.text}</EntityLink>`);
        }
        if (links.length > 3) {
          console.log(`    ${colors.dim}... and ${links.length - 3} more in this file${colors.reset}`);
        }
        shown++;
      }
      if (byFile.size > 10) {
        console.log(`  ${colors.dim}... and ${byFile.size - 10} more files${colors.reset}`);
      }
      console.log();
      console.log(`${colors.dim}Run with --fix to auto-convert these links${colors.reset}\n`);
    }

    // Summary
    console.log(`${'─'.repeat(50)}`);
    console.log(`Files scanned:       ${results.totalFiles}`);
    console.log(`Links checked:       ${results.totalLinks}`);
    console.log(`Entities in registry: ${Object.keys(pathRegistry).length}`);
    console.log();
    if (results.broken.length > 0) {
      console.log(`${colors.red}Broken links:        ${results.broken.length}${colors.reset}`);
    }
    if (results.convertible.length > 0) {
      console.log(`${colors.yellow}Convertible:         ${results.convertible.length}${colors.reset}`);
    }
    console.log(`${colors.dim}Not in registry:     ${results.notInRegistry}${colors.reset}`);
  }

  // Exit with error if broken links found (always) or convertible links (with --strict)
  if (results.broken.length > 0) {
    process.exit(1);
  }
  if (!FIX_MODE && results.convertible.length > 0 && STRICT_MODE) {
    process.exit(1);
  }
  process.exit(0);
}

main();
