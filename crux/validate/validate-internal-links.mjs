#!/usr/bin/env node

/**
 * Internal Link Validator
 *
 * Scans MDX/MD files for internal links and verifies they resolve to existing content.
 * Checks:
 * - Markdown links: [text](/knowledge-base/path/)
 * - Ensures trailing slashes are present
 * - Verifies target files exist
 *
 * Usage:
 *   node scripts/validate-internal-links.mjs [options]
 *
 * Options:
 *   --ci      Output JSON for CI pipelines
 *   --output  Write JSON output to file (requires --ci)
 *   --fix     Auto-fix missing trailing slashes (not implemented yet)
 *
 * Exit codes:
 *   0 = All links valid
 *   1 = Broken links found
 */

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join, dirname, basename } from 'path';
import { findMdxFiles } from '../lib/file-utils.ts';
import { getColors, formatPath } from '../lib/output.ts';
import { CONTENT_DIR } from '../lib/content-types.js';

const args = process.argv.slice(2);
const CI_MODE = args.includes('--ci');
const OUTPUT_FILE = args.find(arg => arg.startsWith('--output='))?.split('=')[1];
const colors = getColors(CI_MODE);

/**
 * Extract all internal links from file content
 */
function extractInternalLinks(content, filePath) {
  const links = [];

  // Match markdown links: [text](path)
  const linkRegex = /\[([^\]]*)\]\(([^)]+)\)/g;
  let match;

  let lineNum = 0;
  let inCodeBlock = false;
  const lines = content.split('\n');

  for (const line of lines) {
    lineNum++;

    // Track code block state (``` or ~~~)
    if (line.trim().startsWith('```') || line.trim().startsWith('~~~')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    // Skip links inside code blocks
    if (inCodeBlock) {
      continue;
    }

    linkRegex.lastIndex = 0;

    while ((match = linkRegex.exec(line)) !== null) {
      const [fullMatch, text, href] = match;

      // Skip external links, anchors, and mailto/tel
      if (href.startsWith('http://') ||
          href.startsWith('https://') ||
          href.startsWith('#') ||
          href.startsWith('mailto:') ||
          href.startsWith('tel:')) {
        continue;
      }

      // Internal link
      links.push({
        href,
        text,
        line: lineNum,
        file: filePath,
      });
    }
  }

  return links;
}

// Next.js app directory for standalone pages
const APP_DIR = join(process.cwd(), 'app/src/app');

/**
 * Check if an internal link resolves to an existing file
 * @param {string} href - The link href
 * @param {string} sourceFile - The file containing the link (for resolving relative paths)
 */
function resolveLink(href, sourceFile) {
  // Remove anchor (e.g., #section-name) - we only check file existence
  let path = href.split('#')[0];

  // Remove query string (e.g., ?level=interactive)
  path = path.split('?')[0];

  // Skip placeholder links (contain ...)
  if (path.includes('...')) {
    return { exists: true, isPlaceholder: true };
  }

  // Remove trailing slash for file lookup
  path = path.replace(/\/$/, '');

  // Handle relative paths (./something or ../something)
  if (path.startsWith('./') || path.startsWith('../')) {
    // Get directory of source file
    const sourceDir = dirname(sourceFile);
    // Resolve the relative path
    path = join(sourceDir, path);
    // Convert back to relative path from CONTENT_DIR
    path = path.replace(CONTENT_DIR + '/', '').replace(CONTENT_DIR, '');
  } else {
    // Remove leading slash
    if (path.startsWith('/')) {
      path = path.slice(1);
    }
  }

  // Check various possible file locations
  const possiblePaths = [
    // Content files (MDX/MD in content/docs)
    join(CONTENT_DIR, path + '.mdx'),
    join(CONTENT_DIR, path + '.md'),
    join(CONTENT_DIR, path, 'index.mdx'),
    join(CONTENT_DIR, path, 'index.md'),
    // Next.js app routes (app/src/app)
    join(APP_DIR, path, 'page.tsx'),
    join(APP_DIR, path, 'page.jsx'),
  ];

  for (const p of possiblePaths) {
    if (existsSync(p)) {
      return { exists: true, resolvedPath: p };
    }
  }

  return { exists: false, tried: possiblePaths };
}

/**
 * Check if link follows conventions (trailing slash)
 */
function checkConventions(href) {
  const issues = [];

  // Should have trailing slash for directory-style URLs
  // Skip URLs with query strings (trailing slash comes before ?)
  if (!href.endsWith('/') && !href.includes('#') && !href.includes('.') && !href.includes('?')) {
    issues.push('missing-trailing-slash');
  }

  // Should not have file extension in URL
  if (href.endsWith('.mdx') || href.endsWith('.md')) {
    issues.push('has-file-extension');
  }

  return issues;
}

function main() {
  const results = {
    totalFiles: 0,
    totalLinks: 0,
    brokenLinks: [],
    conventionIssues: [],
    valid: 0,
  };

  if (!CI_MODE) {
    console.log(`${colors.blue}🔗 Validating internal links...${colors.reset}\n`);
  }

  // Find all content files
  const files = findMdxFiles(CONTENT_DIR);
  results.totalFiles = files.length;

  if (!CI_MODE) {
    console.log(`${colors.dim}Scanning ${files.length} content files...${colors.reset}\n`);
  }

  // Check each file
  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    const links = extractInternalLinks(content, file);

    for (const link of links) {
      results.totalLinks++;

      // Check if link resolves
      const resolution = resolveLink(link.href, link.file);

      if (!resolution.exists) {
        // Skip template variables (JSX expressions like ${e.id})
        if (link.href.includes('${')) {
          results.valid++;
          continue;
        }

        // Skip image links (we don't validate images here)
        if (link.href.match(/\.(png|jpg|jpeg|gif|svg|webp)$/i)) {
          continue;
        }

        // Treat model-to-model broken links as warnings (future work)
        const isModelFile = link.file.includes('/models/');
        const isModelLink = link.href.includes('/models/');

        if (isModelFile && isModelLink) {
          // Add to convention issues (warnings) instead of broken links
          results.conventionIssues.push({
            file: link.file,
            line: link.line,
            href: link.href,
            issues: ['model-not-yet-created'],
          });
        } else {
          results.brokenLinks.push({
            file: link.file,
            line: link.line,
            href: link.href,
            text: link.text,
          });
        }
      } else {
        results.valid++;
      }

      // Check conventions
      const conventionIssues = checkConventions(link.href);
      if (conventionIssues.length > 0) {
        results.conventionIssues.push({
          file: link.file,
          line: link.line,
          href: link.href,
          issues: conventionIssues,
        });
      }
    }
  }

  // Output results
  if (CI_MODE) {
    const jsonOutput = JSON.stringify(results, null, 2);

    if (OUTPUT_FILE) {
      writeFileSync(OUTPUT_FILE, jsonOutput, 'utf-8');
      console.error(`✓ Link health written to ${OUTPUT_FILE}`);
    } else {
      console.log(jsonOutput);
    }
  } else {
    // Print broken links
    if (results.brokenLinks.length > 0) {
      console.log(`${colors.red}❌ Broken links found:${colors.reset}\n`);
      for (const link of results.brokenLinks) {
        const relFile = link.file.replace(CONTENT_DIR + '/', '');
        console.log(`  ${colors.yellow}${relFile}:${link.line}${colors.reset}`);
        console.log(`    → ${link.href}`);
        console.log(`    ${colors.dim}text: "${link.text}"${colors.reset}\n`);
      }
    }

    // Print convention issues (as warnings)
    if (results.conventionIssues.length > 0) {
      console.log(`${colors.yellow}⚠️  Convention issues:${colors.reset}\n`);
      for (const issue of results.conventionIssues.slice(0, 10)) {
        const relFile = issue.file.replace(CONTENT_DIR + '/', '');
        console.log(`  ${relFile}:${issue.line}`);
        console.log(`    → ${issue.href} (${issue.issues.join(', ')})`);
      }
      if (results.conventionIssues.length > 10) {
        console.log(`  ${colors.dim}... and ${results.conventionIssues.length - 10} more${colors.reset}`);
      }
      console.log();
    }

    // Summary
    console.log(`${'─'.repeat(50)}`);
    console.log(`Files scanned:    ${results.totalFiles}`);
    console.log(`Links checked:    ${results.totalLinks}`);
    console.log(`${colors.green}Valid:            ${results.valid}${colors.reset}`);
    if (results.brokenLinks.length > 0) {
      console.log(`${colors.red}Broken:           ${results.brokenLinks.length}${colors.reset}`);
    }
    if (results.conventionIssues.length > 0) {
      console.log(`${colors.yellow}Convention issues: ${results.conventionIssues.length}${colors.reset}`);
    }
  }

  // Exit with error if broken links found
  process.exit(results.brokenLinks.length > 0 ? 1 : 0);
}

main();
